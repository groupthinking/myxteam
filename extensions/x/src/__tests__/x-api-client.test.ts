/**
 * Unit tests for the X API client.
 *
 * Tests post creation, user lookup, thread fetching, and
 * integration with rate limiting and token refresh.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { initRateLimiter, resetRateLimiters, consumePostRateLimit } from "../rate-limiter.js";
import { XApiClient } from "../x-api-client.js";

// Mock fetch
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

describe("XApiClient", () => {
  beforeEach(() => {
    mockFetch.mockReset();
    resetRateLimiters();
    initRateLimiter({ appPostsPerWindow: 100, userPostsPerWindow: 50 });
  });

  afterEach(() => {
    resetRateLimiters();
    vi.restoreAllMocks();
  });

  describe("createPost", () => {
    it("should create a post successfully", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: { id: "post-123" } }),
      });

      const client = new XApiClient({
        accessToken: "test-token",
        accountId: "agent-1",
        rateLimitEnabled: true,
      });

      const result = await client.createPost({ text: "Hello from agent!" });
      expect(result.ok).toBe(true);
      expect(result.postId).toBe("post-123");
    });

    it("should create a reply with in_reply_to_tweet_id", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: { id: "reply-456" } }),
      });

      const client = new XApiClient({
        accessToken: "test-token",
        accountId: "agent-1",
        rateLimitEnabled: true,
      });

      const result = await client.createPost({
        text: "This is a reply",
        inReplyToPostId: "original-789",
      });

      expect(result.ok).toBe(true);

      // Verify the request body includes reply context
      const [, opts] = mockFetch.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(opts.body as string);
      expect(body.reply.in_reply_to_tweet_id).toBe("original-789");
    });

    it("should return rate-limited result when limit is exceeded", async () => {
      resetRateLimiters();
      initRateLimiter({ appPostsPerWindow: 1, userPostsPerWindow: 10 });

      // Consume the only available slot
      consumePostRateLimit("agent-1");

      const client = new XApiClient({
        accessToken: "test-token",
        accountId: "agent-1",
        rateLimitEnabled: true,
        rateLimitMaxWaitMs: 100, // Short wait to avoid test timeout
      });

      const result = await client.createPost({ text: "Should be rate-limited" });
      expect(result.ok).toBe(false);
      expect(result.rateLimited).toBe(true);
    });

    it("should skip rate limiting when disabled", async () => {
      resetRateLimiters();
      initRateLimiter({ appPostsPerWindow: 1 });
      consumePostRateLimit("agent-1");

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: { id: "post-999" } }),
      });

      const client = new XApiClient({
        accessToken: "test-token",
        accountId: "agent-1",
        rateLimitEnabled: false,
      });

      const result = await client.createPost({ text: "No rate limit" });
      expect(result.ok).toBe(true);
    });

    it("should handle API errors gracefully", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 403,
        statusText: "Forbidden",
        text: async () => "Not authorized to reply",
      });

      const client = new XApiClient({
        accessToken: "test-token",
        accountId: "agent-1",
        rateLimitEnabled: true,
      });

      const result = await client.createPost({ text: "Forbidden reply" });
      expect(result.ok).toBe(false);
      expect(result.error).toContain("403");
    });

    it("should detect HTTP 429 as rate-limited", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 429,
        statusText: "Too Many Requests",
        text: async () => "Rate limit exceeded",
      });

      const client = new XApiClient({
        accessToken: "test-token",
        accountId: "agent-1",
        rateLimitEnabled: true,
      });

      const result = await client.createPost({ text: "Too fast" });
      expect(result.ok).toBe(false);
      expect(result.rateLimited).toBe(true);
    });
  });

  describe("getUserByUsername", () => {
    it("should look up a user by username", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: { id: "user-123", name: "Test User", username: "testuser" },
        }),
      });

      const client = new XApiClient({ accessToken: "test-token" });
      const user = await client.getUserByUsername("testuser");

      expect(user).toEqual({
        id: "user-123",
        name: "Test User",
        username: "testuser",
      });
    });

    it("should strip @ prefix from username", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: { id: "user-123", name: "Test User", username: "testuser" },
        }),
      });

      const client = new XApiClient({ accessToken: "test-token" });
      await client.getUserByUsername("@testuser");

      const [url] = mockFetch.mock.calls[0] as [string];
      expect(url).toContain("/users/by/username/testuser");
      expect(url).not.toContain("@");
    });

    it("should return null for non-existent user", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: null }),
      });

      const client = new XApiClient({ accessToken: "test-token" });
      const user = await client.getUserByUsername("nonexistent");
      expect(user).toBeNull();
    });
  });

  describe("fetchThread", () => {
    it("should fetch and sort thread posts chronologically", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: [
            {
              id: "post-2",
              text: "Second post",
              author_id: "user-a",
              created_at: "2026-03-01T12:01:00Z",
              conversation_id: "1234567890",
            },
            {
              id: "post-1",
              text: "First post",
              author_id: "user-b",
              created_at: "2026-03-01T12:00:00Z",
              conversation_id: "1234567890",
            },
          ],
          includes: {
            users: [
              { id: "user-a", username: "alice" },
              { id: "user-b", username: "bob" },
            ],
          },
        }),
      });

      const client = new XApiClient({ accessToken: "test-token" });
      const thread = await client.fetchThread("1234567890");

      expect(thread.posts).toHaveLength(2);
      // Should be sorted chronologically
      expect(thread.posts[0]!.id).toBe("post-1");
      expect(thread.posts[1]!.id).toBe("post-2");
      // Should resolve usernames
      expect(thread.posts[0]!.authorUsername).toBe("bob");
      expect(thread.posts[1]!.authorUsername).toBe("alice");
    });

    it("should return empty posts for missing data", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({}),
      });

      const client = new XApiClient({ accessToken: "test-token" });
      const thread = await client.fetchThread("9999999999");
      expect(thread.posts).toEqual([]);
    });
  });

  describe("getUsage (static)", () => {
    it("should fetch usage data with bearer token", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          dailyUsage: [{ date: "2026-03-01", usage: [{ bucket: "tweets", value: 42 }] }],
        }),
      });

      const usage = await XApiClient.getUsage("bearer-token-123");
      expect(usage.dailyUsage).toHaveLength(1);

      const [url, opts] = mockFetch.mock.calls[0] as [string, RequestInit];
      expect(url).toContain("/usage/tweets");
      expect((opts.headers as Record<string, string>)["Authorization"]).toBe(
        "Bearer bearer-token-123",
      );
    });
  });
});
