/**
 * Unit tests for the X channel OAuth 2.0 token refresh module.
 *
 * Tests token initialization, expiry detection, refresh scheduling,
 * and error handling.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  initTokens,
  getValidAccessToken,
  clearTokens,
  clearAllTokens,
  hasTokens,
  type TokenRefreshConfig,
} from "../token-refresh.js";

// Mock fetch for token refresh requests
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

const TEST_CONFIG: TokenRefreshConfig = {
  clientId: "test-client-id",
  clientSecret: "test-client-secret",
};

describe("token-refresh", () => {
  beforeEach(() => {
    clearAllTokens();
    vi.useFakeTimers();
    mockFetch.mockReset();
  });

  afterEach(() => {
    clearAllTokens();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe("initTokens", () => {
    it("should store tokens for an account", () => {
      initTokens("agent-1", "access-123", "refresh-456", TEST_CONFIG);
      expect(hasTokens("agent-1")).toBe(true);
    });

    it("should not store tokens for unknown accounts before init", () => {
      expect(hasTokens("agent-unknown")).toBe(false);
    });
  });

  describe("getValidAccessToken", () => {
    it("should return the stored access token when not expired", async () => {
      initTokens("agent-1", "access-123", "refresh-456", TEST_CONFIG, {
        expiresInSeconds: 7200,
      });

      const token = await getValidAccessToken("agent-1", TEST_CONFIG);
      expect(token).toBe("access-123");
    });

    it("should throw if no tokens are stored", async () => {
      await expect(getValidAccessToken("agent-unknown", TEST_CONFIG)).rejects.toThrow(
        "No tokens stored for account agent-unknown",
      );
    });

    it("should refresh token when expired", async () => {
      // Mock the refresh endpoint — the scheduled timer fires immediately
      // (delay = 0) when we advance past expiry, so we need a response ready
      // before calling advanceTimersByTime.
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({
          access_token: "new-access",
          refresh_token: "new-refresh",
          expires_in: 7200,
          token_type: "bearer",
        }),
      });

      // Initialize with a very short expiry
      initTokens("agent-1", "old-access", "old-refresh", TEST_CONFIG, {
        expiresInSeconds: 1, // 1 second
      });

      // Advance time past expiry + buffer.
      // This fires the scheduled refresh (delay = 0 because token already
      // expired past the 5-min buffer), which consumes one fetch call.
      await vi.advanceTimersByTimeAsync(7 * 60 * 1000); // 7 minutes

      // Capture the scheduled-refresh call before clearing so we can
      // assert on its shape (URL, method, headers, body).
      const scheduledCall = mockFetch.mock.calls[0] as [string, RequestInit];
      mockFetch.mockClear();

      // The scheduled refresh already updated the cache, so
      // getValidAccessToken should return the cached token without
      // making another network call.
      const token = await getValidAccessToken("agent-1", TEST_CONFIG);
      expect(token).toBe("new-access");

      // The cached token was returned — no additional fetch needed.
      expect(mockFetch).not.toHaveBeenCalled();

      // Verify the scheduled refresh request was formed correctly.
      const [url, opts] = scheduledCall;
      expect(url).toBe("https://api.x.com/2/oauth2/token");
      expect(opts.method).toBe("POST");
      expect(opts.headers).toHaveProperty("Authorization");
      expect(opts.body).toContain("grant_type=refresh_token");
      expect(opts.body).toContain("refresh_token=old-refresh");
    });

    it("should throw when refresh fails", async () => {
      // Provide a failing mock before init so the scheduled timer
      // (which fires at delay=0) also gets a response.
      mockFetch.mockResolvedValue({
        ok: false,
        status: 401,
        statusText: "Unauthorized",
        text: async () => "Invalid refresh token",
      });

      initTokens("agent-1", "old-access", "old-refresh", TEST_CONFIG, {
        expiresInSeconds: 1,
      });

      await vi.advanceTimersByTimeAsync(7 * 60 * 1000);

      await expect(getValidAccessToken("agent-1", TEST_CONFIG)).rejects.toThrow(
        "Token refresh failed",
      );
    });
  });

  describe("clearTokens", () => {
    it("should remove tokens for a specific account", () => {
      initTokens("agent-1", "access-1", "refresh-1", TEST_CONFIG);
      initTokens("agent-2", "access-2", "refresh-2", TEST_CONFIG);

      clearTokens("agent-1");

      expect(hasTokens("agent-1")).toBe(false);
      expect(hasTokens("agent-2")).toBe(true);
    });
  });

  describe("clearAllTokens", () => {
    it("should remove all stored tokens", () => {
      initTokens("agent-1", "access-1", "refresh-1", TEST_CONFIG);
      initTokens("agent-2", "access-2", "refresh-2", TEST_CONFIG);

      clearAllTokens();

      expect(hasTokens("agent-1")).toBe(false);
      expect(hasTokens("agent-2")).toBe(false);
    });
  });

  describe("Basic auth encoding", () => {
    it("should send Basic auth header with client credentials", async () => {
      // Provide a mock before init so the scheduled timer (delay=0) gets a response.
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({
          access_token: "new-access",
          refresh_token: "new-refresh",
          expires_in: 7200,
        }),
      });

      initTokens("agent-1", "old-access", "old-refresh", TEST_CONFIG, {
        expiresInSeconds: 1,
      });

      await vi.advanceTimersByTimeAsync(7 * 60 * 1000);

      // The scheduled refresh already fired; verify the first call's auth header.
      const [, opts] = mockFetch.mock.calls[0] as [string, RequestInit];
      const authHeader = (opts.headers as Record<string, string>)["Authorization"];
      const expectedCredentials = Buffer.from(
        `${TEST_CONFIG.clientId}:${TEST_CONFIG.clientSecret}`,
      ).toString("base64");
      expect(authHeader).toBe(`Basic ${expectedCredentials}`);
    });
  });
});
