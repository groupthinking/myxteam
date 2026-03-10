/**
 * X Filtered Stream Handler
 *
 * Manages a persistent connection to the X API v2 Filtered Stream endpoint.
 * Listens for @mentions of all configured agent usernames and dispatches
 * incoming posts to the appropriate agent through OpenClaw's message pipeline.
 *
 * Key design decisions:
 * - Uses a single stream connection for ALL agent accounts (app-level auth)
 * - Rules are dynamically managed: one rule per agent username
 * - Implements exponential backoff reconnection per X API best practices
 * - Keep-alive timeout detection (20s per X docs)
 */

import type { ChannelLogSink } from "openclaw/plugin-sdk";

// ─── Types ───────────────────────────────────────────────────────────────────

/** A post received from the Filtered Stream. */
export interface StreamPost {
  id: string;
  text: string;
  authorId: string;
  authorUsername?: string;
  conversationId?: string;
  inReplyToUserId?: string;
  createdAt?: string;
  referencedTweets?: Array<{
    type: "replied_to" | "quoted" | "retweeted";
    id: string;
  }>;
  /** The rule tags that matched this post (i.e., which agent was mentioned). */
  matchingRules: Array<{ id: string; tag: string }>;
}

/** Configuration for starting the stream. */
export interface StreamConfig {
  /** App-level Bearer Token. */
  bearerToken: string;
  /** List of agent usernames to listen for (without @ prefix). */
  agentUsernames: string[];
  /** Callback when a mention is received. */
  onMention: (post: StreamPost) => void | Promise<void>;
  /** Callback for stream status changes. */
  onStatusChange?: (status: StreamStatus) => void;
  /** Optional logger. */
  log?: ChannelLogSink;
  /** AbortSignal for graceful shutdown. */
  abortSignal?: AbortSignal;
}

export type StreamStatus =
  | "connecting"
  | "connected"
  | "reconnecting"
  | "disconnected"
  | "error";

/** Internal state for an active stream. */
interface ActiveStream {
  controller: AbortController;
  status: StreamStatus;
  reconnectAttempts: number;
}

// ─── Constants ───────────────────────────────────────────────────────────────

const X_API_BASE = "https://api.x.com/2";
const STREAM_ENDPOINT = `${X_API_BASE}/tweets/search/stream`;
const RULES_ENDPOINT = `${X_API_BASE}/tweets/search/stream/rules`;

/** Fields to request for each streamed post. */
const TWEET_FIELDS = [
  "created_at",
  "conversation_id",
  "in_reply_to_user_id",
  "referenced_tweets",
  "author_id",
].join(",");

const EXPANSIONS = "author_id";
const USER_FIELDS = "username";

/**
 * Keep-alive timeout. X sends a heartbeat every 20 seconds.
 * If we don't receive anything for 30 seconds, assume disconnect.
 */
const KEEPALIVE_TIMEOUT_MS = 30_000;

/** Maximum reconnect delay (5 minutes). */
const MAX_RECONNECT_DELAY_MS = 5 * 60 * 1000;

/** Base reconnect delay (1 second). */
const BASE_RECONNECT_DELAY_MS = 1_000;

// ─── Module State ────────────────────────────────────────────────────────────

/** The single active stream instance (one per OpenClaw process). */
let activeStream: ActiveStream | null = null;

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Start the Filtered Stream.
 *
 * 1. Syncs stream rules to match the configured agent usernames.
 * 2. Opens a persistent HTTP connection to the stream endpoint.
 * 3. Parses incoming posts and dispatches them via the onMention callback.
 * 4. Handles reconnection with exponential backoff.
 */
