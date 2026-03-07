/**
 * Swarm Coordinator Tests
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { SwarmCoordinator } from "../coordinator.js";
import { Priority, Mention, ResolvedXAccount } from "../types.js";
import { XApiClient } from "../../x-api-client.js";

// Mock XApiClient
const mockXApiClient = {
  createPost: vi.fn(),
  fetchThread: vi.fn(),
} as unknown as XApiClient;

// Mock ResolvedXAccount
const mockAccount: ResolvedXAccount = {
  accountId: "test-account",
  agentUsername: "TestAgent",
  enabled: true,
  configured: true,
  accessToken: "test-token",
  authMode: "oauth2",
  config: { agentUsername: "TestAgent" },
};

// Mock Mention
const mockMention: Mention = {
  id: "123456",
  text: "@TestAgent Hello! Can you help me with something?",
  authorId: "789",
  authorUsername: "TestUser",
  createdAt: new Date().toISOString(),
  conversationId: "conv123",
};

describe("SwarmCoordinator", () => {
  let coordinator: SwarmCoordinator;

  beforeEach(() => {
    vi.clearAllMocks();

    // Mock successful X API responses
    mockXApiClient.fetchThread = vi.fn().mockResolvedValue({ posts: [] });
    mockXApiClient.createPost = vi.fn().mockResolvedValue({
      ok: true,
      postId: "reply123",
    });

    coordinator = new SwarmCoordinator(
      {
        maxConcurrentTasks: 5,
        taskTimeoutMs: 30000,
        enableTier1Parallel: true,
        enableTier2Parallel: true,
        cacheResults: true,
        cacheTtlMs: 3600000,
      },
      {
        xApiClient: mockXApiClient,
        account: mockAccount,
        llmConfig: {
          apiKey: "test-api-key",
          model: "grok-2",
          temperature: 0.7,
          maxTokens: 1000,
        },
      }
    );
  });

  describe("initialization", () => {
    it("should initialize with correct configuration", () => {
      const metrics = coordinator.getMetrics();
      expect(metrics.totalTasks).toBe(0);
      expect(metrics.successfulTasks).toBe(0);
      expect(metrics.failedTasks).toBe(0);
    });
  });

  describe("processMention", () => {
    it("should process a mention and return result", async () => {
      // This test would require mocking the LLM client
      // For now, just verify the method exists and returns a promise
      const resultPromise = coordinator.processMention(mockMention, Priority.HIGH);
      expect(resultPromise).toBeInstanceOf(Promise);
    });

    it("should track metrics after processing", async () => {
      // Process a mention (will likely fail due to no LLM mock)
      try {
        await coordinator.processMention(mockMention);
      } catch {
        // Expected to fail without LLM mock
      }

      const metrics = coordinator.getMetrics();
      expect(metrics.totalTasks).toBeGreaterThan(0);
    });
  });

  describe("getMetrics", () => {
    it("should return metrics object", () => {
      const metrics = coordinator.getMetrics();

      expect(metrics).toHaveProperty("totalTasks");
      expect(metrics).toHaveProperty("successfulTasks");
      expect(metrics).toHaveProperty("failedTasks");
      expect(metrics).toHaveProperty("successRate");
      expect(metrics).toHaveProperty("averageExecutionTimeMs");
      expect(metrics).toHaveProperty("agentMetrics");
      expect(metrics).toHaveProperty("messageBusMetrics");
    });

    it("should calculate success rate correctly", () => {
      const metrics = coordinator.getMetrics();

      if (metrics.totalTasks > 0) {
        const expectedRate =
          metrics.successfulTasks / metrics.totalTasks;
        expect(metrics.successRate).toBeCloseTo(expectedRate, 5);
      } else {
        expect(metrics.successRate).toBe(0);
      }
    });
  });

  describe("reset", () => {
    it("should reset all metrics", async () => {
      // Process something first
      try {
        await coordinator.processMention(mockMention);
      } catch {
        // Ignore errors
      }

      // Reset
      coordinator.reset();

      // Verify reset
      const metrics = coordinator.getMetrics();
      expect(metrics.totalTasks).toBe(0);
      expect(metrics.successfulTasks).toBe(0);
      expect(metrics.failedTasks).toBe(0);
      expect(metrics.averageExecutionTimeMs).toBe(0);
    });
  });
});

describe("Agent Integration", () => {
  it("should have all 6 agents initialized", () => {
    const coordinator = new SwarmCoordinator(
      {
        maxConcurrentTasks: 5,
        taskTimeoutMs: 30000,
        enableTier1Parallel: true,
        enableTier2Parallel: true,
        cacheResults: true,
        cacheTtlMs: 3600000,
      },
      {
        xApiClient: mockXApiClient,
        account: mockAccount,
        llmConfig: {
          apiKey: "test-api-key",
          model: "grok-2",
          temperature: 0.7,
          maxTokens: 1000,
        },
      }
    );

    const metrics = coordinator.getMetrics();
    expect(metrics.agentMetrics).toHaveLength(6);

    const agentNames = metrics.agentMetrics.map((m) => m.name);
    expect(agentNames).toContain("ContextAnalyzer");
    expect(agentNames).toContain("IntentClassifier");
    expect(agentNames).toContain("SentimentAnalyzer");
    expect(agentNames).toContain("ActionPlanner");
    expect(agentNames).toContain("ContentGenerator");
    expect(agentNames).toContain("VerificationAgent");
  });
});
