/**
 * Intent Classifier Agent
 * 
 * Determines the user's intent from their mention.
 * 
 * Typical latency: 150-300ms
 * xMCP calls: 0
 */

import { BaseAgent, BaseAgentConfig } from "./base.js";
import {
  AgentInput,
  IntentClassification,
  IntentCategory,
  Mention,
  ThreadPost,
} from "../types.js";

export class IntentClassifierAgent extends BaseAgent {
  private intentTaxonomy: Record<string, string[]> = {
    [IntentCategory.QUESTION]: [
      "factual",
      "opinion",
      "how_to",
      "clarification",
      "verification",
    ],
    [IntentCategory.REQUEST]: [
      "action",
      "information",
      "introduction",
      "collaboration",
      "support",
    ],
    [IntentCategory.FEEDBACK]: [
      "positive",
      "negative",
      "suggestion",
      "bug_report",
      "feature_request",
    ],
    [IntentCategory.SOCIAL]: [
      "greeting",
      "casual_chat",
      "meme",
      "banter",
      "acknowledgment",
    ],
    [IntentCategory.PROMOTIONAL]: [
      "self_promo",
      "shilling",
      "spam",
      "bot",
    ],
    [IntentCategory.ESCALATION]: [
      "complaint",
      "demand",
      "threat",
      "harassment",
    ],
  };

  constructor(config: BaseAgentConfig) {
    super({
      ...config,
      name: "IntentClassifier",
      description: "Classifies user intent from mentions",
    });
  }

  protected getRequiredInputFields(): string[] {
    return ["mention"];
  }

  protected async process(input: AgentInput): Promise<IntentClassification> {
    const mention = this.extractMention(input);
    const contextSummary = (input.data.contextSummary as string) ?? "";
    const threadContext = (input.data.threadContext as ThreadPost[]) ?? [];

    this.log?.info?.(
      `[IntentClassifier] Classifying intent for mention ${mention.id}`
    );

    const prompt = this.buildClassificationPrompt(
      mention,
      contextSummary,
      threadContext
    );

    const classification = await this.llmClient.completeStructured<{
      primaryIntent: string;
      confidence: number;
      secondaryIntents: string[];
      explicitAsk: string | null;
      implicitNeeds: string[];
      urgencyLevel: "critical" | "high" | "medium" | "low";
      requiresHumanReview: boolean;
      classificationReasoning: string;
    }>(prompt, {
      type: "object",
      properties: {
        primaryIntent: { type: "string" },
        confidence: { type: "number" },
        secondaryIntents: { type: "array", items: { type: "string" } },
        explicitAsk: { type: ["string", "null"] },
        implicitNeeds: { type: "array", items: { type: "string" } },
        urgencyLevel: {
          type: "string",
          enum: ["critical", "high", "medium", "low"],
        },
        requiresHumanReview: { type: "boolean" },
        classificationReasoning: { type: "string" },
      },
      required: [
        "primaryIntent",
        "confidence",
        "urgencyLevel",
        "requiresHumanReview",
      ],
    });

    return {
      primaryIntent: classification.primaryIntent,
      confidence: classification.confidence,
      secondaryIntents: classification.secondaryIntents,
      explicitAsk: classification.explicitAsk,
      implicitNeeds: classification.implicitNeeds,
      urgencyLevel: classification.urgencyLevel,
      requiresHumanReview: classification.requiresHumanReview,
      classificationReasoning: classification.classificationReasoning,
    };
  }

  private buildClassificationPrompt(
    mention: Mention,
    context: string,
    thread: ThreadPost[]
  ): string {
    return `You are the IntentClassifier agent for an X (Twitter) autonomous agent system.

YOUR ROLE: Precisely classify what the user wants from their mention.

INPUT:
- Mention text: "${mention.text}"
- From: @${mention.authorUsername}
- Context: ${context}
- Thread: ${JSON.stringify(thread.slice(-3), null, 2)}

INTENT TAXONOMY:
${JSON.stringify(this.intentTaxonomy, null, 2)}

CLASSIFICATION TASK:
Analyze the mention and classify into ONE primary intent using format "category.subcategory".

RULES:
- Confidence < 0.6 → flag for review
- Escalation intents always require review
- Consider thread context for intent disambiguation
- Sarcasm and irony are hard - flag if uncertain

Provide structured classification output as JSON.`;
  }
}
