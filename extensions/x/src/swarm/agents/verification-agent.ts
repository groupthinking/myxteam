/**
 * Verification Agent
 * 
 * Reviews content before posting for policy compliance and quality.
 * 
 * Typical latency: 200-400ms
 * xMCP calls: 0
 */

import { BaseAgent, BaseAgentConfig } from "./base.js";
import {
  AgentInput,
  VerificationResult,
  GeneratedContent,
  Mention,
  ActionPlan,
} from "../types.js";

interface VerificationAgentConfig extends BaseAgentConfig {
  brandGuidelines?: string[];
  prohibitedTopics?: string[];
  maxCharacterCount?: number;
}

export class VerificationAgent extends BaseAgent {
  private brandGuidelines: string[];
  private prohibitedTopics: string[];
  private maxCharacterCount: number;

  private static readonly DEFAULT_BRAND_GUIDELINES = [
    "Be respectful and professional",
    "Avoid controversial political statements",
    "Don't share personal information",
    "Fact-check before making claims",
  ];

  private static readonly DEFAULT_PROHIBITED_TOPICS = [
    "hate speech",
    "harassment",
    "misinformation",
    "spam",
    "self-harm",
    "violence",
  ];

  constructor(config: VerificationAgentConfig) {
    super({
      ...config,
      name: "VerificationAgent",
      description: "Reviews content before posting",
    });
    this.brandGuidelines = config.brandGuidelines ?? VerificationAgent.DEFAULT_BRAND_GUIDELINES;
    this.prohibitedTopics = config.prohibitedTopics ?? VerificationAgent.DEFAULT_PROHIBITED_TOPICS;
    this.maxCharacterCount = config.maxCharacterCount ?? 280;
  }

  protected getRequiredInputFields(): string[] {
    return ["mention", "generatedContent", "actionPlan"];
  }

  protected async process(input: AgentInput): Promise<VerificationResult> {
    const mention = this.extractMention(input);
    const generatedContent = input.data.generatedContent as GeneratedContent;
    const actionPlan = input.data.actionPlan as ActionPlan;

    this.log?.info?.(
      `[VerificationAgent] Verifying content for mention ${mention.id}`
    );

    const content = generatedContent.generatedContent?.primaryReply ?? "";

    // Run automated checks first
    const autoChecks = this.runAutomatedChecks(content);
    if (!autoChecks.passed) {
      return {
        approved: false,
        violations: autoChecks.violations,
        verificationNotes: `Automated checks failed: ${autoChecks.violations
          .map((v) => v.description)
          .join(", ")}`,
      };
    }

    // LLM-based verification for nuanced checks
    const prompt = `You are the VerificationAgent.

Review this content before posting:

CONTENT TO VERIFY: "${content}"

ORIGINAL MENTION: "${mention.text}"
FROM: @${mention.authorUsername}

CONTENT TYPE: ${actionPlan.decision?.responseType ?? "reply"}

BRAND GUIDELINES:
${this.brandGuidelines.map((g) => `- ${g}`).join("\n")}

PROHIBITED TOPICS:
${this.prohibitedTopics.map((t) => `- ${t}`).join("\n")}

VERIFICATION TASK:
1. Check for policy violations
2. Verify brand alignment
3. Assess tone appropriateness
4. Flag any concerns

Provide structured verification output as JSON.`;

    const verification = await this.llmClient.completeStructured<{
      approved: boolean;
      violations: Array<{
        type: string;
        severity: "low" | "medium" | "high";
        description: string;
      }>;
      modifiedContent?: string;
      verificationNotes: string;
    }>(prompt, {
      type: "object",
      properties: {
        approved: { type: "boolean" },
        violations: {
          type: "array",
          items: {
            type: "object",
            properties: {
              type: { type: "string" },
              severity: { type: "string", enum: ["low", "medium", "high"] },
              description: { type: "string" },
            },
          },
        },
        modifiedContent: { type: "string" },
        verificationNotes: { type: "string" },
      },
      required: ["approved", "violations", "verificationNotes"],
    });

    return {
      approved: verification.approved,
      violations: verification.violations,
      modifiedContent: verification.modifiedContent,
      verificationNotes: verification.verificationNotes,
    };
  }

  private runAutomatedChecks(content: string): {
    passed: boolean;
    violations: Array<{ type: string; severity: "low" | "medium" | "high"; description: string }>;
  } {
    const violations: Array<{
      type: string;
      severity: "low" | "medium" | "high";
      description: string;
    }> = [];

    // Character count check
    if (content.length > this.maxCharacterCount) {
      violations.push({
        type: "length",
        severity: "high",
        description: `Content exceeds ${this.maxCharacterCount} characters (${content.length})`,
      });
    }

    // Check for prohibited topics (basic keyword matching)
    const lowerContent = content.toLowerCase();
    for (const topic of this.prohibitedTopics) {
      if (lowerContent.includes(topic.toLowerCase())) {
        violations.push({
          type: "prohibited_topic",
          severity: "high",
          description: `Content contains prohibited topic: ${topic}`,
        });
      }
    }

    // Check for excessive capitalization (shouting)
    const capsRatio =
      (content.match(/[A-Z]/g) ?? []).length / content.length;
    if (capsRatio > 0.7 && content.length > 10) {
      violations.push({
        type: "style",
        severity: "low",
        description: "Excessive capitalization detected",
      });
    }

    return {
      passed: violations.length === 0,
      violations,
    };
  }
}
