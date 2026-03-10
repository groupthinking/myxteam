/**
 * X (Twitter) Channel Plugin for OpenClaw
 *
 * Implements the ChannelPlugin interface to integrate X as a conversational
 * channel. Agents are activated by @mentions and reply directly on X.
 *
 * Architecture:
 * - Single-app, multi-account: one Bearer Token for the Filtered Stream,
 *   individual OAuth tokens per agent for posting.
 * - Real-time mention detection via the Filtered Stream API.
 * - Outbound replies via POST /2/tweets with reply context.
 * - Optional smart-reply pipeline: when `useSmartReply` is enabled, incoming
 *   mentions are classified by intent/sentiment before being routed.
 */

import type { ChannelLogSink, ChannelPlugin, OpenClawConfig } from "openclaw/plugin-sdk";
import { createReplyPrefixOptions } from "openclaw/plugin-sdk";
import { XChannelConfigSchema } from "./config-schema.js";
import {
  initCreditBudget,
  clearCreditBudget,
  checkCreditBudget,
  getCreditUsageSnapshot,
} from "./credit-budget.js";
import { ChannelEventBus } from "./event-bus.js";
import { initRateLimiter, resetRateLimiters } from "./rate-limiter.js";
import { getXRuntime } from "./runtime.js";
import { SmartReplyPipeline } from "./smart-reply.js";
import {
  startFilteredStream,
  stopFilteredStream,
  getStreamStatus,
  type StreamPost,
} from "./stream-handler.js";
import { stripLeadingContextJsonBlock } from "./strip-context-json.js";
import {
  resolveReplyToIdForChunk,
  recordPostedChunk,
  clearAllThreadState,
} from "./thread-state.js";
import {
  initTokens,
  clearTokens,
  clearAllTokens,
  type TokenRefreshConfig,
} from "./token-refresh.js";
import {
  listXAccountIds,
  resolveDefaultXAccountId,
  resolveXAccount,
  resolveAppBearerToken,
  getAllAgentUsernames,
  findAccountByUsername,
  resolveSmartReplyConfig,
  resolveCreditBudget,
  type ResolvedXAccount,
} from "./types.js";
import { XApiClient } from "./x-api-client.js";

// ─── Module State ────────────────────────────────────────────────────────────

/** Track whether the shared stream is running. */
let streamRunning = false;

/** Track active account IDs so we know when to stop the shared stream. */
const activeAccountIds = new Set<string>();

/** Shared event bus for internal routing (created once, lives for the process). */
let eventBus: ChannelEventBus | null = null;

/** Shared smart-reply pipeline instance (null when feature is disabled). */
let smartReplyPipeline: SmartReplyPipeline | null = null;

// ─── Plugin Definition ───────────────────────────────────────────────────────