export async function startFilteredStream(config: StreamConfig): Promise<void> {
  const { bearerToken, agentUsernames, onMention, onStatusChange, log, abortSignal } = config;

  if (activeStream) {
    log?.warn?.("Stream already active. Stopping existing stream before starting a new one.");
    stopFilteredStream();
  }

  if (agentUsernames.length === 0) {
    log?.warn?.("No agent usernames configured. Stream will not start.");
    return;
  }

  const controller = new AbortController();
  activeStream = {
    controller,
    status: "connecting",
    reconnectAttempts: 0,
  };

  // Link the external abort signal to our internal controller
  if (abortSignal) {
    abortSignal.addEventListener("abort", () => {
      log?.info?.("External abort signal received. Stopping stream.");
      stopFilteredStream();
    });
  }

  // Step 1: Sync rules
  try {
    await syncStreamRules(bearerToken, agentUsernames, log);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log?.error?.(`Failed to sync stream rules: ${msg}`);
    setStatus("error", onStatusChange);
    activeStream = null;
    return;
  }

  // Step 2: Connect to stream (with reconnection loop)
  connectToStream(config, controller);
}

/**
 * Stop the Filtered Stream and clean up.
 */
export function stopFilteredStream(): void {
  if (activeStream) {
    activeStream.controller.abort();
    activeStream.status = "disconnected";
    activeStream = null;
  }
}

/**
 * Get the current stream status.
 */
export function getStreamStatus(): StreamStatus {
  return activeStream?.status ?? "disconnected";
}

// ─── Stream Rules Management ─────────────────────────────────────────────────

/**
 * Sync the Filtered Stream rules to match the desired agent usernames.
 * Removes stale rules and adds missing ones.
 *
 * Each rule is tagged with `agent:<username>` so we can route incoming
 * posts to the correct agent.
 */
async function syncStreamRules(
  bearerToken: string,
  agentUsernames: string[],
  log?: ChannelLogSink,
): Promise<void> {
  const headers = {
    Authorization: `Bearer ${bearerToken}`,
    "Content-Type": "application/json",
  };

  // Fetch existing rules
  const existingRes = await fetch(RULES_ENDPOINT, { headers });
  if (!existingRes.ok) {
    throw new Error(`Failed to fetch stream rules: ${existingRes.status} ${existingRes.statusText}`);
  }
  const existingData = (await existingRes.json()) as {
    data?: Array<{ id: string; value: string; tag?: string }>;
  };
  const existingRules = existingData.data ?? [];

  // Build desired rule set using the shared buildStreamRules helper so that
  // the -from:<username> self-exclusion operator is applied consistently.
  const desiredRules = new Map<string, string>();
  for (const rule of buildStreamRules(agentUsernames)) {
    desiredRules.set(rule.tag, rule.value);
  }

  // Determine rules to delete: stale agent rules (tag not in desired set) OR
  // rules whose value has changed (e.g. old `@milkxxman` → new `@milkxxman -from:milkxxman`).
  const rulesToDelete: string[] = [];
  for (const rule of existingRules) {
    const tag = rule.tag ?? "";
    if (!tag.startsWith("agent:")) continue;
    const desiredValue = desiredRules.get(tag);
    if (desiredValue === undefined) {
      // Tag no longer desired — delete it.
      rulesToDelete.push(rule.id);
    } else if (rule.value !== desiredValue) {
      // Tag exists but value changed (e.g. -from: operator was added) — delete
      // so it can be re-created with the correct value.
      rulesToDelete.push(rule.id);
    }
  }

  // Build the set of tags that already exist with the correct value.
  const existingCorrectTags = new Set(
    existingRules
      .filter((r) => {
        const tag = r.tag ?? "";
        return tag.startsWith("agent:") && desiredRules.get(tag) === r.value;
      })
      .map((r) => r.tag ?? ""),
  );

  // Determine rules to add (desired but don't exist with the correct value).
  const rulesToAdd: Array<{ value: string; tag: string }> = [];
  for (const [tag, value] of desiredRules) {
    if (!existingCorrectTags.has(tag)) {
      rulesToAdd.push({ value, tag });
    }
  }

  // Apply deletions
  if (rulesToDelete.length > 0) {
    log?.info?.(`Deleting ${rulesToDelete.length} stale stream rule(s).`);
    const deleteRes = await fetch(RULES_ENDPOINT, {
      method: "POST",
      headers,
      body: JSON.stringify({ delete: { ids: rulesToDelete } }),
    });
    if (!deleteRes.ok) {
      const body = await deleteRes.text();
      throw new Error(`Failed to delete stream rules: ${deleteRes.status} — ${body}`);
    }
  }

  // Apply additions
  if (rulesToAdd.length > 0) {
    log?.info?.(`Adding ${rulesToAdd.length} new stream rule(s): ${rulesToAdd.map((r) => r.value).join(", ")}`);
    const addRes = await fetch(RULES_ENDPOINT, {
      method: "POST",
      headers,
      body: JSON.stringify({ add: rulesToAdd }),
    });
    if (!addRes.ok) {
      const body = await addRes.text();
      throw new Error(`Failed to add stream rules: ${addRes.status} — ${body}`);
    }
  }

  if (rulesToDelete.length === 0 && rulesToAdd.length === 0) {
    log?.info?.("Stream rules are already in sync.");
  }
}

