import type { OpenClawConfig } from "openclaw/plugin-sdk";
import type { XAccountCredentials, XChannelConfig } from "./config-schema.js";

/**
 * A fully resolved X agent account with all computed properties.
 * This is the runtime representation of an account after config resolution.
 */
export interface ResolvedXAccount {
  /** Stable account ID (the key in the accounts map). */
  accountId: string;

  /** Friendly display name. */
  name?: string;

  /** Whether this account is enabled. */
  enabled: boolean;

  /** Whether this account has the minimum required credentials. */
  configured: boolean;

  /** The @username of this agent on X (without @). */
  agentUsername: string;

  /** OAuth 2.0 Access Token for user-context requests. */
  accessToken: string;

  /** OAuth 2.0 Refresh Token for obtaining new access tokens. */
  refreshToken?: string;

  /** OAuth 2.0 Client ID (from app-level config, shared across accounts). */
  clientId?: string;

  /** OAuth 2.0 Client Secret (from app-level config, shared across accounts). */
  clientSecret?: string;

  /** OAuth 1.0a Access Token (per-account). */
  oauth1AccessToken?: string;

  /** OAuth 1.0a Access Token Secret (per-account). */
  oauth1AccessTokenSecret?: string;

  /** OAuth 1.0a Consumer Key (app-level, shared across accounts). */
  oauth1ConsumerKey?: string;

  /** OAuth 1.0a Consumer Secret (app-level, shared across accounts). */
  oauth1ConsumerSecret?: string;

  /** Whether this account uses OAuth 1.0a (true) or OAuth 2.0 (false). */
  authMode: "oauth1" | "oauth2";

  /** The X user ID, resolved from username if not provided. */
  userId?: string;

  /** The raw config for this account. */
  config: XAccountCredentials;
}

/**
 * Resolved smart-reply configuration.
 * Only present when `useSmartReply` is true and `smartReply` is configured.
 */
export interface ResolvedSmartReplyConfig {
  enabled: boolean;
  apiKey: string;
  model: string;
  baseUrl: string;
  temperature: number;
  maxTokens: number;
  confidenceThreshold: number;
}

const DEFAULT_ACCOUNT_ID = "default";

/**
 * Extract the raw X channel config from the OpenClaw config.
 */
function getXChannelConfig(cfg: OpenClawConfig): XChannelConfig | undefined {
  const channels = cfg.channels as Record<string, unknown> | undefined;
  return channels?.x as XChannelConfig | undefined;
}

/**
 * List all configured X account IDs.
 */
export function listXAccountIds(cfg: OpenClawConfig): string[] {
  const xCfg = getXChannelConfig(cfg);
  if (!xCfg?.accounts) return [];

  return Object.keys(xCfg.accounts);
}

/**
 * Get the default account ID (first account, or "default").
 */
export function resolveDefaultXAccountId(cfg: OpenClawConfig): string {
  const ids = listXAccountIds(cfg);
  if (ids.includes(DEFAULT_ACCOUNT_ID)) return DEFAULT_ACCOUNT_ID;
  return ids[0] ?? DEFAULT_ACCOUNT_ID;
}

/**
 * Resolve a single X account from the OpenClaw config.
 * Returns a fully hydrated ResolvedXAccount with computed properties.
 */
export function resolveXAccount(opts: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): ResolvedXAccount {
  const accountId = opts.accountId ?? DEFAULT_ACCOUNT_ID;
  const xCfg = getXChannelConfig(opts.cfg);
  const accountCfg = xCfg?.accounts?.[accountId];

  const agentUsername = accountCfg?.agentUsername ?? "";
  const accessToken = accountCfg?.accessToken ?? "";
  const oauth1AccessToken = accountCfg?.oauth1AccessToken ?? "";
  const oauth1AccessTokenSecret = accountCfg?.oauth1AccessTokenSecret ?? "";

  // Determine auth mode: OAuth 1.0a if oauth1 tokens are present, else OAuth 2.0
  const hasOAuth1 = Boolean(oauth1AccessToken.trim() && oauth1AccessTokenSecret.trim());
  const authMode: "oauth1" | "oauth2" = hasOAuth1 ? "oauth1" : "oauth2";

  // An account is configured if it has a username + at least one auth method
  const configured = Boolean(agentUsername.trim() && (accessToken.trim() || hasOAuth1));

  // Client credentials are app-level (shared across all accounts)
  const { clientId, clientSecret } = resolveClientCredentials(opts.cfg);
  const { oauth1ConsumerKey, oauth1ConsumerSecret } = resolveOAuth1AppCredentials(opts.cfg);

  return {
    accountId,
    name: accountCfg?.name?.trim() || undefined,
    enabled: accountCfg?.enabled !== false,
    configured,
    agentUsername,
    accessToken,
    refreshToken: accountCfg?.refreshToken,
    clientId,
    clientSecret,
    oauth1AccessToken: oauth1AccessToken || undefined,
    oauth1AccessTokenSecret: oauth1AccessTokenSecret || undefined,
    oauth1ConsumerKey,
    oauth1ConsumerSecret,
    authMode,
    userId: accountCfg?.userId,
    config: accountCfg ?? { agentUsername: "", enabled: true },
  };
}

