/**
 * LLM Client
 * 
 * Client for Grok/xAI API with caching and retry logic.
 * Used by agents for LLM-powered analysis and generation.
 */

import type { ChannelLogSink } from "openclaw/plugin-sdk";
import type { LLMConfig } from "./types.js";

export interface LLMResponse {
  content: string;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
}

interface CacheEntry {
  response: LLMResponse;
  timestamp: number;
}

/**
 * LLM client with LRU caching and structured output support
 */
export class LLMClient {
  private config: LLMConfig;
  private log?: ChannelLogSink;
  private cache: Map<string, CacheEntry>;
  private cacheHits = 0;
  private cacheMisses = 0;
  private totalTokens = 0;
  private estimatedCostUsd = 0;

  // Grok pricing (as of 2026-03-07)
  private readonly PRICE_PER_1K_INPUT_TOKENS = 0.005;
  private readonly PRICE_PER_1K_OUTPUT_TOKENS = 0.015;

  constructor(config: LLMConfig, log?: ChannelLogSink) {
    this.config = {
      model: "grok-2",
      temperature: 0.7,
      maxTokens: 1000,
      baseUrl: "https://api.x.ai/v1",
      ...config,
    };
    this.log = log;
    this.cache = new Map();
  }

  /**
   * Generate completion from LLM
   */
  async complete(
    prompt: string,
    options?: {
      temperature?: number;
      maxTokens?: number;
      responseFormat?: "json" | "text";
    }
  ): Promise<LLMResponse> {
    const cacheKey = this.getCacheKey(prompt, options);

    // Check cache
    const cached = this.cache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < 3600000) { // 1 hour TTL
      this.cacheHits++;
      this.log?.debug?.(`[LLM] Cache hit for prompt: ${prompt.slice(0, 50)}...`);
      return cached.response;
    }

    this.cacheMisses++;

    try {
      const response = await fetch(`${this.config.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.config.apiKey}`,
        },
        body: JSON.stringify({
          model: this.config.model,
          messages: [{ role: "user", content: prompt }],
          temperature: options?.temperature ?? this.config.temperature,
          max_tokens: options?.maxTokens ?? this.config.maxTokens,
          response_format:
            options?.responseFormat === "json"
              ? { type: "json_object" }
              : undefined,
        }),
      });

      if (!response.ok) {
        const error = await response.text();
        throw new Error(`LLM API error: ${response.status} ${error}`);
      }

      const data = (await response.json()) as {
        choices: Array<{
          message: { content: string };
        }>;
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

      // Track usage
      if (result.usage) {
        this.totalTokens += result.usage.totalTokens;
        this.estimatedCostUsd +=
          (result.usage.promptTokens / 1000) * this.PRICE_PER_1K_INPUT_TOKENS +
          (result.usage.completionTokens / 1000) *
            this.PRICE_PER_1K_OUTPUT_TOKENS;
      }

      // Cache result
      this.cache.set(cacheKey, { response: result, timestamp: Date.now() });

      // Clean old cache entries if too many
      if (this.cache.size > 1000) {
        const oldest = Array.from(this.cache.entries()).sort(
          (a, b) => a[1].timestamp - b[1].timestamp
        )[0];
        if (oldest) this.cache.delete(oldest[0]);
      }

      return result;
    } catch (error) {
      this.log?.error?.(
        `[LLM] Error: ${error instanceof Error ? error.message : String(error)}`
      );
      throw error;
    }
  }

  /**
   * Generate structured JSON output
   */
  async completeStructured<T>(
    prompt: string,
    schema: Record<string, unknown>,
    options?: { temperature?: number }
  ): Promise<T> {
    const schemaPrompt = `${prompt}\n\nYou must respond with valid JSON matching this schema:\n${JSON.stringify(
      schema,
      null,
      2
    )}\n\nRespond ONLY with the JSON object, no other text.`;

    const response = await this.complete(schemaPrompt, {
      ...options,
      responseFormat: "json",
    });

    try {
      return JSON.parse(response.content) as T;
    } catch (error) {
      this.log?.error?.(
        `[LLM] Failed to parse structured output: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
      throw new Error("Failed to parse LLM structured output");
    }
  }

  /**
   * Get cache statistics
   */
  getMetrics(): {
    cacheHitRate: number;
    cacheHits: number;
    cacheMisses: number;
    totalTokens: number;
    estimatedCostUsd: number;
  } {
    const total = this.cacheHits + this.cacheMisses;
    return {
      cacheHitRate: total > 0 ? this.cacheHits / total : 0,
      cacheHits: this.cacheHits,
      cacheMisses: this.cacheMisses,
      totalTokens: this.totalTokens,
      estimatedCostUsd: this.estimatedCostUsd,
    };
  }

  private getCacheKey(
    prompt: string,
    options?: Record<string, unknown>
  ): string {
    return `${prompt}:${JSON.stringify(options)}`;
  }
}