// ─── Stream Connection ───────────────────────────────────────────────────────

/**
 * Connect to the Filtered Stream endpoint and process incoming data.
 * Implements reconnection with exponential backoff.
 */
async function connectToStream(
  config: StreamConfig,
  controller: AbortController,
): Promise<void> {
  const { bearerToken, onMention, onStatusChange, log } = config;

  const streamUrl = new URL(STREAM_ENDPOINT);
  streamUrl.searchParams.set("tweet.fields", TWEET_FIELDS);
  streamUrl.searchParams.set("expansions", EXPANSIONS);
  streamUrl.searchParams.set("user.fields", USER_FIELDS);

  while (activeStream && !controller.signal.aborted) {
    try {
      setStatus("connecting", onStatusChange);
      log?.info?.("Connecting to X Filtered Stream...");

      const response = await fetch(streamUrl.toString(), {
        headers: {
          Authorization: `Bearer ${bearerToken}`,
        },
        signal: controller.signal,
      });

      if (!response.ok) {
        const body = await response.text().catch(() => "");
        throw new Error(`Stream HTTP error: ${response.status} ${response.statusText} — ${body}`);
      }

      if (!response.body) {
        throw new Error("Stream response has no body.");
      }

      setStatus("connected", onStatusChange);
      log?.info?.("Connected to X Filtered Stream.");

      // Reset reconnect attempts on successful connection
      if (activeStream) {
        activeStream.reconnectAttempts = 0;
      }

      // Process the stream
      await processStream(response.body, onMention, log, controller);
    } catch (err) {
      if (controller.signal.aborted) {
        log?.info?.("Stream connection aborted (shutdown).");
        break;
      }

      const msg = err instanceof Error ? err.message : String(err);
      log?.error?.(`Stream error: ${msg}`);
      setStatus("reconnecting", onStatusChange);

      // Exponential backoff
      if (activeStream) {
        activeStream.reconnectAttempts++;
        const delay = Math.min(
          BASE_RECONNECT_DELAY_MS * Math.pow(2, activeStream.reconnectAttempts - 1),
          MAX_RECONNECT_DELAY_MS,
        );
        log?.info?.(`Reconnecting in ${Math.round(delay / 1000)}s (attempt ${activeStream.reconnectAttempts})...`);
        await sleep(delay, controller.signal);
      }
    }
  }

  setStatus("disconnected", onStatusChange);
}

/**
 * Process the raw byte stream from the Filtered Stream endpoint.
 * Handles line-delimited JSON and keep-alive heartbeats.
 */
async function processStream(
  body: ReadableStream<Uint8Array>,
  onMention: (post: StreamPost) => void | Promise<void>,
  log?: ChannelLogSink,
  controller?: AbortController,
): Promise<void> {
  const decoder = new TextDecoder();
  const reader = body.getReader();
  let buffer = "";
  let keepAliveTimer: ReturnType<typeof setTimeout> | null = null;

  const resetKeepAlive = () => {
    if (keepAliveTimer) clearTimeout(keepAliveTimer);
    keepAliveTimer = setTimeout(() => {
      log?.warn?.("Keep-alive timeout — no data received for 30s. Forcing reconnect.");
      reader.cancel().catch(() => {});
    }, KEEPALIVE_TIMEOUT_MS);
  };

  resetKeepAlive();

  try {
    while (true) {
      if (controller?.signal.aborted) break;

      const { done, value } = await reader.read();
      if (done) break;

      resetKeepAlive();

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\r\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) {
          // Keep-alive heartbeat (empty line) — already handled by resetKeepAlive
          continue;
        }

        try {
          const parsed = JSON.parse(trimmed);
          const post = parseStreamPost(parsed);
          if (post) {
            await onMention(post);
          }
        } catch (parseErr) {
          const msg = parseErr instanceof Error ? parseErr.message : String(parseErr);
          log?.debug?.(`Failed to parse stream line: ${msg}`);
        }
      }
    }
  } finally {
    if (keepAliveTimer) clearTimeout(keepAliveTimer);
    reader.releaseLock();
  }
}

