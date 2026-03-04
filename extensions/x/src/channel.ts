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
 */

import type { ChannelPlugin, OpenClawConfig } from "openclaw/plugin-sdk";

import { XChannelConfigSchema } from "./config-schema.js";
import {
  listXAccountIds,
  resolveDefaultXAccountId,
  resolveXAccount,
  resolveAppBearerToken,
  getAllAgentUsernames,
  findAccountByUsername,
  type ResolvedXAccount,
} from "./types.js";
import {
  startFilteredStream,
  stopFilteredStream,
  getStreamStatus,
  type StreamPost,
} from "./stream-handler.js";
import { XApiClient } from "./x-api-client.js";
import { getXRuntime } from "./runtime.js";
import {
  initTokens,
  clearTokens,
  clearAllTokens,
  type TokenRefreshConfig,
} from "./token-refresh.js";
import {
  initRateLimiter,
  resetRateLimiters,
} from "./rate-limiter.js";
import {
  initCreditBudget,
  clearCreditBudget,
  checkCreditBudget,
  getCreditUsageSnapshot,
} from "./credit-budget.js";
import { resolveCreditBudget } from "./types.js";
import {
  resolveReplyToIdForChunk,
  recordPostedChunk,
  clearAllThreadState,
} from "./thread-state.js";

// ─── Module State ────────────────────────────────────────────────────────────

/** Track whether the shared stream is running. */
let streamRunning = false;

/** Track active account IDs so we know when to stop the shared stream. */
const activeAccountIds = new Set<string>();

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
    edit: true,
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
          await initCreditBudget({
            budget: creditBudget,
            bearerToken,
            log,
            usageCheckIntervalMinutes: undefined, // uses default 60 min
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
      }

      // Initialize token refresh if refresh token and client credentials are available
      if (account.refreshToken && account.clientId) {
        const tokenConfig: TokenRefreshConfig = {
          clientId: account.clientId,
          clientSecret: account.clientSecret,
        };
        initTokens(
          account.accountId,
          account.accessToken,
          account.refreshToken,
          tokenConfig,
          {
            log,
            onRefreshed: async (acctId, tokens) => {
              log?.info?.(
                `[${acctId}] Tokens refreshed. New expiry: ${new Date(tokens.expiresAt).toISOString()}. Persisting to config.`,
              );
              await persistRefreshedTokens(acctId, tokens.accessToken, tokens.refreshToken, log);
            },
          },
        );
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
        log?.info?.("All token refresh timers, rate limiters, credit budget, and thread state cleared.");
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
      const isOAuth1 = account.authMode === "oauth1" &&
        account.oauth1AccessToken &&
        account.oauth1AccessTokenSecret &&
        account.oauth1ConsumerKey &&
        account.oauth1ConsumerSecret;

      const tokenRefreshConfig = !isOAuth1 && account.clientId
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
  log?: { info?: (...args: unknown[]) => void; warn?: (...args: unknown[]) => void; error?: (...args: unknown[]) => void },
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
      log?.warn?.(
        `[${accountId}] Account not found in config. Cannot persist refreshed tokens.`,
      );
      return;
    }

    // Update the tokens in-place
    accountEntry.accessToken = accessToken;
    accountEntry.refreshToken = refreshToken;

    // Write the updated config back to disk
    await runtime.config.writeConfigFile(nextCfg as Parameters<typeof runtime.config.writeConfigFile>[0]);

    log?.info?.(`[${accountId}] Refreshed tokens persisted to config file.`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log?.error?.(`[${accountId}] Failed to persist refreshed tokens: ${msg}`);
    // Non-fatal — tokens are still valid in memory for this session
  }
}

// ─── Inbound Message Handler ─────────────────────────────────────────────────

/**
 * Handle an incoming mention from the Filtered Stream.
 *
 * Routes the mention to the correct agent based on the matching rules,
 * then dispatches it into OpenClaw's inbound message pipeline via the
 * runtime.channel.reply.handleInboundMessage() method.
 *
 * This follows the exact same pattern as the nostr plugin's onMessage callback.
 */
async function handleIncomingMention(
  post: StreamPost,
  cfg: OpenClawConfig,
  log?: { info?: (...args: unknown[]) => void; warn?: (...args: unknown[]) => void; error?: (...args: unknown[]) => void; debug?: (...args: unknown[]) => void },
): Promise<void> {
  const runtime = getXRuntime();

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

    log?.info?.(
      `[${account.accountId}] Mention from @${post.authorUsername ?? post.authorId}: "${post.text.slice(0, 80)}..."`,
    );

    // Dispatch to OpenClaw's message pipeline.
    // This follows the exact same pattern as the nostr plugin.
    try {
      await (
        runtime.channel.reply as {
          handleInboundMessage?: (params: unknown) => Promise<void>;
        }
      ).handleInboundMessage?.({
        channel: "x",
        accountId: account.accountId,
        senderId: post.authorId,
        senderUsername: post.authorUsername,
        chatType: "thread",
        chatId: post.conversationId ?? post.id,
        text: post.text,
        replyToId: post.id,
        reply: async (responseText: string) => {
          const client = new XApiClient({
            accessToken: account.accessToken,
          });
          await client.createPost({
            text: responseText,
            inReplyToPostId: post.id,
          });
        },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log?.error?.(
        `[${account.accountId}] Failed to dispatch inbound mention: ${msg}`,
      );
    }
  }
}
