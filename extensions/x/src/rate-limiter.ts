/**
 * X API Rate Limiter
 *
 * Implements dual-layer rate limiting for the X channel plugin:
 *
 * 1. **App-level rate limiter**: Shared across all agent accounts. Enforces
 *    the app-wide rate limit for post creation (the shared cap that X applies
 *    across all users of a single app).
 *
 * 2. **Per-user rate limiter**: Independent per agent account. Enforces
 *    per-user rate limits for individual endpoints.
 *
 * Uses a sliding-window token bucket algorithm for smooth rate limiting
 * without hard edges at window boundaries.
 *
 * Reference: https://docs.x.com/x-api/fundamentals/rate-limits
 */

import type { ChannelLogSink } from "openclaw/plugin-sdk";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface RateLimitConfig {
  /**
   * Maximum number of post creation requests per 15-minute window (app-level).
   * This is the shared cap across all agents.
   * Default: 300 (conservative estimate; actual limit depends on tier).
   */
  appPostsPerWindow?: number;

  /**
   * Maximum number of post creation requests per 15-minute window (per-user).
   * Default: 200.
   */
  userPostsPerWindow?: number;

  /**
   * Window size in milliseconds.
   * Default: 15 * 60 * 1000 (15 minutes, per X API standard).
   */
  windowMs?: number;
}

export interface RateLimitResult {
  allowed: boolean;
  /** Milliseconds until the next request would be allowed. 0 if allowed. */
  retryAfterMs: number;
  /** Current usage count in the window. */
  currentUsage: number;
  /** Maximum allowed in the window. */
  limit: number;
}

// ─── Constants ───────────────────────────────────────────────────────────────

const DEFAULT_WINDOW_MS = 15 * 60 * 1000; // 15 minutes
const DEFAULT_APP_POSTS_PER_WINDOW = 300;
const DEFAULT_USER_POSTS_PER_WINDOW = 200;

// ─── Sliding Window Implementation ──────────────────────────────────────────

/**
 * A sliding-window rate limiter that tracks request timestamps.
 * More accurate than fixed-window counters at window boundaries.
 */
class SlidingWindowLimiter {
  private timestamps: number[] = [];
  private readonly maxRequests: number;
  private readonly windowMs: number;

  constructor(maxRequests: number, windowMs: number) {
    this.maxRequests = maxRequests;
    this.windowMs = windowMs;
  }

  /**
   * Check if a request is allowed without consuming a slot.
   */
  check(): RateLimitResult {
    this.prune();
    const allowed = this.timestamps.length < this.maxRequests;
    let retryAfterMs = 0;

    if (!allowed && this.timestamps.length > 0) {
      // The oldest timestamp in the window determines when a slot opens
      const oldestInWindow = this.timestamps[0]!;
      retryAfterMs = Math.max(0, oldestInWindow + this.windowMs - Date.now());
    }

    return {
      allowed,
      retryAfterMs,
      currentUsage: this.timestamps.length,
      limit: this.maxRequests,
    };
  }

  /**
   * Attempt to consume a rate limit slot. Returns the result.
   * If allowed, records the request timestamp.
   */
  consume(): RateLimitResult {
    const result = this.check();
    if (result.allowed) {
      this.timestamps.push(Date.now());
      result.currentUsage = this.timestamps.length;
    }
    return result;
  }

  /**
   * Get current usage stats without consuming.
   */
  usage(): { current: number; limit: number; windowMs: number } {
    this.prune();
    return {
      current: this.timestamps.length,
      limit: this.maxRequests,
      windowMs: this.windowMs,
    };
  }

  /**
   * Remove timestamps that have fallen outside the sliding window.
   */
  private prune(): void {
    const cutoff = Date.now() - this.windowMs;
    while (this.timestamps.length > 0 && this.timestamps[0]! < cutoff) {
      this.timestamps.shift();
    }
  }
}

// ─── Rate Limiter Manager ────────────────────────────────────────────────────

/** The shared app-level rate limiter for post creation. */
let appLimiter: SlidingWindowLimiter | null = null;

/** Per-user rate limiters, keyed by accountId. */
const userLimiters = new Map<string, SlidingWindowLimiter>();

/** Current configuration. */
let currentConfig: Required<RateLimitConfig> = {
  appPostsPerWindow: DEFAULT_APP_POSTS_PER_WINDOW,
  userPostsPerWindow: DEFAULT_USER_POSTS_PER_WINDOW,
  windowMs: DEFAULT_WINDOW_MS,
};

/**
 * Initialize the rate limiter with configuration.
 * Call once at plugin startup.
 */
