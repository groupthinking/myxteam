import { z } from "zod";

/**
 * Schema for a single X agent account's OAuth credentials and settings.
 * Each account represents one agent identity on X.
 */
export const XAccountCredentialsSchema = z.object({
  /** Whether this agent account is active. */
  enabled: z.boolean().optional().default(true),

  /** A friendly display name for this agent (e.g., "Research Agent"). */
  name: z.string().optional(),

  /** The @username of this agent on X (without the @ prefix). */
  agentUsername: z.string().describe("The @username of this agent on X."),

  /**
   * OAuth 2.0 Access Token for user-context requests (posting, replying).
   * Obtained via the OAuth 2.0 Authorization Code Flow with PKCE.
   * Mutually exclusive with oauth1AccessToken — use one or the other.
   */
  accessToken: z.string().optional(),

  /**
   * OAuth 2.0 Refresh Token for obtaining new access tokens.
   * Only available when the `offline.access` scope was requested.
   */
  refreshToken: z.string().optional(),

  /**
   * OAuth 1.0a Access Token for user-context requests.
   * Use this when the app is configured with OAuth 1.0a (Consumer Key/Secret).
   * The corresponding secret must be provided in oauth1AccessTokenSecret.
   */
  oauth1AccessToken: z.string().optional(),

  /**
   * OAuth 1.0a Access Token Secret.
   * Required when oauth1AccessToken is set.
   */
  oauth1AccessTokenSecret: z.string().optional(),

  /**
   * The X user ID associated with this agent account.
   * Used for efficient mention lookups. If not provided, it will be
   * resolved from the agentUsername on first connection.
   */
  userId: z.string().optional(),
});

export type XAccountCredentials = z.infer<typeof XAccountCredentialsSchema>;

/**
 * Top-level schema for the `channels.x` configuration block.
 * Supports a single-app, multi-account architecture where one registered
 * X app manages multiple agent accounts via OAuth 2.0 tokens.
 */
export const XChannelConfigSchema = z.object({
  /** Whether the X channel is globally enabled. */
  enabled: z.boolean().optional().default(true),

  /**
   * App-level Bearer Token for app-only authentication.
   * Used for the Filtered Stream connection and other read-only endpoints
   * that don't require user context.
   */
  bearerToken: z.string().optional().describe("App-level Bearer Token for Filtered Stream."),

  /**
   * OAuth 2.0 Client ID for the registered X app.
   * Required for token refresh flows.
   */
  clientId: z.string().optional().describe("OAuth 2.0 Client ID for token refresh."),

  /**
   * OAuth 2.0 Client Secret for the registered X app.
   * Required for confidential client token refresh flows.
   */
  clientSecret: z.string().optional().describe("OAuth 2.0 Client Secret."),

  /**
   * OAuth 1.0a Consumer Key (also called API Key) for the registered X app.
   * Required when using OAuth 1.0a authentication for posting.
   * Found in the X Developer Portal under "Keys and Tokens".
   */
  oauth1ConsumerKey: z.string().optional().describe("OAuth 1.0a Consumer Key (API Key)."),

  /**
   * OAuth 1.0a Consumer Secret (also called API Secret) for the registered X app.
   * Required when using OAuth 1.0a authentication for posting.
   */
  oauth1ConsumerSecret: z.string().optional().describe("OAuth 1.0a Consumer Secret (API Secret)."),

  /**
   * Monthly credit budget (in dollars or credits) to prevent over-spending.
   * When the budget is reached, the plugin will stop making API calls and
   * alert the operator. Set to 0 or omit to disable budget enforcement.
   */
  creditBudget: z.number().optional().describe("Monthly credit budget limit."),

  /**
   * How often (in minutes) to check credit usage via the Usage API.
   * Defaults to 60 minutes.
   */
  usageCheckIntervalMinutes: z.number().optional().default(60),

  /**
   * Map of agent account configurations, keyed by a stable account ID.
   * Each entry represents one agent identity on X.
   *
   * Example:
   * ```yaml
   * accounts:
   *   research-agent:
   *     agentUsername: "ResearchAgent"
   *     accessToken: "..."
   *   writer-agent:
   *     agentUsername: "WriterAgent"
   *     accessToken: "..."
   * ```
   */
  accounts: z.record(z.string(), XAccountCredentialsSchema).optional().default({}),
});

export type XChannelConfig = z.infer<typeof XChannelConfigSchema>;
