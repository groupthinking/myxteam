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

  /** The X user ID, resolved from username if not provided. */
  userId?: string;

  /** The raw config for this account. */
  config: XAccountCredentials;
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

  const ids = Object.keys(xCfg.accounts);
  return ids.length > 0 ? ids : [];
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
  const configured = Boolean(agentUsername.trim() && accessToken.trim());

  return {
    accountId,
    name: accountCfg?.name?.trim() || undefined,
    enabled: accountCfg?.enabled !== false,
    configured,
    agentUsername,
    accessToken,
    refreshToken: accountCfg?.refreshToken,
    userId: accountCfg?.userId,
    config: accountCfg ?? { agentUsername: "" },
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
