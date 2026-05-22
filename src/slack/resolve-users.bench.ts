import { resolveSlackUserAllowlist, type SlackUserLookup } from "./resolve-users.js";

const generateUsers = (count: number): SlackUserLookup[] => {
  const users: SlackUserLookup[] = [];
  for (let i = 0; i < count; i++) {
    users.push({
      id: `U${i.toString().padStart(8, '0')}`,
      name: `user${i}`,
      displayName: `Display Name ${i}`,
      realName: `Real Name ${i}`,
      email: `user${i}@example.com`,
      deleted: false,
      isBot: false,
      isAppUser: false,
    });
  }
  return users;
};

const userCount = 1000;
const entriesCount = 500;
const users = generateUsers(userCount);
const entries = users.slice(0, entriesCount).map(u => u.id);

const mockClient = {
  users: {
    list: async ({ cursor }: { cursor?: string }) => {
      if (cursor) return { members: [], response_metadata: {} };
      return {
        members: users.map(u => ({
          id: u.id,
          name: u.name,
          deleted: u.deleted,
          is_bot: u.isBot,
          is_app_user: u.isAppUser,
          real_name: u.realName,
          profile: {
            display_name: u.displayName,
            real_name: u.realName,
            email: u.email,
          },
        })),
        response_metadata: {},
      };
    },
  },
};

async function runBenchmark() {
  const start = performance.now();
  const iterations = 100;
  for (let i = 0; i < iterations; i++) {
    await resolveSlackUserAllowlist({
      token: "fake-token",
      entries: entries,
      client: mockClient as any,
    });
  }
  const end = performance.now();
  console.log(`Average time over ${iterations} iterations: ${(end - start) / iterations}ms`);
}

runBenchmark().catch(console.error);
