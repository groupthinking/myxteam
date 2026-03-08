/**
 * Smart Reply Pipeline Tests
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { SmartReplyPipeline, type ClassificationResult } from "../smart-reply.js";
import { ChannelEventBus } from "../event-bus.js";

// ─── Helpers ────────────────────────────────────────────────────────────────

function buildPipeline(opts?: { confidenceThreshold?: number }) {
  const bus = new ChannelEventBus();
  const pipeline = new SmartReplyPipeline(
    {
      llm: {
        apiKey: "test-key",
        model: "grok-2",
        baseUrl: "https://api.x.ai/v1",
      },
      confidenceThreshold: opts?.confidenceThreshold ?? 0.5,
    },
    bus,
  );
  return { pipeline, bus };
}

function mockLLMResponse(classification: ClassificationResult) {
  return vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({
      choices: [{ message: { content: JSON.stringify(classification) } }],
      usage: { prompt_tokens: 50, completion_tokens: 30, total_tokens: 80 },
    }),
  });
}

const MENTION = {
  id: "tweet-123",
  text: "@bot How do I reset my password?",
  authorUsername: "testuser",
};

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("SmartReplyPipeline", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  describe("classify", () => {
    it("should classify a question mention and route to reply", async () => {
      const classification: ClassificationResult = {
        intent: "question",
        sentiment: "neutral",
        confidence: 0.92,
        route: "reply",
        reason: "direct question about password reset",
      };
      globalThis.fetch = mockLLMResponse(classification);

      const { pipeline } = buildPipeline();
      const result = await pipeline.classify(MENTION);

      expect(result.intent).toBe("question");
      expect(result.sentiment).toBe("neutral");
      expect(result.route).toBe("reply");
      expect(result.confidence).toBeGreaterThan(0.5);
    });

    it("should route spam to ignore", async () => {
      const classification: ClassificationResult = {
        intent: "spam",
        sentiment: "neutral",
        confidence: 0.85,
        route: "reply", // LLM might say "reply" but we enforce "ignore" for spam
        reason: "promotional content",
      };
      globalThis.fetch = mockLLMResponse(classification);

      const { pipeline } = buildPipeline();
      const result = await pipeline.classify(MENTION);

      expect(result.intent).toBe("spam");
      expect(result.route).toBe("ignore"); // Enforced by our rules
    });

    it("should route escalation intents to escalate", async () => {
      const classification: ClassificationResult = {
        intent: "escalation",
        sentiment: "negative",
        confidence: 0.78,
        route: "reply",
        reason: "user is demanding",
      };
      globalThis.fetch = mockLLMResponse(classification);

      const { pipeline } = buildPipeline();
      const result = await pipeline.classify(MENTION);

      expect(result.intent).toBe("escalation");
      expect(result.route).toBe("escalate");
    });

    it("should escalate when confidence is below threshold", async () => {
      const classification: ClassificationResult = {
        intent: "question",
        sentiment: "neutral",
        confidence: 0.3,
        route: "reply",
        reason: "unclear intent",
      };
      globalThis.fetch = mockLLMResponse(classification);

      const { pipeline } = buildPipeline({ confidenceThreshold: 0.5 });
      const result = await pipeline.classify(MENTION);

      expect(result.route).toBe("escalate");
      expect(result.reason).toContain("low confidence");
    });

    it("should always route to reply for non-spam non-escalation above threshold (enforceRouting default)", async () => {
      // The LLM might suggest route:"ignore" for a legitimate mention.
      // enforceRouting must override this to "reply" for the default case.
      const classification: ClassificationResult = {
        intent: "question",
        sentiment: "neutral",
        confidence: 0.8,
        route: "ignore", // LLM incorrectly suggests ignore
        reason: "unclear",
      };
      globalThis.fetch = mockLLMResponse(classification);

      const { pipeline } = buildPipeline();
      const result = await pipeline.classify(MENTION);

      expect(result.intent).toBe("question");
      expect(result.route).toBe("reply"); // Overridden by enforceRouting default
    });

    it("should clamp confidence to [0, 1]", async () => {
      const classification: ClassificationResult = {
        intent: "praise",
        sentiment: "positive",
        confidence: 1.5, // Out of range
        route: "reply",
        reason: "positive feedback",
      };
      globalThis.fetch = mockLLMResponse(classification);

      const { pipeline } = buildPipeline();
      const result = await pipeline.classify(MENTION);

      expect(result.confidence).toBeLessThanOrEqual(1);
    });

    it("should emit classified event on the bus", async () => {
      const classification: ClassificationResult = {
        intent: "praise",
        sentiment: "positive",
        confidence: 0.9,
        route: "reply",
        reason: "positive feedback",
      };
      globalThis.fetch = mockLLMResponse(classification);

      const { pipeline, bus } = buildPipeline();
      const handler = vi.fn();
      bus.on("smart-reply:classified", handler);

      await pipeline.classify(MENTION);

      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({
          mentionId: "tweet-123",
          classification: expect.objectContaining({ intent: "praise" }),
        }),
      );
    });

    it("should escalate (not silently forward) on LLM error", async () => {
      // Fail-secure: on classification error, escalate for human review rather
      // than blindly forwarding. This prevents prompt-injection bypass attacks.
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        text: async () => "Internal Server Error",
      });

      const { pipeline, bus } = buildPipeline();
      const errorHandler = vi.fn();
      bus.on("smart-reply:error", errorHandler);

      const result = await pipeline.classify(MENTION);

      expect(result.intent).toBe("unknown");
      expect(result.route).toBe("escalate"); // Fail-secure: escalate for review
      expect(errorHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          mentionId: "tweet-123",
          error: expect.stringContaining("500"),
        }),
      );
    });
  });

  describe("getMetrics", () => {
    it("should return LLM usage metrics", async () => {
      globalThis.fetch = mockLLMResponse({
        intent: "question",
        sentiment: "neutral",
        confidence: 0.9,
        route: "reply",
        reason: "question",
      });

      const { pipeline } = buildPipeline();
      await pipeline.classify(MENTION);

      const metrics = pipeline.getMetrics();
      expect(metrics.totalTokens).toBe(80);
      expect(metrics.cacheMisses).toBe(1);
    });
  });
});