// ─── Parsing ─────────────────────────────────────────────────────────────────

/**
 * Build the desired stream rules from a list of agent usernames.
 * Exported for testing.
 *
 * Each rule uses `-from:<username>` to exclude the agent's own posts from the
 * stream. Without this, the agent's own reply tweets (which contain @mentions
 * in their text) would match the rule and cause duplicate dispatch loops.
 *
 * Usernames are normalized (trimmed, leading `@` stripped) before use so that
 * a config value like `@milkxxman` doesn't produce an invalid rule `@@milkxxman`.
 */
export function buildStreamRules(
  agentUsernames: string[],
): Array<{ value: string; tag: string }> {
  return agentUsernames.map((raw) => {
    // Normalize: trim whitespace and strip any leading '@'
    const username = raw.trim().replace(/^@/, "");
    return {
      // Match mentions of this agent, but exclude posts FROM the agent itself.
      // This prevents the agent's own replies from re-triggering the handler.
      value: `@${username} -from:${username}`,
      tag: `agent:${username.toLowerCase()}`,
    };
  });
}

/**
 * Parse a single line from the Filtered Stream.
 * Returns a StreamPost if the line contains valid post data, or null
 * for heartbeat/empty/malformed lines.
 * Exported for testing.
 */
export function parseStreamLine(line: string): StreamPost | null {
  const trimmed = line.trim();
  if (!trimmed) return null;

  try {
    const parsed = JSON.parse(trimmed);
    return parseStreamPost(parsed);
  } catch {
    return null;
  }
}

function parseStreamPost(raw: unknown): StreamPost | null {
  if (!raw || typeof raw !== "object") return null;

  const obj = raw as Record<string, unknown>;
  const data = obj.data as Record<string, unknown> | undefined;
  // Require id, text, and author_id — a post without an author is malformed.
  if (
    !data ||
    typeof data.id !== "string" ||
    typeof data.text !== "string" ||
    typeof data.author_id !== "string" ||
    data.author_id.length === 0
  ) {
    return null;
  }

  // Extract author username from includes.users expansion
  let authorUsername: string | undefined;
  const includes = obj.includes as Record<string, unknown> | undefined;
  if (includes?.users && Array.isArray(includes.users)) {
    const authorUser = (includes.users as Array<Record<string, unknown>>).find(
      (u) => u.id === data.author_id,
    );
    if (authorUser && typeof authorUser.username === "string") {
      authorUsername = authorUser.username;
    }
  }

  // Extract matching rules
  const matchingRules: Array<{ id: string; tag: string }> = [];
  if (Array.isArray(obj.matching_rules)) {
    for (const rule of obj.matching_rules as Array<Record<string, unknown>>) {
      if (typeof rule.id === "string" && typeof rule.tag === "string") {
        matchingRules.push({ id: rule.id, tag: rule.tag });
      }
    }
  }

  return {
    id: data.id as string,
    text: data.text as string,
    authorId: data.author_id as string,
    authorUsername,
    conversationId: data.conversation_id as string | undefined,
    inReplyToUserId: data.in_reply_to_user_id as string | undefined,
    createdAt: data.created_at as string | undefined,
    referencedTweets: data.referenced_tweets as StreamPost["referencedTweets"],
    matchingRules,
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function setStatus(
  status: StreamStatus,
  onStatusChange?: (status: StreamStatus) => void,
): void {
  if (activeStream) {
    activeStream.status = status;
  }
  onStatusChange?.(status);
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}
