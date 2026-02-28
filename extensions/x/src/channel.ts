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

import type {
  ChannelPlugin,
  ChannelAccountSnapshot,
  ChannelLogSink,
} from "openclaw/plugin-sdk";

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

// ─── Module State ────────────────────────────────────────────────────────────

/** Track whether the shared stream is running. */
let streamRunning = false;

/** Store the runtime reference for dispatching inbound messages. */
let pluginRuntime: {
  channel: { reply: Record<string, unknown> };
  config: { loadConfig: () => Record<string, unknown> };
} | null = null;

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
    chatTypes: ["direct", "thread"],
    reply: true,
    edit: true,
    media: false, // Media support can be added later
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
      policy: "open",
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
     * Subsequent accounts just register themselves as active.
     */
    startAccount: async (ctx) => {
      const { account, cfg, log, setStatus } = ctx;

      if (!account.configured || !account.enabled) {
        log?.info?.(`[${account.accountId}] Skipping — not configured or not enabled.`);
        return;
      }

      log?.info?.(`[${account.accountId}] Starting X channel for @${account.agentUsername}...`);

      // Only start the shared stream once
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

        log?.info?.(`Starting Filtered Stream for ${agentUsernames.length} agent(s): ${agentUsernames.map((u) => `@${u}`).join(", ")}`);

        await startFilteredStream({
          bearerToken,
          agentUsernames,
          log,
          abortSignal: ctx.abortSignal,
          onMention: async (post: StreamPost) => {
            await handleIncomingMention(post, cfg, log);
          },
          onStatusChange: (status) => {
            log?.info?.(`Filtered Stream status: ${status}`);
          },
        });

        streamRunning = true;
      }

      setStatus({
        accountId: account.accountId,
        name: account.name,
        enabled: true,
        configured: true,
        running: true,
        connected: getStreamStatus() === "connected",
      } satisfies ChannelAccountSnapshot);

      log?.info?.(`[${account.accountId}] X channel started for @${account.agentUsername}.`);
    },

    stopAccount: async (ctx) => {
      ctx.log?.info?.(`[${ctx.accountId}] Stopping X channel...`);

      // Only stop the stream if this is the last account
      // For now, we stop on any account stop (can be refined later)
      if (streamRunning) {
        stopFilteredStream();
        streamRunning = false;
      }

      ctx.log?.info?.(`[${ctx.accountId}] X channel stopped.`);
    },
  },

  // ─── Outbound Adapter (Sending Replies) ──────────────────────────────────

  outbound: {
    deliveryMode: "direct",

    /**
     * Send a text reply to a post on X.
     *
     * Uses the agent's own OAuth token (user-context) to post as that agent.
     * The `to` field contains the conversation/chat ID, and `replyToId`
     * contains the specific post ID being replied to.
     */
    sendText: async (ctx) => {
      const { text, replyToId, accountId } = ctx;
      const account = resolveXAccount({ cfg: ctx.cfg, accountId });

      if (!account.configured) {
        return { ok: false, error: `X account ${accountId} is not configured.` };
      }

      const client = new XApiClient({
        accessToken: account.accessToken,
      });

      const result = await client.createPost({
        text,
        inReplyToPostId: replyToId ?? undefined,
      });

      if (result.ok) {
        return { ok: true, deliveryId: result.postId };
      }

      return { ok: false, error: new Error(result.error ?? "Unknown error") };
    },
  },

  // ─── Mentions Adapter ────────────────────────────────────────────────────

  mentions: {
    stripPatterns: ({ text }) => {
      // Remove @agent mentions from the beginning of the text
      // so the agent sees the clean command/question.
      return text.replace(/^(@\w+\s*)+/, "").trim();
    },
  },

  // ─── Threading Adapter ───────────────────────────────────────────────────

  threading: {
    resolveReplyToMode: () => "all",
  },
};

// ─── Inbound Message Handler ─────────────────────────────────────────────────

/**
 * Handle an incoming mention from the Filtered Stream.
 *
 * Routes the mention to the correct agent based on the matching rules,
 * then dispatches it into OpenClaw's inbound message pipeline.
 */
async function handleIncomingMention(
  post: StreamPost,
  cfg: Record<string, unknown>,
  log?: ChannelLogSink,
): Promise<void> {
  // Determine which agent(s) were mentioned based on matching rules
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
    // The runtime.channel.reply.handleInboundMessage function is the standard
    // entry point for all channel plugins to inject messages.
    //
    // TODO: Wire this up to the actual runtime once the plugin is registered.
    // For now, we log the intent. The integration point follows the same
    // pattern as the nostr plugin's onMessage callback.
    //
    // await runtime.channel.reply.handleInboundMessage({
    //   channel: "x",
    //   accountId: account.accountId,
    //   senderId: post.authorId,
    //   senderUsername: post.authorUsername,
    //   chatType: "thread",
    //   chatId: post.conversationId ?? post.id,
    //   text: post.text,
    //   replyToId: post.id,
    //   reply: async (responseText: string) => {
    //     const client = new XApiClient({ accessToken: account.accessToken });
    //     await client.createPost({ text: responseText, inReplyToPostId: post.id });
    //   },
    // });
  }
}

// ─── Runtime Registration ────────────────────────────────────────────────────

/**
 * Set the plugin runtime reference.
 * Called by the plugin entrypoint during registration.
 */
export function setXRuntime(runtime: typeof pluginRuntime): void {
  pluginRuntime = runtime;
}

/**
 * Get the plugin runtime reference.
 */
export function getXRuntime(): typeof pluginRuntime {
  return pluginRuntime;
}
