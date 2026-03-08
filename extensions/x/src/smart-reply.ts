/**
 * Smart Reply Pipeline
 *
 * Lightweight intent + sentiment classification for incoming mentions.
 * Uses a single LLM call to classify the mention, then decides whether
 * and how to route it to OpenClaw's message pipeline.
 *
 * This replaces the over-engineered swarm agent hierarchy with a simple,
 * single-pass approach:
 *   1. Classify intent & sentiment via one LLM call.
 *   2. Decide routing (reply, ignore, escalate).
 *   3. Emit an internal event so channel.ts can act on the decision.
 *
 * When the `useSmartReply` config flag is false, this module is never
 * invoked — mentions flow straight to OpenClaw's pipeline as before.
 */

import type { ChannelLogSink } from "openclaw/plugin-sdk";
import { LLMClient, type LLMConfig } from "./llm-client.js";
import { ChannelEventBus } from "./event-bus.js";

// ─── Public Types ───────────────────────────────────────────────────────────

export type IntentCategory =
  | "question"
  | "complaint"
  | "praise"
  | "request"
  | "social"
  | "spam"
  | "escalation"
  | "unknown";

export type Sentiment = "positive" | "negative" | "neutral";

export type RouteAction = "reply" | "ignore" | "escalate";

export interface ClassificationResult {
  intent: IntentCategory;
  sentiment: Sentiment;
  confidence: number;
  route: RouteAction;
  /** Short reason for the routing decision (useful for logging/debugging). */
  reason: string;
}

export interface SmartReplyConfig {
  llm: LLMConfig;
  /** Minimum confidence to auto-reply. Below this → escalate. Default 0.5. */
  confidenceThreshold?: number;
  log?: ChannelLogSink;
}

// ─── Classification Prompt ──────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a classification engine for an X (Twitter) bot.
Given a mention, output a JSON object with exactly these fields:
- intent: one of "question", "complaint", "praise", "request", "social", "spam", "escalation", "unknown"
- sentiment: one of "positive", "negative", "neutral"
- confidence: a number between 0 and 1
- route: one of "reply", "ignore", "escalate"
- reason: a short (≤20 word) explanation

Routing rules:
- spam → ignore
- escalation or confidence < 0.5 → escalate
- everything else → reply

Respond ONLY with the JSON object.`;

// ─── Smart Reply Pipeline ───────────────────────────────────────────────────

export class SmartReplyPipeline {
  private readonly llm: LLMClient;
  private readonly bus: ChannelEventBus;
  private readonly confidenceThreshold: number;
  private readonly log?: ChannelLogSink;

  constructor(config: SmartReplyConfig, bus: ChannelEventBus) {
    this.llm = new LLMClient(config.llm, config.log);
    this.bus = bus;
    this.confidenceThreshold = config.confidenceThreshold ?? 0.5;
    this.log = config.log;
  }

  /**
   * Classify a mention and emit the result on the event bus.
   *
   * Returns the classification so the caller can also act on it directly.
   */
  async classify(mention: {
    id: string;
    text: string;
    authorUsername: string;
  }): Promise<ClassificationResult> {
    const prompt = `Mention from @${mention.authorUsername}:\n"${mention.text}"`;

    try {
      const raw = await this.llm.completeJSON<ClassificationResult>(prompt, {
        system: SYSTEM_PROMPT,
        temperature: 0.2,
        maxTokens: 200,
      });

      // Normalise & enforce routing rules on our side (don't trust the LLM blindly)
      const result = this.enforceRouting(raw);

      this.log?.info?.(
        `[SmartReply] ${mention.id}: intent=${result.intent} sentiment=${result.sentiment} ` +
          `confidence=${result.confidence.toFixed(2)} → ${result.route} (${result.reason})`,
      );

      this.bus.emit("smart-reply:classified", {
        mentionId: mention.id,
        classification: result,
      });

      return result;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log?.error?.(`[SmartReply] Classification failed for ${mention.id}: ${msg}`);

      // On failure, fall through to normal pipeline (reply)
      const fallback: ClassificationResult = {
        intent: "unknown",
        sentiment: "neutral",
        confidence: 0,
        route: "reply",
        reason: "classification failed — falling through",
      };

      this.bus.emit("smart-reply:error", {
        mentionId: mention.id,
        error: msg,
      });

      return fallback;
    }
  }

  /**
   * Return LLM usage metrics for monitoring.
   */
  getMetrics() {
    return this.llm.getMetrics();
  }

  // ── Internal ────────────────────────────────────────────────────────────

  /**
   * Apply deterministic routing rules on top of the LLM's suggestion.
   */
  private enforceRouting(raw: ClassificationResult): ClassificationResult {
    const result = { ...raw };

    // Clamp confidence
    result.confidence = Math.max(0, Math.min(1, result.confidence));

    // Hard rules
    if (result.intent === "spam") {
      result.route = "ignore";
    } else if (result.intent === "escalation") {
      result.route = "escalate";
    } else if (result.confidence < this.confidenceThreshold) {
      result.route = "escalate";
      result.reason = `low confidence (${result.confidence.toFixed(2)})`;
    }

    return result;
  }
}
