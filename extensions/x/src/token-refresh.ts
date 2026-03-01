/**
 * OAuth 2.0 Token Refresh for X API
 *
 * Manages automatic refresh of OAuth 2.0 access tokens for agent accounts.
 * When an access token expires, this module uses the stored refresh token
 * and the app's client credentials to obtain a new access token.
 *
 * X API access tokens expire after 2 hours. Refresh tokens are long-lived
 * but are rotated on each use (the response includes a new refresh token).
 *
 * Reference: https://docs.x.com/fundamentals/authentication/oauth-2-0/user-access-token
 */

import type { ChannelLogSink } from "openclaw/plugin-sdk";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface TokenRefreshConfig {
  /** OAuth 2.0 Client ID from the X Developer Portal. */
  clientId: string;
  /** OAuth 2.0 Client Secret (for confidential clients). */
  clientSecret?: string;
}

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  /** Unix timestamp (ms) when the access token expires. */
  expiresAt: number;
}

export interface TokenRefreshResult {
  ok: boolean;
  tokens?: TokenPair;
  error?: string;
}

/** Callback invoked when tokens are refreshed, so the caller can persist them. */
export type OnTokenRefreshed = (
  accountId: string,
  tokens: TokenPair,
) => void | Promise<void>;

// ─── Constants ───────────────────────────────────────────────────────────────

const TOKEN_ENDPOINT = "https://api.x.com/2/oauth2/token";

/**
 * Refresh the token 5 minutes before it actually expires,
 * to avoid race conditions during API calls.
 */
const REFRESH_BUFFER_MS = 5 * 60 * 1000;

// ─── Token Store ─────────────────────────────────────────────────────────────

/** In-memory token cache, keyed by accountId. */
const tokenCache = new Map<string, TokenPair>();

/** Active refresh timers, keyed by accountId. */
const refreshTimers = new Map<string, ReturnType<typeof setTimeout>>();

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Initialize token management for an account.
 * Stores the initial tokens and schedules automatic refresh.
 */
export function initTokens(
  accountId: string,
  accessToken: string,
  refreshToken: string,
  config: TokenRefreshConfig,
  opts?: {
    log?: ChannelLogSink;
    onRefreshed?: OnTokenRefreshed;
    /** Token lifetime in seconds. Defaults to 7200 (2 hours per X API). */
    expiresInSeconds?: number;
  },
): void {
  const expiresIn = opts?.expiresInSeconds ?? 7200;
  const tokens: TokenPair = {
    accessToken,
    refreshToken,
    expiresAt: Date.now() + expiresIn * 1000,
  };

  tokenCache.set(accountId, tokens);
  scheduleRefresh(accountId, tokens, config, opts?.log, opts?.onRefreshed);

  opts?.log?.info?.(
    `[${accountId}] Token initialized. Expires at ${new Date(tokens.expiresAt).toISOString()}.`,
  );
}

/**
 * Get the current valid access token for an account.
 * If the token is expired or about to expire, refreshes it first.
 */
export async function getValidAccessToken(
  accountId: string,
  config: TokenRefreshConfig,
  log?: ChannelLogSink,
  onRefreshed?: OnTokenRefreshed,
): Promise<string> {
  const cached = tokenCache.get(accountId);

  if (!cached) {
    throw new Error(`No tokens stored for account ${accountId}. Call initTokens() first.`);
  }

  // If token is still valid (with buffer), return it
  if (Date.now() < cached.expiresAt - REFRESH_BUFFER_MS) {
    return cached.accessToken;
  }

  // Token is expired or about to expire — refresh now
  log?.info?.(`[${accountId}] Access token expired or expiring soon. Refreshing...`);
  const result = await refreshAccessToken(accountId, cached.refreshToken, config, log);

  if (!result.ok || !result.tokens) {
    throw new Error(`Token refresh failed for account ${accountId}: ${result.error}`);
  }

  // Store new tokens
  tokenCache.set(accountId, result.tokens);
  scheduleRefresh(accountId, result.tokens, config, log, onRefreshed);

  // Notify caller so they can persist the new tokens
  await onRefreshed?.(accountId, result.tokens);

  return result.tokens.accessToken;
}

/**
 * Stop token management for an account.
 * Clears the cached tokens and cancels any scheduled refresh.
 */
