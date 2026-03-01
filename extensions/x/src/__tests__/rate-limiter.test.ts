/**
 * Unit tests for the X channel rate limiter.
 *
 * Tests the sliding-window token bucket algorithm, dual-layer
 * (app + per-user) rate limiting, and the wait/retry logic.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  initRateLimiter,
  checkPostRateLimit,
  consumePostRateLimit,
  waitForPostRateLimit,
  getRateLimitStats,
  resetRateLimiters,
} from "../rate-limiter.js";

describe("rate-limiter", () => {
  beforeEach(() => {
    resetRateLimiters();
  });

  afterEach(() => {
    resetRateLimiters();
  });

  describe("initRateLimiter", () => {
    it("should initialize with default config", () => {
      initRateLimiter();
      const stats = getRateLimitStats();
      expect(stats.app.limit).toBe(300);
      expect(stats.app.current).toBe(0);
    });

    it("should initialize with custom config", () => {
      initRateLimiter({
        appPostsPerWindow: 50,
        userPostsPerWindow: 10,
        windowMs: 60_000,
      });
      const stats = getRateLimitStats();
      expect(stats.app.limit).toBe(50);
    });
  });

  describe("checkPostRateLimit", () => {
    it("should allow requests when under limit", () => {
      initRateLimiter({ appPostsPerWindow: 10, userPostsPerWindow: 5 });
      const result = checkPostRateLimit("agent-1");
      expect(result.allowed).toBe(true);
      expect(result.currentUsage).toBe(0);
    });
  });

  describe("consumePostRateLimit", () => {
    it("should consume a slot and increment usage", () => {
      initRateLimiter({ appPostsPerWindow: 10, userPostsPerWindow: 5 });

      const result1 = consumePostRateLimit("agent-1");
      expect(result1.allowed).toBe(true);
      expect(result1.currentUsage).toBe(1);

      const result2 = consumePostRateLimit("agent-1");
      expect(result2.allowed).toBe(true);
      expect(result2.currentUsage).toBe(2);
    });

    it("should block when app-level limit is reached", () => {
      initRateLimiter({ appPostsPerWindow: 3, userPostsPerWindow: 10 });

      consumePostRateLimit("agent-1");
      consumePostRateLimit("agent-1");
      consumePostRateLimit("agent-1");

      const result = consumePostRateLimit("agent-1");
      expect(result.allowed).toBe(false);
      expect(result.retryAfterMs).toBeGreaterThan(0);
    });

    it("should block when per-user limit is reached", () => {
      initRateLimiter({ appPostsPerWindow: 100, userPostsPerWindow: 2 });

      consumePostRateLimit("agent-1");
      consumePostRateLimit("agent-1");

      const result = consumePostRateLimit("agent-1");
      expect(result.allowed).toBe(false);
    });

    it("should track per-user limits independently", () => {
      initRateLimiter({ appPostsPerWindow: 100, userPostsPerWindow: 2 });

      consumePostRateLimit("agent-1");
      consumePostRateLimit("agent-1");

      // agent-1 is at limit, but agent-2 should still be allowed
      const result1 = consumePostRateLimit("agent-1");
      expect(result1.allowed).toBe(false);

      const result2 = consumePostRateLimit("agent-2");
      expect(result2.allowed).toBe(true);
    });

    it("should share app-level limit across all agents", () => {
      initRateLimiter({ appPostsPerWindow: 3, userPostsPerWindow: 10 });

      consumePostRateLimit("agent-1");
      consumePostRateLimit("agent-2");
      consumePostRateLimit("agent-3");

      // App limit reached (3 total across agents)
      const result = consumePostRateLimit("agent-4");
      expect(result.allowed).toBe(false);
    });
  });

  describe("getRateLimitStats", () => {
    it("should return app stats without accountId", () => {
      initRateLimiter({ appPostsPerWindow: 10 });
      consumePostRateLimit("agent-1");

      const stats = getRateLimitStats();
      expect(stats.app.current).toBe(1);
      expect(stats.app.limit).toBe(10);
      expect(stats.user).toBeUndefined();
    });

    it("should return both app and user stats with accountId", () => {
      initRateLimiter({ appPostsPerWindow: 10, userPostsPerWindow: 5 });
      consumePostRateLimit("agent-1");
      consumePostRateLimit("agent-1");

      const stats = getRateLimitStats("agent-1");
      expect(stats.app.current).toBe(2);
      expect(stats.user?.current).toBe(2);
      expect(stats.user?.limit).toBe(5);
    });
  });

  describe("waitForPostRateLimit", () => {
    it("should return true immediately when under limit", async () => {
      initRateLimiter({ appPostsPerWindow: 10 });
      const result = await waitForPostRateLimit("agent-1", undefined, 1000);
      expect(result).toBe(true);
    });

    it("should return false when maxWaitMs is exceeded", async () => {
      initRateLimiter({ appPostsPerWindow: 1, windowMs: 60_000 });
      consumePostRateLimit("agent-1");

      // Should time out quickly since window is 60s but maxWait is 100ms
      const result = await waitForPostRateLimit("agent-1", undefined, 100);
      expect(result).toBe(false);
    });
  });

  describe("resetRateLimiters", () => {
    it("should clear all state", () => {
      initRateLimiter({ appPostsPerWindow: 2 });
      consumePostRateLimit("agent-1");
      consumePostRateLimit("agent-1");

      resetRateLimiters();
      initRateLimiter({ appPostsPerWindow: 2 });

      const result = consumePostRateLimit("agent-1");
      expect(result.allowed).toBe(true);
      expect(result.currentUsage).toBe(1);
    });
  });
});
