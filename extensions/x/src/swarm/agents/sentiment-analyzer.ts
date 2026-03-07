/**
 * Sentiment Analyzer Agent
 * 
 * Analyzes emotional tone, sentiment polarity, and communication style.
 * 
 * Typical latency: 150-250ms
 * xMCP calls: 0
 */

import { BaseAgent, BaseAgentConfig } from "./base.js";
import {
  AgentInput,
  SentimentAnalysis,
  SentimentPolarity,
  Mention,
  ThreadPost,
  IntentClassification,
} from "../types.js";

export class SentimentAnalyzerAgent extends BaseAgent {
  constructor(config: BaseAgentConfig) {
    super({
      ...config,
      name: "SentimentAnalyzer",
      description: "Analyzes emotional tone and sentiment",
    });
  }

  protected getRequiredInputFields(): string[] {
    return ["mention"];
  }

  protected async process(input: AgentInput): Promise<SentimentAnalysis> {
    const mention = this.extractMention(input);
    const threadContext = (input.data.threadContext as ThreadPost[]) ?? [];
    const intent = (input.data.intentClassification as IntentClassification) ?? {};

    this.log?.info?.(
      `[SentimentAnalyzer] Analyzing sentiment for mention ${mention.id}`
    );

    const prompt = `You are the SentimentAnalyzer agent.

Analyze the emotional tone and sentiment of this mention:

MENTION: "${mention.text}"
FROM: @${mention.authorUsername}
THREAD CONTEXT: ${JSON.stringify(threadContext.slice(-3), null, 2)}
INTENT: ${JSON.stringify(intent)}

Provide structured sentiment analysis with:
1. sentiment polarity (very_positive/positive/neutral/negative/very_negative) and score (-1.0 to 1.0)
2. emotional indicators (primary emotion, intensity, sarcasm detection)
3. communication style (formality, aggressiveness, enthusiasm)
4. tone matching strategy for our response
5. risk flags (potential conflict, sensitive topics)

Be conservative with sarcasm detection. Output as JSON.`;

    const analysis = await this.llmClient.completeStructured<{
      sentiment: {
        polarity: SentimentPolarity;
        score: number;
        confidence: number;
      };
      emotionalIndicators: {
        primaryEmotion: string;
        emotionalIntensity: "low" | "medium" | "high";
        sarcasmDetected: boolean;
        sarcasmConfidence: number;
      };
      communicationStyle: {
        formality: "casual" | "neutral" | "formal";
        aggressiveness: "low" | "medium" | "high";
        enthusiasm: "low" | "medium" | "high";
        useOfHumor: boolean;
        useOfEmojis: boolean;
      };
      toneMatchingStrategy: string;
      riskFlags: {
        potentialConflict: boolean;
        sensitiveTopic: boolean;
        flags: string[];
      };
    }>(prompt, {
      type: "object",
      properties: {
        sentiment: {
          type: "object",
          properties: {
            polarity: {
              type: "string",
              enum: [
                "very_positive",
                "positive",
                "neutral",
                "negative",
                "very_negative",
              ],
            },
            score: { type: "number" },
            confidence: { type: "number" },
          },
        },
        emotionalIndicators: {
          type: "object",
          properties: {
            primaryEmotion: { type: "string" },
            emotionalIntensity: {
              type: "string",
              enum: ["low", "medium", "high"],
            },
            sarcasmDetected: { type: "boolean" },
            sarcasmConfidence: { type: "number" },
          },
        },
        communicationStyle: {
          type: "object",
          properties: {
            formality: {
              type: "string",
              enum: ["casual", "neutral", "formal"],
            },
            aggressiveness: {
              type: "string",
              enum: ["low", "medium", "high"],
            },
            enthusiasm: {
              type: "string",
              enum: ["low", "medium", "high"],
            },
            useOfHumor: { type: "boolean" },
            useOfEmojis: { type: "boolean" },
          },
        },
        toneMatchingStrategy: { type: "string" },
        riskFlags: {
          type: "object",
          properties: {
            potentialConflict: { type: "boolean" },
            sensitiveTopic: { type: "boolean" },
            flags: { type: "array", items: { type: "string" } },
          },
        },
      },
      required: ["sentiment", "emotionalIndicators", "communicationStyle"],
    });

    return {
      sentiment: analysis.sentiment,
      emotionalIndicators: analysis.emotionalIndicators,
      communicationStyle: analysis.communicationStyle,
      toneMatchingStrategy: analysis.toneMatchingStrategy,
      riskFlags: analysis.riskFlags,
    };
  }
}
