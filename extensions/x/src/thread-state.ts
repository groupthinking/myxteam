/**
 * Thread State — Multi-Chunk Reply Threading
 *
 * X posts are limited to 280 characters. When an agent response is longer,
 * OpenClaw's chunker splits it into multiple pieces and calls sendText() once
 * per chunk. However, OpenClaw's delivery pipeline passes the same original
 * replyToId to every chunk — it does not update replyToId between chunks.
 *
 * To create a proper X thread (where chunk 2 replies to chunk 1, chunk 3
 * replies to chunk 2, etc.), we maintain a per-conversation "last post ID"
 * map here. Each sendText() call checks this map:
 *
 *   - If a previous chunk was posted in this conversation, reply to that chunk.
 *   - Otherwise, reply to the original mention (the replyToId from OpenClaw).
 *
 * The map is keyed by chatId (the X conversation ID). Entries expire after
 * THREAD_EXPIRY_MS to prevent stale state from leaking across conversations.
 *
 * This module is intentionally simple and stateless across restarts — if the
 * process restarts mid-thread, the next chunk will reply to the original post
 * rather than the previous chunk. This is acceptable for the current use case.
 */

// ─── Constants ───────────────────────────────────────────────────────────────

/**
 * How long (ms) to keep a thread entry alive after the last post.
 * 10 minutes is generous — agent responses are typically generated in seconds.
 */
const THREAD_EXPIRY_MS = 10 * 60 * 1000;

// ─── Types ───────────────────────────────────────────────────────────────────

interface ThreadEntry {
  /** The ID of the most recently posted chunk in this thread. */
  lastPostId: string;
  /** When this entry was last updated (Unix ms). */
  updatedAt: number;
}

// ─── Module State ─────────────────────────────────────────────────────────────

/** Map from chatId → last posted chunk ID. */
const threadMap = new Map<string, ThreadEntry>();

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Resolve the post ID to reply to for a given chunk.
 *
 * Returns the ID of the last chunk posted in this conversation (if any),
 * or falls back to the original replyToId from OpenClaw.
 *
 * @param chatId         The X conversation ID (used as the thread key).
 * @param originalReplyToId  The replyToId passed by OpenClaw (the original mention).
 */
export function resolveReplyToIdForChunk(
  chatId: string,
  originalReplyToId: string | null | undefined,
): string | undefined {
  pruneExpiredEntries();

  const entry = threadMap.get(chatId);
  if (entry) {
    return entry.lastPostId;
  }

  return originalReplyToId ?? undefined;
}

/**
 * Record that a chunk was successfully posted in a conversation.
 * The next chunk in this conversation will reply to this post.
 *
 * @param chatId   The X conversation ID.
 * @param postId   The ID of the post that was just created.
 */
export function recordPostedChunk(chatId: string, postId: string): void {
  threadMap.set(chatId, {
    lastPostId: postId,
    updatedAt: Date.now(),
  });
}

/**
 * Clear the thread state for a conversation.
 * Call this when a thread is complete (i.e., the last chunk was sent).
 * In practice this is optional — entries expire automatically.
 *
 * @param chatId  The X conversation ID to clear.
 */
export function clearThreadState(chatId: string): void {
  threadMap.delete(chatId);
}

/**
 * Clear all thread state. Call on plugin shutdown.
 */
export function clearAllThreadState(): void {
  threadMap.clear();
}

/**
 * Get the number of active thread entries (for diagnostics/testing).
 */
export function getThreadStateSize(): number {
  pruneExpiredEntries();
  return threadMap.size;
}

// ─── Internal ────────────────────────────────────────────────────────────────

/**
 * Remove expired entries from the thread map.
 * Called lazily before reads to avoid a separate cleanup timer.
 */
function pruneExpiredEntries(): void {
  const now = Date.now();
  for (const [chatId, entry] of threadMap) {
    if (now - entry.updatedAt > THREAD_EXPIRY_MS) {
      threadMap.delete(chatId);
    }
  }
}