export function clearTokens(accountId: string): void {
  tokenCache.delete(accountId);
  const timer = refreshTimers.get(accountId);
  if (timer) {
    clearTimeout(timer);
    refreshTimers.delete(accountId);
  }
}

/**
 * Stop all token management. Call on shutdown.
 */
export function clearAllTokens(): void {
  for (const [accountId] of tokenCache) {
    clearTokens(accountId);
  }
}

/**
 * Check if an account has tokens stored.
 */
export function hasTokens(accountId: string): boolean {
  return tokenCache.has(accountId);
}

// ─── Internal ────────────────────────────────────────────────────────────────

/**
 * Perform the actual token refresh against the X API token endpoint.
 *
 * X API uses the standard OAuth 2.0 refresh token grant:
 * POST /2/oauth2/token
 * Content-Type: application/x-www-form-urlencoded
 * Authorization: Basic base64(client_id:client_secret)
 *
 * Body: grant_type=refresh_token&refresh_token=<token>
 *
 * The response includes a new access_token AND a new refresh_token
 * (refresh token rotation).
 */
async function refreshAccessToken(
  accountId: string,
  refreshToken: string,
  config: TokenRefreshConfig,
  log?: ChannelLogSink,
): Promise<TokenRefreshResult> {
  try {
    const headers: Record<string, string> = {
      "Content-Type": "application/x-www-form-urlencoded",
    };

    // Use Basic auth if client_secret is available (confidential client)
    if (config.clientSecret) {
      const credentials = Buffer.from(
        `${config.clientId}:${config.clientSecret}`,
      ).toString("base64");
      headers["Authorization"] = `Basic ${credentials}`;
    }

    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: config.clientId,
    });

    const response = await fetch(TOKEN_ENDPOINT, {
      method: "POST",
      headers,
      body: body.toString(),
    });

    if (!response.ok) {
      const errorBody = await response.text().catch(() => "");
      log?.error?.(
        `[${accountId}] Token refresh HTTP error: ${response.status} ${response.statusText} — ${errorBody}`,
      );
      return { ok: false, error: `HTTP ${response.status}: ${errorBody}` };
    }

    const data = (await response.json()) as {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
      token_type?: string;
    };

    if (!data.access_token || !data.refresh_token) {
      log?.error?.(`[${accountId}] Token refresh response missing tokens.`);
      return { ok: false, error: "Response missing access_token or refresh_token." };
    }

    const expiresIn = data.expires_in ?? 7200;
    const tokens: TokenPair = {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresAt: Date.now() + expiresIn * 1000,
    };

    log?.info?.(
      `[${accountId}] Token refreshed successfully. New expiry: ${new Date(tokens.expiresAt).toISOString()}.`,
    );

    return { ok: true, tokens };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log?.error?.(`[${accountId}] Token refresh error: ${msg}`);
    return { ok: false, error: msg };
  }
}

/**
 * Schedule an automatic token refresh before the current token expires.
 */
function scheduleRefresh(
  accountId: string,
  tokens: TokenPair,
  config: TokenRefreshConfig,
  log?: ChannelLogSink,
  onRefreshed?: OnTokenRefreshed,
): void {
  // Clear any existing timer
  const existing = refreshTimers.get(accountId);
  if (existing) clearTimeout(existing);

  // Schedule refresh REFRESH_BUFFER_MS before expiry
  const delay = Math.max(0, tokens.expiresAt - Date.now() - REFRESH_BUFFER_MS);

  const timer = setTimeout(async () => {
    try {
      log?.debug?.(`[${accountId}] Scheduled token refresh triggered.`);
      const result = await refreshAccessToken(
        accountId,
        tokens.refreshToken,
        config,
        log,
      );

      if (result.ok && result.tokens) {
        tokenCache.set(accountId, result.tokens);
        scheduleRefresh(accountId, result.tokens, config, log, onRefreshed);
        await onRefreshed?.(accountId, result.tokens);
      } else {
        log?.error?.(
          `[${accountId}] Scheduled token refresh failed: ${result.error}. Will retry on next API call.`,
        );
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log?.error?.(`[${accountId}] Scheduled token refresh error: ${msg}`);
    }
  }, delay);

  refreshTimers.set(accountId, timer);

  log?.debug?.(
    `[${accountId}] Token refresh scheduled in ${Math.round(delay / 1000)}s.`,
  );
}