export function initRateLimiter(config?: RateLimitConfig): void {
  currentConfig = {
    appPostsPerWindow: config?.appPostsPerWindow ?? DEFAULT_APP_POSTS_PER_WINDOW,
    userPostsPerWindow: config?.userPostsPerWindow ?? DEFAULT_USER_POSTS_PER_WINDOW,
    windowMs: config?.windowMs ?? DEFAULT_WINDOW_MS,
  };

  appLimiter = new SlidingWindowLimiter(
    currentConfig.appPostsPerWindow,
    currentConfig.windowMs,
  );
}

/**
 * Check if a post creation request is allowed for a given account.
 * Checks both app-level and per-user limits.
 *
 * @returns RateLimitResult with the most restrictive result.
 */
export function checkPostRateLimit(
  accountId: string,
  log?: ChannelLogSink,
): RateLimitResult {
  ensureInitialized();

  // Check app-level limit first (shared across all agents)
  const appResult = appLimiter!.check();
  if (!appResult.allowed) {
    log?.warn?.(
      `[${accountId}] App-level rate limit reached (${appResult.currentUsage}/${appResult.limit}). Retry after ${Math.round(appResult.retryAfterMs / 1000)}s.`,
    );
    return appResult;
  }

  // Check per-user limit
  const userLimiter = getOrCreateUserLimiter(accountId);
  const userResult = userLimiter.check();
  if (!userResult.allowed) {
    log?.warn?.(
      `[${accountId}] Per-user rate limit reached (${userResult.currentUsage}/${userResult.limit}). Retry after ${Math.round(userResult.retryAfterMs / 1000)}s.`,
    );
    return userResult;
  }

  return appResult; // Both passed — return app result (it has the shared context)
}

/**
 * Consume a rate limit slot for a post creation request.
 * Records the request in both app-level and per-user limiters.
 *
 * @returns RateLimitResult. If not allowed, the request should be queued or dropped.
 */
export function consumePostRateLimit(
  accountId: string,
  log?: ChannelLogSink,
): RateLimitResult {
  ensureInitialized();

  // Check first (don't consume if either limit is hit)
  const checkResult = checkPostRateLimit(accountId, log);
  if (!checkResult.allowed) {
    return checkResult;
  }

  // Consume from both limiters
  const appResult = appLimiter!.consume();
  const userLimiter = getOrCreateUserLimiter(accountId);
  const userResult = userLimiter.consume();

  log?.debug?.(
    `[${accountId}] Rate limit consumed. App: ${appResult.currentUsage}/${appResult.limit}, User: ${userResult.currentUsage}/${userResult.limit}.`,
  );

  return appResult;
}

/**
 * Wait until a post creation request is allowed.
 * Returns immediately if allowed, otherwise waits for the retry-after period.
 *
 * @param maxWaitMs Maximum time to wait in milliseconds. Default: 60000 (1 minute).
 * @returns true if the request is now allowed, false if maxWaitMs was exceeded.
 */
export async function waitForPostRateLimit(
  accountId: string,
  log?: ChannelLogSink,
  maxWaitMs: number = 60_000,
): Promise<boolean> {
  const startTime = Date.now();

  while (Date.now() - startTime < maxWaitMs) {
    const result = checkPostRateLimit(accountId, log);
    if (result.allowed) {
      return true;
    }

    const waitTime = Math.min(result.retryAfterMs, maxWaitMs - (Date.now() - startTime));
    if (waitTime <= 0) break;

    log?.debug?.(
      `[${accountId}] Waiting ${Math.round(waitTime / 1000)}s for rate limit to clear...`,
    );
    await sleep(waitTime);
  }

  return false;
}

/**
 * Get current rate limit usage stats for monitoring.
 */
export function getRateLimitStats(accountId?: string): {
  app: { current: number; limit: number; windowMs: number };
  user?: { current: number; limit: number; windowMs: number };
} {
  ensureInitialized();

  const stats: ReturnType<typeof getRateLimitStats> = {
    app: appLimiter!.usage(),
  };

  if (accountId) {
    const userLimiter = userLimiters.get(accountId);
    if (userLimiter) {
      stats.user = userLimiter.usage();
    }
  }

  return stats;
}

/**
 * Reset all rate limiters. Call on shutdown or for testing.
 */
export function resetRateLimiters(): void {
  appLimiter = null;
  userLimiters.clear();
}

// ─── Internal ────────────────────────────────────────────────────────────────

function ensureInitialized(): void {
  if (!appLimiter) {
    initRateLimiter();
  }
}

function getOrCreateUserLimiter(accountId: string): SlidingWindowLimiter {
  let limiter = userLimiters.get(accountId);
  if (!limiter) {
    limiter = new SlidingWindowLimiter(
      currentConfig.userPostsPerWindow,
      currentConfig.windowMs,
    );
    userLimiters.set(accountId, limiter);
  }
  return limiter;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
