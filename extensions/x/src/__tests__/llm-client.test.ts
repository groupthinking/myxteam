/**
 * LLM Client Tests
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { LLMClient, type LLMConfig } from "../llm-client.js";

// ─── Helpers ────────────────────────────────────────────────────────────────

function buildConfig(overrides?: Partial<LLMConfig>): LLMConfig {
  return {
    apiKey: "test-key",
    model: "grok-2",
    baseUrl: "https://api.x.ai/v1",
    temperature: 0.7,
    maxTokens: 100,
    ...overrides,
  };
}

function mockFetchSuccess(content: string, usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number }) {
  return vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({
      choices: [{ message: { content } }],
      usage: usage ?? { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    }),
  });
}

function mockFetchError(status: number, body: string) {
  return vi.fn().mockResolvedValue({
    ok: false,
    status,
    text: async () => body,
  });
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("LLMClient", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  describe("constructor", () => {
    it("should apply default config values", () => {
      const client = new LLMClient({ apiKey: "k" });
      const metrics = client.getMetrics();
      expect(metrics.totalTokens).toBe(0);
      expect(metrics.estimatedCostUsd).toBe(0);
    });
  });

  describe("complete", () => {
    it("should send a chat completion request and return parsed response", async () => {
      const fetchMock = mockFetchSuccess("Hello world");
      globalThis.fetch = fetchMock;

      const client = new LLMClient(buildConfig());
      const result = await client.complete("Say hello");

      expect(result.content).toBe("Hello world");
      expect(result.usage?.totalTokens).toBe(15);
      expect(fetchMock).toHaveBeenCalledOnce();

      // Verify the request body
      const callArgs = fetchMock.mock.calls[0];
      expect(callArgs[0]).toBe("https://api.x.ai/v1/chat/completions");
      const body = JSON.parse(callArgs[1].body);
      expect(body.model).toBe("grok-2");
      expect(body.messages).toEqual([{ role: "user", content: "Say hello" }]);
    });

    it("should include system message when provided", async () => {
      const fetchMock = mockFetchSuccess("OK");
      globalThis.fetch = fetchMock;

      const client = new LLMClient(buildConfig());
      await client.complete("Hello", { system: "You are a bot." });

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.messages).toEqual([
        { role: "system", content: "You are a bot." },
        { role: "user", content: "Hello" },
      ]);
    });

    it("should set response_format for JSON mode", async () => {
      const fetchMock = mockFetchSuccess('{"ok":true}');
      globalThis.fetch = fetchMock;

      const client = new LLMClient(buildConfig());
      await client.complete("Return JSON", { responseFormat: "json" });

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.response_format).toEqual({ type: "json_object" });
    });

    it("should throw on API error", async () => {
      globalThis.fetch = mockFetchError(429, "Rate limited");

      const client = new LLMClient(buildConfig());
      await expect(client.complete("Hello")).rejects.toThrow("LLM API error 429");
    });

    it("should cache responses and return cached result on repeat", async () => {
      const fetchMock = mockFetchSuccess("Cached!");
      globalThis.fetch = fetchMock;

      const client = new LLMClient(buildConfig());
      const first = await client.complete("Same prompt");
      const second = await client.complete("Same prompt");

      expect(first.content).toBe("Cached!");
      expect(second.content).toBe("Cached!");
      expect(fetchMock).toHaveBeenCalledOnce(); // Only one actual API call
    });

    it("should track usage metrics", async () => {
      globalThis.fetch = mockFetchSuccess("Hi", {
        prompt_tokens: 20,
        completion_tokens: 10,
        total_tokens: 30,
      });

      const client = new LLMClient(buildConfig());
      await client.complete("Hello");

      const metrics = client.getMetrics();
      expect(metrics.totalTokens).toBe(30);
      expect(metrics.cacheMisses).toBe(1);
      expect(metrics.cacheHits).toBe(0);
    });
  });

  describe("completeJSON", () => {
    it("should parse JSON response", async () => {
      globalThis.fetch = mockFetchSuccess(JSON.stringify({ intent: "question", score: 0.9 }));

      const client = new LLMClient(buildConfig());
      const result = await client.completeJSON<{ intent: string; score: number }>("Classify");

      expect(result.intent).toBe("question");
      expect(result.score).toBe(0.9);
    });

    it("should throw on invalid JSON", async () => {
      globalThis.fetch = mockFetchSuccess("not valid json {{{");

      const client = new LLMClient(buildConfig());
      await expect(client.completeJSON("Classify")).rejects.toThrow("LLM returned invalid JSON");
    });
  });

  describe("getMetrics", () => {
    it("should calculate cache hit rate", async () => {
      globalThis.fetch = mockFetchSuccess("A");

      const client = new LLMClient(buildConfig());
      await client.complete("prompt-a");
      await client.complete("prompt-a"); // cache hit

      const metrics = client.getMetrics();
      expect(metrics.cacheHits).toBe(1);
      expect(metrics.cacheMisses).toBe(1);
      expect(metrics.cacheHitRate).toBe(0.5);
    });
  });

  describe("pricing", () => {
    it("should use custom pricing when provided", async () => {
      globalThis.fetch = mockFetchSuccess("Hi", {
        prompt_tokens: 1000,
        completion_tokens: 1000,
        total_tokens: 2000,
      });

      const client = new LLMClient(
        buildConfig({ pricing: { input: 0.01, output: 0.03 } }),
      );
      await client.complete("Hello");

      const metrics = client.getMetrics();
      // Cost = (1000/1000)*0.01 + (1000/1000)*0.03 = 0.04
      expect(metrics.estimatedCostUsd).toBeCloseTo(0.04, 5);
    });
  });
});