/**
 * Resolve the app-level Bearer Token from config.
 * This is used for the Filtered Stream and other app-only endpoints.
 */
export function resolveAppBearerToken(cfg: OpenClawConfig): string | undefined {
  const xCfg = getXChannelConfig(cfg);
  return xCfg?.bearerToken?.trim() || undefined;
}

/**
 * Resolve the OAuth 2.0 client credentials for token refresh.
 */
export function resolveClientCredentials(cfg: OpenClawConfig): {
  clientId?: string;
  clientSecret?: string;
} {
  const xCfg = getXChannelConfig(cfg);
  return {
    clientId: xCfg?.clientId?.trim() || undefined,
    clientSecret: xCfg?.clientSecret?.trim() || undefined,
  };
}

/**
 * Resolve the OAuth 1.0a app-level credentials (Consumer Key + Secret).
 * These are shared across all accounts and used to sign OAuth 1.0a requests.
 */
export function resolveOAuth1AppCredentials(cfg: OpenClawConfig): {
  oauth1ConsumerKey?: string;
  oauth1ConsumerSecret?: string;
} {
  const xCfg = getXChannelConfig(cfg);
  return {
    oauth1ConsumerKey: xCfg?.oauth1ConsumerKey?.trim() || undefined,
    oauth1ConsumerSecret: xCfg?.oauth1ConsumerSecret?.trim() || undefined,
  };
}

/**
 * Resolve the credit budget from config.
 */
export function resolveCreditBudget(cfg: OpenClawConfig): number | undefined {
  const xCfg = getXChannelConfig(cfg);
  return xCfg?.creditBudget;
}

/**
 * Get all enabled and configured agent usernames.
 * Used to build the Filtered Stream rules.
 */
export function getAllAgentUsernames(cfg: OpenClawConfig): string[] {
  const ids = listXAccountIds(cfg);
  const usernames: string[] = [];

  for (const id of ids) {
    const account = resolveXAccount({ cfg, accountId: id });
    if (account.enabled && account.configured && account.agentUsername) {
      usernames.push(account.agentUsername);
    }
  }

  return usernames;
}

/**
 * Resolve the smart-reply pipeline configuration from the X channel config.
 * Returns `undefined` when the feature is disabled or not configured.
 */
export function resolveSmartReplyConfig(cfg: OpenClawConfig): ResolvedSmartReplyConfig | undefined {
  const xCfg = getXChannelConfig(cfg);
  if (!xCfg?.useSmartReply) return undefined;

  const sr = xCfg.smartReply;
  if (!sr?.apiKey) return undefined;

  return {
    enabled: true,
    apiKey: sr.apiKey,
    model: sr.model ?? "grok-2",
    baseUrl: sr.baseUrl ?? "https://api.x.ai/v1",
    temperature: sr.temperature ?? 0.2,
    maxTokens: sr.maxTokens ?? 200,
    confidenceThreshold: sr.confidenceThreshold ?? 0.5,
  };
}

/**
 * Find the account ID that corresponds to a given @username.
 * Used to route incoming mentions to the correct agent.
 */
export function findAccountByUsername(
  cfg: OpenClawConfig,
  username: string,
): ResolvedXAccount | undefined {
  const normalized = username.toLowerCase().replace(/^@/, "");
  const ids = listXAccountIds(cfg);

  for (const id of ids) {
    const account = resolveXAccount({ cfg, accountId: id });
    if (account.agentUsername.toLowerCase() === normalized) {
      return account;
    }
  }

  return undefined;
}
