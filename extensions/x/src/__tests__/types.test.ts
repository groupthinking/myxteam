/**
 * Unit tests for the X channel types and account resolution.
 *
 * Tests config parsing, account resolution, multi-account routing,
 * and helper functions.
 */

import { describe, it, expect } from "vitest";
import type { OpenClawConfig } from "openclaw/plugin-sdk";
import {
  listXAccountIds,
  resolveDefaultXAccountId,
  resolveXAccount,
  resolveAppBearerToken,
  resolveClientCredentials,
  getAllAgentUsernames,
  findAccountByUsername,
} from "../types.js";

/** Helper to build a minimal OpenClaw config with X channel settings. */
function buildConfig(xConfig: Record<string, unknown>): OpenClawConfig {
  return {
    channels: { x: xConfig },
  } as unknown as OpenClawConfig;
}

const MULTI_ACCOUNT_CONFIG = buildConfig({
  bearerToken: "app-bearer-token-123",
  clientId: "client-id-abc",
  clientSecret: "client-secret-xyz",
  accounts: {
    researcher: {
      agentUsername: "ResearchBot",
      accessToken: "access-token-researcher",
      refreshToken: "refresh-token-researcher",
      name: "Research Agent",
      enabled: true,
    },
    writer: {
      agentUsername: "WriterBot",
      accessToken: "access-token-writer",
      name: "Writer Agent",
      enabled: true,
    },
    disabled: {
      agentUsername: "DisabledBot",
      accessToken: "access-token-disabled",
      name: "Disabled Agent",
      enabled: false,
    },
  },
});

const EMPTY_CONFIG = buildConfig({});

describe("types", () => {
  describe("listXAccountIds", () => {
    it("should list all account IDs", () => {
      const ids = listXAccountIds(MULTI_ACCOUNT_CONFIG);
      expect(ids).toEqual(["researcher", "writer", "disabled"]);
    });

    it("should return empty array for empty config", () => {
      const ids = listXAccountIds(EMPTY_CONFIG);
      expect(ids).toEqual([]);
    });

    it("should return empty array for missing channels", () => {
      const ids = listXAccountIds({} as OpenClawConfig);
      expect(ids).toEqual([]);
    });
  });

  describe("resolveDefaultXAccountId", () => {
    it("should return first account ID when no 'default' exists", () => {
      const id = resolveDefaultXAccountId(MULTI_ACCOUNT_CONFIG);
      expect(id).toBe("researcher");
    });

    it("should return 'default' when it exists", () => {
      const cfg = buildConfig({
        accounts: {
          default: { agentUsername: "DefaultBot", accessToken: "token" },
          other: { agentUsername: "OtherBot", accessToken: "token" },
        },
      });
      expect(resolveDefaultXAccountId(cfg)).toBe("default");
    });

    it("should return 'default' for empty config", () => {
      expect(resolveDefaultXAccountId(EMPTY_CONFIG)).toBe("default");
    });
  });

  describe("resolveXAccount", () => {
    it("should resolve a configured account", () => {
      const account = resolveXAccount({
        cfg: MULTI_ACCOUNT_CONFIG,
        accountId: "researcher",
      });
      expect(account.accountId).toBe("researcher");
      expect(account.agentUsername).toBe("ResearchBot");
      expect(account.accessToken).toBe("access-token-researcher");
      expect(account.refreshToken).toBe("refresh-token-researcher");
      expect(account.name).toBe("Research Agent");
      expect(account.enabled).toBe(true);
      expect(account.configured).toBe(true);
    });

    it("should resolve client credentials from app-level config", () => {
      const account = resolveXAccount({
        cfg: MULTI_ACCOUNT_CONFIG,
        accountId: "researcher",
      });
      expect(account.clientId).toBe("client-id-abc");
      expect(account.clientSecret).toBe("client-secret-xyz");
    });

    it("should mark disabled accounts", () => {
      const account = resolveXAccount({
        cfg: MULTI_ACCOUNT_CONFIG,
        accountId: "disabled",
      });
      expect(account.enabled).toBe(false);
      expect(account.configured).toBe(true);
    });

    it("should return unconfigured account for missing ID", () => {
      const account = resolveXAccount({
        cfg: MULTI_ACCOUNT_CONFIG,
        accountId: "nonexistent",
      });
      expect(account.configured).toBe(false);
      expect(account.agentUsername).toBe("");
      expect(account.accessToken).toBe("");
    });

    it("should default to 'default' account when no ID provided", () => {
      const account = resolveXAccount({ cfg: MULTI_ACCOUNT_CONFIG });
      expect(account.accountId).toBe("default");
    });
  });

  describe("resolveAppBearerToken", () => {
    it("should return the bearer token", () => {
      expect(resolveAppBearerToken(MULTI_ACCOUNT_CONFIG)).toBe("app-bearer-token-123");
    });

    it("should return undefined for empty config", () => {
      expect(resolveAppBearerToken(EMPTY_CONFIG)).toBeUndefined();
    });

    it("should trim whitespace", () => {
      const cfg = buildConfig({ bearerToken: "  token-with-spaces  " });
      expect(resolveAppBearerToken(cfg)).toBe("token-with-spaces");
    });
  });

  describe("resolveClientCredentials", () => {
    it("should return client credentials", () => {
      const creds = resolveClientCredentials(MULTI_ACCOUNT_CONFIG);
      expect(creds.clientId).toBe("client-id-abc");
      expect(creds.clientSecret).toBe("client-secret-xyz");
    });

    it("should return undefined for empty config", () => {
      const creds = resolveClientCredentials(EMPTY_CONFIG);
      expect(creds.clientId).toBeUndefined();
      expect(creds.clientSecret).toBeUndefined();
    });
  });

  describe("getAllAgentUsernames", () => {
    it("should return only enabled and configured usernames", () => {
      const usernames = getAllAgentUsernames(MULTI_ACCOUNT_CONFIG);
      expect(usernames).toEqual(["ResearchBot", "WriterBot"]);
      // "DisabledBot" should be excluded
      expect(usernames).not.toContain("DisabledBot");
    });

    it("should return empty array for empty config", () => {
      expect(getAllAgentUsernames(EMPTY_CONFIG)).toEqual([]);
    });
  });

  describe("findAccountByUsername", () => {
    it("should find account by exact username", () => {
      const account = findAccountByUsername(MULTI_ACCOUNT_CONFIG, "ResearchBot");
      expect(account).toBeDefined();
      expect(account?.accountId).toBe("researcher");
    });

    it("should find account case-insensitively", () => {
      const account = findAccountByUsername(MULTI_ACCOUNT_CONFIG, "researchbot");
      expect(account).toBeDefined();
      expect(account?.accountId).toBe("researcher");
    });

    it("should strip @ prefix", () => {
      const account = findAccountByUsername(MULTI_ACCOUNT_CONFIG, "@WriterBot");
      expect(account).toBeDefined();
      expect(account?.accountId).toBe("writer");
    });

    it("should return undefined for unknown username", () => {
      const account = findAccountByUsername(MULTI_ACCOUNT_CONFIG, "UnknownBot");
      expect(account).toBeUndefined();
    });
  });
});
