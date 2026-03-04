/**
 * X API Client
 *
 * A lightweight, focused client for the X API v2 endpoints needed by the
 * OpenClaw X channel plugin. Handles user-context requests (posting, replying)
 * and app-context requests (usage monitoring).
 *
 * Integrates with:
 * - token-refresh.ts for automatic OAuth 2.0 token rotation
 * - rate-limiter.ts for dual-layer (app + per-user) rate limiting
 *
 * This client uses the native `fetch` API and does not depend on the official
 * xdk-typescript SDK, keeping the dependency footprint minimal.
 */

import type { ChannelLogSink } from "openclaw/plugin-sdk";
import {
  getValidAccessToken,
  type TokenRefreshConfig,
} from "./token-refresh.js";
import {
  consumePostRateLimit,
  waitForPostRateLimit,
} from "./rate-limiter.js";
import {
  buildOAuth1HeaderAsync,
  type OAuth1Credentials,
} from "./oauth1.js";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface XApiClientConfig {
  /**
   * OAuth 2.0 Access Token for user-context requests.
   * Required when authMode is 'oauth2' (default).
   */
  accessToken?: string;
  /**
   * OAuth 1.0a credentials for user-context requests.
   * Required when authMode is 'oauth1'.
   */
  oauth1Credentials?: OAuth1Credentials;
  /**
   * Authentication mode. Defaults to 'oauth2'.
   * Use 'oauth1' when the app has OAuth 1.0a credentials (Consumer Key/Secret).
   */
  authMode?: "oauth1" | "oauth2";
  /** Account ID for rate limiting and token refresh. */
  accountId?: string;
  /** Token refresh configuration. If provided, OAuth 2.0 tokens are auto-refreshed. */
  tokenRefreshConfig?: TokenRefreshConfig;
  /** Optional logger. */
  log?: ChannelLogSink;
  /**
   * Whether to enforce rate limiting before post creation.
   * Default: true.
   */
  rateLimitEnabled?: boolean;
  /**
   * Maximum time (ms) to wait for rate limit to clear before failing.
   * Default: 60000 (1 minute).
   */
  rateLimitMaxWaitMs?: number;
}

export interface CreatePostParams {
  /** The text content of the post. */
  text: string;
  /** If replying, the ID of the post being replied to. */
  inReplyToPostId?: string;
  /** If quoting, the ID of the post being quoted. */
  quotePostId?: string;
}

export interface CreatePostResult {
  ok: boolean;
  postId?: string;
  error?: string;
  /** Whether the request was rate-limited. */
  rateLimited?: boolean;
}

export interface UserLookupResult {
  id: string;
  name: string;
  username: string;
}

export interface UsageResult {
  /** Daily usage data. */
  dailyUsage?: Array<{
    date: string;
    usage: Array<{ bucket: string; value: number }>;
  }>;
}

export interface FetchThreadResult {
  posts: Array<{
    id: string;
    text: string;
    authorId: string;
    authorUsername?: string;
    createdAt?: string;
    conversationId?: string;
  }>;
}

// ─── Constants ───────────────────────────────────────────────────────────────

const X_API_BASE = "https://api.x.com/2";

// ─── Client ──────────────────────────────────────────────────────────────────

export class XApiClient {
  private accessToken: string;
  private authMode: "oauth1" | "oauth2";
  private oauth1Credentials?: OAuth1Credentials;
  private accountId: string;
  private tokenRefreshConfig?: TokenRefreshConfig;
  private log?: ChannelLogSink;
  private rateLimitEnabled: boolean;
  private rateLimitMaxWaitMs: number;

  constructor(config: XApiClientConfig) {
    this.accessToken = config.accessToken ?? "";
    this.authMode = config.authMode ?? (config.oauth1Credentials ? "oauth1" : "oauth2");
    this.oauth1Credentials = config.oauth1Credentials;
    this.accountId = config.accountId ?? "default";
    this.tokenRefreshConfig = config.tokenRefreshConfig;
    this.log = config.log;
    this.rateLimitEnabled = config.rateLimitEnabled ?? true;
    this.rateLimitMaxWaitMs = config.rateLimitMaxWaitMs ?? 60_000;
  }

  /**
   * Get a valid OAuth 2.0 access token, refreshing if necessary.
   * If token refresh is not configured, returns the static token.
   */
  private async resolveAccessToken(): Promise<string> {
    if (this.tokenRefreshConfig) {
      const token = await getValidAccessToken(
        this.accountId,
        this.tokenRefreshConfig,
        this.log,
      );
      this.accessToken = token;
      return token;
    }
    return this.accessToken;
  }

