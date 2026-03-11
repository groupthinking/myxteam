import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getMemorySearchManager, type MemoryIndexManager } from "./index.js";

vi.mock("./embeddings.js", () => {
  const embedText = (text: string) => {
    const lower = text.toLowerCase();
    const alpha = lower.split("alpha").length - 1;
    const beta = lower.split("beta").length - 1;
    return [alpha, beta];
  };
  return {
    createEmbeddingProvider: async (options: { model?: string }) => ({
      requestedProvider: "openai",
      provider: {
        id: "mock",
        model: options.model ?? "mock-embed",
        embedQuery: async (text: string) => embedText(text),
        embedBatch: async (texts: string[]) => texts.map(embedText),
      },
    }),
  };
});

describe("memory index SQL injection fix", () => {
  let workspaceDir: string;
  let indexPath: string;
  let manager: MemoryIndexManager | null = null;

  beforeEach(async () => {
    workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-sql-fix-"));
    indexPath = path.join(workspaceDir, "index.sqlite");

    // Create a memory file
    const memDir = path.join(workspaceDir, "memory");
    await fs.mkdir(memDir, { recursive: true });
    await fs.writeFile(path.join(memDir, "memory.md"), "Alpha memory content.");

    // Sessions will be simulated via mock if needed, but here we just want to test source filtering
  });

  afterEach(async () => {
    if (manager) {
      await manager.close();
      manager = null;
    }
    await fs.rm(workspaceDir, { recursive: true, force: true });
  });

  it("correctly filters by multiple sources using json_each", async () => {
    const cfg = {
      agents: {
        defaults: {
          workspace: workspaceDir,
          memorySearch: {
            provider: "openai",
            model: "mock-embed",
            store: { path: indexPath },
            sync: { watch: false, onSessionStart: false, onSearch: true },
            query: { minScore: 0 },
            sources: ["memory", "sessions"], // Both sources enabled
            experimental: { sessionMemory: true }
          },
        },
        list: [{ id: "main", default: true }],
      },
    };

    const result = await getMemorySearchManager({ cfg, agentId: "main" });
    if (!result.manager) throw new Error("manager missing");
    manager = result.manager;

    // Index the files
    await manager.sync({ force: true });

    // Search should work with multiple sources
    const results = await manager.search("alpha");
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]?.source).toBe("memory");

    // Status should correctly count sources
    const status = manager.status();
    const memStatus = status.sourceCounts?.find(s => s.source === "memory");
    expect(memStatus?.files).toBe(1);
  });

  it("handles empty source list gracefully", async () => {
    const cfg = {
      agents: {
        defaults: {
          workspace: workspaceDir,
          memorySearch: {
            provider: "openai",
            model: "mock-embed",
            store: { path: indexPath },
            sync: { watch: false, onSessionStart: false, onSearch: true },
            query: { minScore: 0 },
            sources: [], // No sources!
          },
        },
        list: [{ id: "main", default: true }],
      },
    };

    const result = await getMemorySearchManager({ cfg, agentId: "main" });
    if (!result.manager) throw new Error("manager missing");
    manager = result.manager;

    await manager.sync({ force: true });

    // If no sources are selected, we should get no results (or it defaults to 'memory' depending on implementation)
    // Actually, normalizeSources in memory-search.ts defaults to ["memory"] if empty.
    const results = await manager.search("alpha");
    expect(results.length).toBeGreaterThan(0);
  });
});
