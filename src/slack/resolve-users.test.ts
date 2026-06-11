import { describe, expect, it, vi } from "vitest";
import { resolveSlackUserAllowlist } from "./resolve-users.js";

// Mock the client creation to avoid needing @slack/web-api
vi.mock("./client.js", () => ({
  createSlackWebClient: vi.fn(),
}));

describe("resolveSlackUserAllowlist", () => {
  const mockUsers = [
    {
      id: "U1",
      name: "alice",
      displayName: "Alice",
      realName: "Alice Smith",
      email: "alice@example.com",
      deleted: false,
      isBot: false,
      isAppUser: false,
    },
    {
      id: "U2",
      name: "bob",
      displayName: "Bobby",
      realName: "Bob Jones",
      email: "bob@example.com",
      deleted: false,
      isBot: false,
      isAppUser: false,
    },
    {
      id: "U3",
      name: "bot",
      deleted: false,
      isBot: true,
      isAppUser: false,
    },
    {
        id: "U4",
        name: "alice.archived",
        displayName: "Alice",
        deleted: true,
        isBot: false,
        isAppUser: false,
    }
  ];

  const mockClient = {
    users: {
      list: vi.fn().mockResolvedValue({
        members: [
          {
            id: "U1",
            name: "alice",
            deleted: false,
            is_bot: false,
            is_app_user: false,
            real_name: "Alice Smith",
            profile: { display_name: "Alice", email: "alice@example.com" },
          },
          {
            id: "U2",
            name: "bob",
            deleted: false,
            is_bot: false,
            is_app_user: false,
            real_name: "Bob Jones",
            profile: { display_name: "Bobby", email: "bob@example.com" },
          },
          {
            id: "U3",
            name: "bot",
            deleted: false,
            is_bot: true,
            is_app_user: false,
          },
          {
            id: "U4",
            name: "alice.archived",
            deleted: true,
            is_bot: false,
            is_app_user: false,
            profile: { display_name: "Alice" },
          }
        ],
      }),
    },
  };

  it("resolves by ID mention", async () => {
    const res = await resolveSlackUserAllowlist({
      token: "test",
      entries: ["<@U1>"],
      client: mockClient as any,
    });
    expect(res).toHaveLength(1);
    expect(res[0]).toMatchObject({
      input: "<@U1>",
      resolved: true,
      id: "U1",
      name: "Alice",
    });
  });

  it("resolves by plain ID", async () => {
    const res = await resolveSlackUserAllowlist({
      token: "test",
      entries: ["U2"],
      client: mockClient as any,
    });
    expect(res[0]).toMatchObject({
      input: "U2",
      resolved: true,
      id: "U2",
      name: "Bobby",
    });
  });

  it("resolves by email", async () => {
    const res = await resolveSlackUserAllowlist({
      token: "test",
      entries: ["alice@example.com"],
      client: mockClient as any,
    });
    expect(res[0]).toMatchObject({
      input: "alice@example.com",
      resolved: true,
      id: "U1",
    });
  });

  it("resolves by name and prefers non-deleted", async () => {
    const res = await resolveSlackUserAllowlist({
      token: "test",
      entries: ["@Alice"],
      client: mockClient as any,
    });
    expect(res[0]).toMatchObject({
      input: "@Alice",
      resolved: true,
      id: "U1", // U1 is active, U4 is deleted
    });
  });

  it("handles multiple matches by name", async () => {
    // Both U1 and U4 have displayName "Alice"
    // U1 should win because it's not deleted.
    const res = await resolveSlackUserAllowlist({
      token: "test",
      entries: ["@Alice"],
      client: mockClient as any,
    });
    expect(res[0].id).toBe("U1");
    expect(res[0].note).toBe("multiple matches; chose best");
  });

  it("handles unresolved names", async () => {
    const res = await resolveSlackUserAllowlist({
      token: "test",
      entries: ["@nonexistent"],
      client: mockClient as any,
    });
    expect(res[0].resolved).toBe(false);
  });

  it("marks unknown IDs as resolved (original behavior)", async () => {
    const res = await resolveSlackUserAllowlist({
      token: "test",
      entries: ["U999"],
      client: mockClient as any,
    });
    expect(res[0]).toMatchObject({
      input: "U999",
      resolved: true,
      id: "U999",
    });
  });
});