  /**
   * Create a new post or reply.
   *
   * Enforces rate limiting (both app-level and per-user) before sending.
   * If rate-limited, waits up to `rateLimitMaxWaitMs` for a slot to open.
   *
   * Note: As of Feb 23, 2026, replies are only permitted when the replying
   * account was @mentioned or quoted by the original author.
   */
  async createPost(params: CreatePostParams): Promise<CreatePostResult> {
    // ── Rate Limiting ──────────────────────────────────────────────────────
    if (this.rateLimitEnabled) {
      const allowed = await waitForPostRateLimit(
        this.accountId,
        this.log,
        this.rateLimitMaxWaitMs,
      );

      if (!allowed) {
        this.log?.warn?.(
          `[${this.accountId}] Post creation rate-limited. Max wait exceeded.`,
        );
        return {
          ok: false,
          error: "Rate limit exceeded. Try again later.",
          rateLimited: true,
        };
      }

      // Consume a slot from both app and user limiters
      const result = consumePostRateLimit(this.accountId, this.log);
      if (!result.allowed) {
        return {
          ok: false,
          error: `Rate limit reached (${result.currentUsage}/${result.limit}).`,
          rateLimited: true,
        };
      }
    }

    // ── Build Request ──────────────────────────────────────────────────────
    const body: Record<string, unknown> = { text: params.text };

    if (params.inReplyToPostId) {
      body.reply = { in_reply_to_tweet_id: params.inReplyToPostId };
    }

    if (params.quotePostId) {
      body.quote_tweet_id = params.quotePostId;
    }

    try {
      const response = await this.request("POST", "/tweets", body);

      if (response.data?.id) {
        this.log?.info?.(`Post created: ${response.data.id}`);
        return { ok: true, postId: response.data.id as string };
      }

      return { ok: false, error: "No post ID in response." };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log?.error?.(`Failed to create post: ${msg}`);

      // Detect X API rate limit response (HTTP 429)
      if (msg.includes("429")) {
        return { ok: false, error: msg, rateLimited: true };
      }

      return { ok: false, error: msg };
    }
  }

  /**
   * Look up a user by username to get their user ID.
   */
  async getUserByUsername(username: string): Promise<UserLookupResult | null> {
    const cleanUsername = username.replace(/^@/, "");
    try {
      const response = await this.request("GET", `/users/by/username/${cleanUsername}`);
      if (response.data) {
        return {
          id: response.data.id as string,
          name: response.data.name as string,
          username: response.data.username as string,
        };
      }
      return null;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log?.error?.(`Failed to look up user @${cleanUsername}: ${msg}`);
      return null;
    }
  }

  /**
   * Fetch a conversation thread by conversation ID.
   * Uses the search/recent endpoint with conversation_id operator.
   */
  async fetchThread(conversationId: string): Promise<FetchThreadResult> {
    try {
      const query = `conversation_id:${conversationId}`;
      const params = new URLSearchParams({
        query,
        max_results: "100",
        "tweet.fields": "created_at,author_id,conversation_id,referenced_tweets",
        expansions: "author_id",
        "user.fields": "username",
      });

      const response = await this.request("GET", `/tweets/search/recent?${params.toString()}`);

      if (!response.data || !Array.isArray(response.data)) {
        return { posts: [] };
      }

      // Build a username lookup from includes.users
      const userMap = new Map<string, string>();
      if (response.includes?.users && Array.isArray(response.includes.users)) {
        for (const user of response.includes.users as Array<Record<string, string>>) {
          userMap.set(user.id, user.username);
        }
      }

      const posts = (response.data as Array<Record<string, unknown>>).map((tweet) => ({
        id: tweet.id as string,
        text: tweet.text as string,
        authorId: (tweet.author_id as string) ?? "",
        authorUsername: userMap.get(tweet.author_id as string),
        createdAt: tweet.created_at as string | undefined,
        conversationId: tweet.conversation_id as string | undefined,
      }));

      // Sort chronologically
      posts.sort((a, b) => {
        const dateA = a.createdAt ? new Date(a.createdAt).getTime() : 0;
        const dateB = b.createdAt ? new Date(b.createdAt).getTime() : 0;
        return dateA - dateB;
      });

      return { posts };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log?.error?.(`Failed to fetch thread ${conversationId}: ${msg}`);
      return { posts: [] };
    }
  }

  /**
   * Get API usage data for credit monitoring.
   * Uses app-level Bearer Token authentication.
   */
  static async getUsage(bearerToken: string, log?: ChannelLogSink): Promise<UsageResult> {
    try {
      const response = await fetch(`${X_API_BASE}/usage/tweets`, {
        headers: {
          Authorization: `Bearer ${bearerToken}`,
        },
      });

      if (!response.ok) {
        throw new Error(`Usage API error: ${response.status} ${response.statusText}`);
      }

      return (await response.json()) as UsageResult;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log?.error?.(`Failed to get usage data: ${msg}`);
      return {};
    }
  }

  // ─── Internal ────────────────────────────────────────────────────────────

  private async request(
    method: string,
    path: string,
    body?: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const url = path.startsWith("http") ? path : `${X_API_BASE}${path}`;
    const headers: Record<string, string> = {};

    if (this.authMode === "oauth1" && this.oauth1Credentials) {
      // OAuth 1.0a: sign each request with HMAC-SHA1
      // For JSON bodies, we sign only the OAuth params (not the body)
      headers["Authorization"] = await buildOAuth1HeaderAsync(method, url, this.oauth1Credentials);
    } else {
      // OAuth 2.0: Bearer Token (auto-refresh if configured)
      const token = await this.resolveAccessToken();
      headers["Authorization"] = `Bearer ${token}`;
    }

    const options: RequestInit = { method, headers };

    if (body) {
      headers["Content-Type"] = "application/json";
      options.body = JSON.stringify(body);
    }

    const response = await fetch(url, options);

    if (!response.ok) {
      const errorBody = await response.text().catch(() => "");
      throw new Error(`X API ${method} ${path}: ${response.status} ${response.statusText} — ${errorBody}`);
    }

    return (await response.json()) as Record<string, unknown>;
  }
}
