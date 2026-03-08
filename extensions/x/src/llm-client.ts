/**
 * LLM Client
 *
 * Lightweight, multi-provider LLM client supporting Grok/xAI, OpenAI,
 * and Anthropic-compatible APIs. Includes response caching and structured
 * JSON output support.
 *
 * Extracted from the swarm codebase and simplified for the smart-reply
 * pipeline. Pricing constants are externalized into the config object
 * so callers can override them without touching this module.
 */

import type { ChannelLogSink } from "openclaw/plugin-sdk";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface LLMConfig {
  /** API key for the chosen provider. */
  apiKey: string;
  /** Model identifier (e.g. "grok-2", "gpt-4o", "claude-3-haiku-20240307"). */
  model?: string;
  /** Sampling temperature (0–2). */
  temperature?: number;
  /** Maximum tokens to generate. */
  maxTokens?: number;
  /**
   * Base URL for the chat completions endpoint.
   * Defaults to xAI: "https://api.x.ai/v1".
   * Set to "https://api.openai.com/v1" for OpenAI,
   * or "https://api.anthropic.com/v1" for Anthropic, etc.
   */
  baseUrl?: string;
  /**
   * Per-1K-token pricing overrides.  Defaults to Grok pricing.
   * Set to { input: 0, output: 0 } to disable cost tracking.
   */
  pricing?: { input: number; output: number };
  /** Response cache TTL in milliseconds. Default: 3 600 000 (1 h). */
  cacheTtlMs?: number;
  /** Maximum number of cached responses. Default: 500. */
  cacheMaxSize?: number;
}

export interface LLMResponse {
  content: string;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
}

// ─── Default Pricing (per 1 K tokens) ──────────────────────────────────────

/** Sensible defaults — callers should override via config.pricing. */
const DEFAULT_PRICING = { input: 0.005, output: 0.015 } as const;

// ─── Cache Entry ────────────────────────────────────────────────────────────

interface CacheEntry {
  response: LLMResponse;
  timestamp: number;
}

// ─── Client ─────────────────────────────────────────────────────────────────

export class LLMClient {
  private readonly config: Required<
    Pick<LLMConfig, "apiKey" | "model" | "temperature" | "maxTokens" | "baseUrl">
  > & { pricing: { input: number; output: number }; cacheTtlMs: number; cacheMaxSize: number };

  private readonly log?: ChannelLogSink;
  private readonly cache = new Map<string, CacheEntry>();

  // Metrics
  private cacheHits = 0;
  private cacheMisses = 0;
  private totalTokens = 0;
  private estimatedCostUsd = 0;

  constructor(config: LLMConfig, log?: ChannelLogSink) {
    this.config = {
      apiKey: config.apiKey,
      model: config.model ?? "grok-2",
      temperature: config.temperature ?? 0.7,
      maxTokens: config.maxTokens ?? 1000,
      baseUrl: config.baseUrl ?? "https://api.x.ai/v1",
      pricing: config.pricing ?? { ...DEFAULT_PRICING },
      cacheTtlMs: config.cacheTtlMs ?? 3_600_000,
      cacheMaxSize: config.cacheMaxSize ?? 500,
    };
    this.log = log;
  }

  // ── Public API ──────────────────────────────────────────────────────────

  /**
   * Send a chat completion request.
   *
   * Supports an optional system message and JSON response format.
   */
  async complete(
    prompt: string,
    options?: {
      system?: string;
      temperature?: number;
      maxTokens?: number;
      responseFormat?: "json" | "text";
    },
  ): Promise<LLMResponse> {
    const cacheKey = this.buildCacheKey(prompt, options);

    const cached = this.cache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < this.config.cacheTtlMs) {
      this.cacheHits++;
      return cached.response;
    }

    this.cacheMisses++;

    const messages: Array<{ role: string; content: string }> = [];
    if (options?.system) {
      messages.push({ role: "system", content: options.system });
    }
    messages.push({ role: "user", content: prompt });

    const body: Record<string, unknown> = {
      model: this.config.model,
      messages,
      temperature: options?.temperature ?? this.config.temperature,
      max_tokens: options?.maxTokens ?? this.config.maxTokens,
    };

    if (options?.responseFormat === "json") {
      body.response_format = { type: "json_object" };
    }

    const response = await fetch(`${this.config.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.config.apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`LLM API error ${response.status}: ${errorText}`);
    }

    const data = (await response.json()) as {
      choices: Array<{ message: { content: string } }>;
      usage?: {
        prompt_tokens: number;
        completion_tokens: number;
        total_tokens: number;
      };
    };

    const result: LLMResponse = {
      content: data.choices[0]?.message?.content ?? "",
      usage: data.usage
        ? {
            promptTokens: data.usage.prompt_tokens,
            completionTokens: data.usage.completion_tokens,
            totalTokens: data.usage.total_tokens,
          }
        : undefined,
    };

    // Track cost
    if (result.usage) {
      this.totalTokens += result.usage.totalTokens;
      this.estimatedCostUsd +=
        (result.usage.promptTokens / 1000) * this.config.pricing.input +
        (result.usage.completionTokens / 1000) * this.config.pricing.output;
    }

    // Cache (evict oldest when full)
    this.cache.set(cacheKey, { response: result, timestamp: Date.now() });
    if (this.cache.size > this.config.cacheMaxSize) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }

    return result;
  }

  /**
   * Convenience wrapper: send a prompt and parse the response as JSON of type T.
   */
  async completeJSON<T>(
    prompt: string,
    options?: {
      system?: string;
      temperature?: number;
      maxTokens?: number;
    },
  ): Promise<T> {
    const response = await this.complete(prompt, {
      ...options,
      responseFormat: "json",
    });

    try {
      return JSON.parse(response.content) as T;
    } catch (err) {
      this.log?.error?.(
        `[LLMClient] Failed to parse JSON response. Raw content: "${response.content}"`,
        err,
      );
      throw new Error("LLM returned invalid JSON");
    }
  }

  /**
   * Return current usage / cache metrics.
   */
  getMetrics() {
    const total = this.cacheHits + this.cacheMisses;
    return {
      cacheHitRate: total > 0 ? this.cacheHits / total : 0,
      cacheHits: this.cacheHits,
      cacheMisses: this.cacheMisses,
      totalTokens: this.totalTokens,
      estimatedCostUsd: this.estimatedCostUsd,
    };
  }

  // ── Internals ───────────────────────────────────────────────────────────

  private buildCacheKey(
    prompt: string,
    options?: Record<string, unknown>,
  ): string {
    return `${this.config.model}:${prompt}:${JSON.stringify(options ?? {})}`;
  }
}