export const xPlugin: ChannelPlugin<ResolvedXAccount> = {
  id: "x",

  meta: {
    id: "x",
    label: "X (Twitter)",
    selectionLabel: "X (Twitter)",
    docsPath: "/channels/x",
    docsLabel: "x",
    blurb: "AI agents on X, activated by @mentions. Multi-account via OAuth 2.0.",
    order: 56,
  },

  capabilities: {
    chatTypes: ["thread"],
    reply: true,
    edit: false, // X API v2 does not expose a post-editing endpoint
    media: false,
  },

  reload: { configPrefixes: ["channels.x"] },

  configSchema: {
    schema: XChannelConfigSchema as unknown as Record<string, unknown>,
  },

  // ─── Config Adapter ──────────────────────────────────────────────────────

  config: {
    listAccountIds: (cfg) => listXAccountIds(cfg),

    resolveAccount: (cfg, accountId) => resolveXAccount({ cfg, accountId }),

    defaultAccountId: (cfg) => resolveDefaultXAccountId(cfg),

    isConfigured: (account) => account.configured,

    isEnabled: (account) => account.enabled,

    describeAccount: (account) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: account.configured,
    }),

    resolveAllowFrom: () => undefined,
  },

  // ─── Security Adapter ────────────────────────────────────────────────────

  security: {
    resolveDmPolicy: () => ({
      policy: "open" as const,
      allowFrom: [],
      policyPath: "channels.x.dmPolicy",
      allowFromPath: "channels.x.allowFrom",
      approveHint: "Approve via the OpenClaw control panel.",
    }),
  },

  // ─── Gateway Adapter (Real-time Stream Connection) ───────────────────────

  gateway: {
    /**
     * Start the X channel for a given account.
     *
     * The Filtered Stream is shared across all accounts (it uses the app-level
     * Bearer Token). The first account to start will initiate the stream.
     * Subsequent accounts register themselves as active without starting
     * a second stream.
     */
    startAccount: async (ctx) => {
      const { account, cfg, log, setStatus, abortSignal } = ctx;

      if (!account.configured || !account.enabled) {
        log?.info?.(`[${account.accountId}] Skipping — not configured or not enabled.`);
        return;
      }

      log?.info?.(`[${account.accountId}] Starting X channel for @${account.agentUsername}...`);
      activeAccountIds.add(account.accountId);

      // Initialize rate limiter and credit budget on first account start
      if (activeAccountIds.size === 1) {
        initRateLimiter({
          appPostsPerWindow: 300,
          userPostsPerWindow: 200,
          windowMs: 15 * 60 * 1000,
        });
        log?.info?.("Rate limiter initialized.");

        // Initialize credit budget monitoring if a budget is configured
        const creditBudget = resolveCreditBudget(cfg);
        const bearerToken = resolveAppBearerToken(cfg);
        if (creditBudget && creditBudget > 0 && bearerToken) {
          // Read the user-configured check interval from config (default: 60 min)
          const xCfg = (cfg.channels as Record<string, unknown> | undefined)?.x as
            | Record<string, unknown>
            | undefined;
          const rawIntervalMinutes = xCfg?.usageCheckIntervalMinutes as number | undefined;
          // Clamp to a minimum of 1 minute to prevent setInterval spinning at 0 ms
          // if the user supplies 0, a negative value, or NaN.
          const usageCheckIntervalMinutes = Math.max(
            1,
            Number.isFinite(rawIntervalMinutes as number) ? (rawIntervalMinutes as number) : 60,
          );
          await initCreditBudget({
            budget: creditBudget,
            bearerToken,
            log,
            refreshIntervalMs: usageCheckIntervalMinutes * 60 * 1000,
            onBudgetExceeded: async (usage, budget) => {
              log?.error?.(
                `BUDGET EXCEEDED: ${usage}/${budget} credits. All X API posts are now blocked.`,
              );
            },
            onBudgetWarning: async (usage, budget) => {
              log?.warn?.(
                `BUDGET WARNING: ${usage}/${budget} credits used (${Math.round((usage / budget) * 100)}%).`,
              );
            },
          });
        }

        // ── Smart Reply Pipeline ──────────────────────────────────────────
        // Initialize once on the first account start.
        eventBus = new ChannelEventBus(log);
        const srConfig = resolveSmartReplyConfig(cfg);
        if (srConfig) {
          smartReplyPipeline = new SmartReplyPipeline(
            {
              llm: {
                apiKey: srConfig.apiKey,
                model: srConfig.model,
                baseUrl: srConfig.baseUrl,
                temperature: srConfig.temperature,
                maxTokens: srConfig.maxTokens,
              },
              confidenceThreshold: srConfig.confidenceThreshold,
              log,
            },
            eventBus,
          );
          log?.info?.("Smart-reply pipeline initialized.");
        } else {
          smartReplyPipeline = null;
          log?.info?.("Smart-reply pipeline disabled (useSmartReply is false or not configured).");
        }
      }

      // Initialize token refresh if refresh token and client credentials are available
      if (account.refreshToken && account.clientId) {
        const tokenConfig: TokenRefreshConfig = {
          clientId: account.clientId,
          clientSecret: account.clientSecret,
        };
        initTokens(account.accountId, account.accessToken, account.refreshToken, tokenConfig, {
          log,
          onRefreshed: async (acctId, tokens) => {
            log?.info?.(
              `[${acctId}] Tokens refreshed. New expiry: ${new Date(tokens.expiresAt).toISOString()}. Persisting to config.`,
            );
            await persistRefreshedTokens(acctId, tokens.accessToken, tokens.refreshToken, log);
          },
        });
        log?.info?.(`[${account.accountId}] OAuth token refresh scheduled.`);
      }

      // Only start the shared stream once (first account wins)
      if (!streamRunning) {
        const bearerToken = resolveAppBearerToken(cfg);
        if (!bearerToken) {
          log?.error?.("No Bearer Token configured. Cannot start Filtered Stream.");
          return;
        }

        const agentUsernames = getAllAgentUsernames(cfg);
        if (agentUsernames.length === 0) {
          log?.warn?.("No enabled agent accounts found. Stream will not start.");
          return;
        }

        log?.info?.(
          `Starting Filtered Stream for ${agentUsernames.length} agent(s): ${agentUsernames.map((u) => `@${u}`).join(", ")}`,
        );

        streamRunning = true;

        await startFilteredStream({
          bearerToken,
          agentUsernames,
          log,
          abortSignal,
          onMention: async (post: StreamPost) => {
            await handleIncomingMention(post, cfg, log);
          },
          onStatusChange: (status) => {
            log?.info?.(`Filtered Stream status: ${status}`);
            // Update all active accounts' snapshots
            for (const activeId of activeAccountIds) {
              const activeAccount = resolveXAccount({ cfg, accountId: activeId });
              setStatus({
                accountId: activeId,
                name: activeAccount.name,
                enabled: true,
                configured: true,
                running: true,
                connected: status === "connected",
              });
            }
          },
        });
      }

      setStatus({
        accountId: account.accountId,
        name: account.name,
        enabled: true,
        configured: true,
        running: true,
        connected: getStreamStatus() === "connected",
      });

      log?.info?.(`[${account.accountId}] X channel started for @${account.agentUsername}.`);
    },

    stopAccount: async (ctx) => {
      const { accountId, log } = ctx;
      log?.info?.(`[${accountId}] Stopping X channel...`);

      activeAccountIds.delete(accountId);

      // Clear token refresh for this account
      clearTokens(accountId);

      // Only stop the shared stream when the last account is removed
      if (activeAccountIds.size === 0 && streamRunning) {
        log?.info?.("Last active account removed. Stopping Filtered Stream.");
        stopFilteredStream();
        streamRunning = false;
        clearAllTokens();
        resetRateLimiters();
        clearCreditBudget();
        clearAllThreadState();

        // Tear down smart-reply pipeline & event bus
        smartReplyPipeline = null;
        eventBus?.clear();
        eventBus = null;

        log?.info?.(
          "All token refresh timers, rate limiters, credit budget, and thread state cleared.",
        );
      }

      log?.info?.(`[${accountId}] X channel stopped.`);
    },
  },

  // ─── Outbound Adapter (Sending Replies) ──────────────────────────────────

  outbound: {
    deliveryMode: "direct",

    /**
     * X posts have a 280-character limit for most accounts.
     * The chunker splits long responses into multiple posts.
     */
    textChunkLimit: 280,

    /**
     * Send a text reply to a post on X.
     *
     * Uses the agent's own OAuth token (user-context) to post as that agent.
     * The `to` field contains the conversation/chat ID, and `replyToId`
     * contains the specific post ID being replied to.
     */
    sendText: async (ctx) => {
      const { text, replyToId, accountId, to } = ctx;
      const account = resolveXAccount({ cfg: ctx.cfg, accountId });

      if (!account.configured) {
        throw new Error(`X account ${accountId ?? "default"} is not configured.`);
      }

      // Check credit budget before posting
      const budgetCheck = checkCreditBudget();
      if (!budgetCheck.allowed) {
        throw new Error(
          `X API credit budget exceeded. ${budgetCheck.reason ?? ""} ` +
            `Increase the budget in channels.x.creditBudget or wait for the monthly reset.`,
        );
      }

      // Resolve the correct post to reply to for this chunk.
      //
      // OpenClaw passes the same original replyToId to every chunk, but X
      // requires each chunk to reply to the PREVIOUS chunk to form a thread.
      // We maintain a per-conversation "last post ID" map in thread-state.ts.
      //
      // Logic:
      //   - If a previous chunk was posted in this conversation → reply to that chunk.
      //   - Otherwise → reply to the original mention (replyToId from OpenClaw).
      const effectiveReplyToId = resolveReplyToIdForChunk(to, replyToId);

      // Build the API client with the correct auth mode for this account
      const isOAuth1 =
        account.authMode === "oauth1" &&
        account.oauth1AccessToken &&
        account.oauth1AccessTokenSecret &&
        account.oauth1ConsumerKey &&
        account.oauth1ConsumerSecret;

      const tokenRefreshConfig =
        !isOAuth1 && account.clientId
          ? { clientId: account.clientId, clientSecret: account.clientSecret }
          : undefined;

      const client = new XApiClient(
        isOAuth1
          ? {
              authMode: "oauth1",
              oauth1Credentials: {
                consumerKey: account.oauth1ConsumerKey!,
                consumerSecret: account.oauth1ConsumerSecret!,
                accessToken: account.oauth1AccessToken!,
                accessTokenSecret: account.oauth1AccessTokenSecret!,
              },
              accountId: account.accountId,
              rateLimitEnabled: true,
            }
          : {
              authMode: "oauth2",
              accessToken: account.accessToken,
              accountId: account.accountId,
              tokenRefreshConfig,
              rateLimitEnabled: true,
            },
      );

      const result = await client.createPost({
        text,
        inReplyToPostId: effectiveReplyToId,
      });

      if (!result.ok) {
        throw new Error(result.error ?? "Failed to create X post");
      }

      const postedId = result.postId ?? "";

      // Record this chunk so the next chunk in the same conversation
      // will reply to it, forming a proper X thread.
      if (postedId) {
        recordPostedChunk(to, postedId);
      }

      return {
        channel: "x" as const,
        messageId: postedId,
        chatId: to,
      };
    },
  },

  // ─── Mentions Adapter ────────────────────────────────────────────────────

  mentions: {
    /**
     * Return patterns to strip from the beginning of mention text.
     * This removes @agent mentions so the agent sees the clean command/question.
     */
    stripPatterns: () => {
      // Match @username patterns at the start of the message
      return ["^(@\\w+\\s*)+"];
    },
  },

  // ─── Threading Adapter ───────────────────────────────────────────────────

  threading: {
    resolveReplyToMode: () => "all",
  },
};

// ─── Token Persistence ──────────────────────────────────────────────────────

/**
 * Persist refreshed OAuth tokens back to the config file.
 *
 * Pattern: load current config → deep-clone → update the specific account's
 * tokens → write back. This ensures the refreshed tokens survive a restart.
 *
 * If the runtime is not available (e.g., during tests), this is a no-op.
 */
async function persistRefreshedTokens(
  accountId: string,
  accessToken: string,
  refreshToken: string,
  log?: ChannelLogSink,
): Promise<void> {
  const runtime = getXRuntime();

  if (!runtime?.config?.loadConfig || !runtime?.config?.writeConfigFile) {
    log?.warn?.(`[${accountId}] Runtime config API not available. Skipping token persistence.`);
    return;
  }

  try {
    // Load the current live config
    const currentCfg = runtime.config.loadConfig() as Record<string, unknown>;

    // Deep-clone to avoid mutating the live config object
    const nextCfg = structuredClone(currentCfg) as Record<string, unknown>;

    // Navigate to channels.x.accounts.<accountId>
    const channels = nextCfg.channels as Record<string, unknown> | undefined;
    const xChannel = channels?.x as Record<string, unknown> | undefined;
    const accounts = xChannel?.accounts as Record<string, unknown> | undefined;
    const accountEntry = accounts?.[accountId] as Record<string, unknown> | undefined;

    if (!accountEntry) {
      log?.warn?.(`[${accountId}] Account not found in config. Cannot persist refreshed tokens.`);
      return;
    }

    // Update the tokens in-place
    accountEntry.accessToken = accessToken;
    accountEntry.refreshToken = refreshToken;

    // Write the updated config back to disk
    await runtime.config.writeConfigFile(
      nextCfg as Parameters<typeof runtime.config.writeConfigFile>[0],
    );

    log?.info?.(`[${accountId}] Refreshed tokens persisted to config file.`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log?.error?.(`[${accountId}] Failed to persist refreshed tokens: ${msg}`);
    // Non-fatal — tokens are still valid in memory for this session
  }
}

// ─── Inbound Message Handler ─────────────────────────────────────────────────

const CHANNEL_ID = "x" as const;

// stripLeadingContextJsonBlock is in its own module for clean testability.
// See strip-context-json.ts for implementation details and the full label allowlist.

/**
 * Handle an incoming mention from the Filtered Stream.
 *
 * Routes the mention to the correct agent based on the matching rules,
 * then dispatches it into OpenClaw's inbound message pipeline using the
 * proper three-step pattern:
 *   1. resolveAgentRoute — determine which agent handles this mention
 *   2. finalizeInboundContext — build the normalized context payload
 *   3. dispatchReplyWithBufferedBlockDispatcher — run the agent and deliver reply
 *
 * When the smart-reply pipeline is active, the mention is classified once
 * (before iterating rules) to avoid redundant LLM calls when a post matches
 * multiple agent rules.
 */
async function handleIncomingMention(
  post: StreamPost,
  cfg: OpenClawConfig,
  log?: ChannelLogSink,
): Promise<void> {
  const runtime = getXRuntime();

  // ── Smart Reply Classification (once per post, before the rule loop) ────
  let smartReplyClassification: import("./smart-reply.js").ClassificationResult | null = null;

  if (smartReplyPipeline) {
    smartReplyClassification = await smartReplyPipeline.classify({
      id: post.id,
      text: post.text,
      authorUsername: post.authorUsername ?? post.authorId,
    });

    // If the post should be ignored, bail out before iterating rules at all.
    if (smartReplyClassification.route === "ignore") {
      log?.info?.(`[smart-reply] Ignoring post ${post.id}: ${smartReplyClassification.reason}`);
      return;
    }
  }

  // Deduplicate by agentUsername so a post matching multiple rules for the
  // same agent (e.g. stale duplicate rules on the X API) is only dispatched once.
  const handledAgents = new Set<string>();

  for (const rule of post.matchingRules) {
    // Rule tags are formatted as "agent:<username>"
    const match = rule.tag.match(/^agent:(.+)$/);
    if (!match) continue;

    const agentUsername = match[1];
    const account = findAccountByUsername(cfg, agentUsername);

    if (!account) {
      log?.warn?.(`Received mention for unknown agent @${agentUsername}. Ignoring.`);
      continue;
    }

    if (!account.enabled) {
      log?.debug?.(`Received mention for disabled agent @${agentUsername}. Ignoring.`);
      continue;
    }

    // Defense-in-depth: skip posts authored by the agent itself.
    // The stream rule already uses `-from:<username>` to prevent this at the
    // API level, but guard here too in case of stale rules or API edge cases.
    if (post.authorUsername && post.authorUsername.toLowerCase() === agentUsername.toLowerCase()) {
      log?.debug?.(
        `[${account.accountId}] Skipping self-post ${post.id} from @${post.authorUsername}.`,
      );
      continue;
    }

    // Skip if we already dispatched for this agent in this rule iteration
    // (handles duplicate matching_rules entries for the same agent username).
    const normalizedUsername = agentUsername.toLowerCase();
    if (handledAgents.has(normalizedUsername)) {
      log?.debug?.(
        `[${account.accountId}] Skipping duplicate rule match for @${agentUsername} on post ${post.id}.`,
      );
      continue;
    }
    handledAgents.add(normalizedUsername);

    const senderLabel = post.authorUsername ? `@${post.authorUsername}` : post.authorId;
    log?.info?.(
      `[${account.accountId}] Mention from ${senderLabel}: "${post.text.slice(0, 80)}..."`,
    );

    if (smartReplyClassification?.route === "escalate") {
      log?.warn?.(
        `[${account.accountId}] Smart-reply: escalating mention ${post.id} ` +
          `(${smartReplyClassification.reason}). Forwarding to pipeline with escalation metadata.`,
      );
    }

    try {
      // ── Step 1: Resolve the agent route ──────────────────────────────────
      const route = runtime.channel.routing.resolveAgentRoute({
        cfg,
        channel: CHANNEL_ID,
        accountId: account.accountId,
        peer: {
          kind: "direct",
          id: post.authorId,
        },
      });

      // ── Step 2: Build the context payload ────────────────────────────────
      const storePath = runtime.channel.session.resolveStorePath(cfg.session?.store, {
        agentId: route.agentId,
      });
      const envelopeOptions = runtime.channel.reply.resolveEnvelopeFormatOptions(cfg);
      const previousTimestamp = runtime.channel.session.readSessionUpdatedAt({
        storePath,
        sessionKey: route.sessionKey,
      });
      const rawBody = post.text.trim();
      const body = runtime.channel.reply.formatAgentEnvelope({
        channel: "X",
        from: senderLabel,
        timestamp: Date.now(),
        previousTimestamp,
        envelope: envelopeOptions,
        body: rawBody,
      });
      const ctxPayload = runtime.channel.reply.finalizeInboundContext({
        Body: body,
        RawBody: rawBody,
        CommandBody: rawBody,
        From: `x:${post.authorId}`,
        To: `x:${account.agentUsername}`,
        SessionKey: route.sessionKey,
        AccountId: route.accountId,
        // Use "direct" so resolveConversationLabel() takes the direct path and uses
        // SenderName (e.g. "MyXStack") rather than falling back to the raw From field
        // (e.g. "x:<authorId>") for session metadata labels.
        ChatType: "direct",
        // Do NOT set ConversationLabel here. Setting it causes buildInboundUserContextPrefix
        // to emit a JSON block ({ "conversation_label": "@sender" }) that gets prepended to
        // the user message body. The model then echoes this block back in its reply, which
        // bleeds into the outbound tweet text. The sender is already present in the formatted
        // envelope body ("from: @sender"), so ConversationLabel is redundant for X mentions.
        SenderName: post.authorUsername ?? undefined,
        SenderId: post.authorId,
        Provider: CHANNEL_ID,
        Surface: CHANNEL_ID,
        MessageSid: post.id,
        Timestamp: Date.now(),
        OriginatingChannel: CHANNEL_ID,
        OriginatingTo: `x:${account.agentUsername}`,
        // Pass smart-reply classification as extra context
        ...(smartReplyClassification
          ? {
              SmartReplyRoute: smartReplyClassification.route,
              SmartReplyReason: smartReplyClassification.reason,
            }
          : {}),
      });

      await runtime.channel.session.recordInboundSession({
        storePath,
        sessionKey: ctxPayload.SessionKey ?? route.sessionKey,
        ctx: ctxPayload,
        onRecordError: (err) => {
          log?.error?.(`[${account.accountId}] Failed updating session meta: ${String(err)}`);
        },
      });

      // ── Step 3: Build the reply client and dispatch ───────────────────────
      const isOAuth1 =
        account.authMode === "oauth1" &&
        account.oauth1AccessToken &&
        account.oauth1AccessTokenSecret &&
        account.oauth1ConsumerKey &&
        account.oauth1ConsumerSecret;

      const replyClient = new XApiClient(
        isOAuth1
          ? {
              authMode: "oauth1",
              oauth1Credentials: {
                consumerKey: account.oauth1ConsumerKey!,
                consumerSecret: account.oauth1ConsumerSecret!,
                accessToken: account.oauth1AccessToken!,
                accessTokenSecret: account.oauth1AccessTokenSecret!,
              },
              accountId: account.accountId,
              rateLimitEnabled: true,
            }
          : {
              authMode: "oauth2",
              accessToken: account.accessToken,
              accountId: account.accountId,
              rateLimitEnabled: true,
            },
      );

      const { onModelSelected, ...prefixOptions } = createReplyPrefixOptions({
        cfg,
        agentId: route.agentId,
        channel: CHANNEL_ID,
        accountId: account.accountId,
      });

      await runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
        ctx: ctxPayload,
        cfg,
        dispatcherOptions: {
          ...prefixOptions,
          deliver: async (payload) => {
            const rawText = (payload as { text?: string }).text ?? "";
            // Safety-net: strip any leading OpenClaw context JSON blocks that the model
            // may have echoed back (e.g. ```json\n{ "conversation_label": ... }\n```).
            // These are injected as user-role context prefixes and should never appear
            // in outbound tweet text.
            const text = stripLeadingContextJsonBlock(rawText);
            if (!text.trim()) return;
            // Use thread-state to chain replies into a thread
            const chatId = post.conversationId ?? post.id;
            const effectiveReplyToId = resolveReplyToIdForChunk(chatId, post.id);
            const result = await replyClient.createPost({
              text,
              inReplyToPostId: effectiveReplyToId,
            });
            if (result.ok && result.postId) {
              recordPostedChunk(chatId, result.postId);
            }
          },
          onError: (err, info) => {
            log?.error?.(`[${account.accountId}] X ${info.kind} reply failed: ${String(err)}`);
          },
        },
        replyOptions: {
          onModelSelected,
        },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log?.error?.(`[${account.accountId}] Failed to dispatch inbound mention: ${msg}`);
    }
  }
}
