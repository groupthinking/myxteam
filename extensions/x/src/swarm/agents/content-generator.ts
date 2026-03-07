/**
 * Content Generator Agent
 * 
 * Crafts replies, quote tweets, or thread responses.
 * 
 * Typical latency: 300-600ms
 * xMCP calls: 0
 */

import { BaseAgent, BaseAgentConfig } from "./base.js";
import {
  AgentInput,
  GeneratedContent,
  Mention,
  ContextAnalysis,
  IntentClassification,
  SentimentAnalysis,
  ActionPlan,
} from "../types.js";

interface ContentGeneratorConfig extends BaseAgentConfig {
  personaConfig?: PersonaConfig;
}

interface PersonaConfig {
  name: string;
  voice: string;
  traits: string[];
  avoid: string[];
}

export class ContentGeneratorAgent extends BaseAgent {
  private persona: PersonaConfig;

  private static readonly DEFAULT_PERSONA: PersonaConfig = {
    name: "X Agent",
    voice: "friendly, knowledgeable, and authentic",
    traits: ["helpful", "witty", "respectful"],
    avoid: ["corporate speak", "overly formal language", "being defensive"],
  };

  constructor(config: ContentGeneratorConfig) {
    super({
      ...config,
      name: "ContentGenerator",
      description: "Generates response content",
    });
    this.persona = config.personaConfig ?? ContentGeneratorAgent.DEFAULT_PERSONA;
  }

  protected getRequiredInputFields(): string[] {
    return ["mention", "actionPlan"];
  }

  protected async process(input: AgentInput): Promise<GeneratedContent> {
    const mention = this.extractMention(input);
    const context = (input.data.contextAnalysis as ContextAnalysis) ?? {};
    const intent = (input.data.intentClassification as IntentClassification) ?? {};
    const sentiment = (input.data.sentimentAnalysis as SentimentAnalysis) ?? {};
    const actionPlan = (input.data.actionPlan as ActionPlan) ?? {};
    const contentReqs = actionPlan.contentRequirements ?? {};
    const knowledge = (input.data.knowledgeBase as string[]) ?? [];

    this.log?.info?.(
      `[ContentGenerator] Generating content for mention ${mention.id}`
    );

    const prompt = `You are the ContentGenerator agent.

Craft a response to this mention:

ORIGINAL MENTION: "${mention.text}"
FROM: @${mention.authorUsername}

CONTEXT: ${context.contextSummary ?? ""}
INTENT: ${intent.primaryIntent ?? "unknown"}
SENTIMENT: ${sentiment.sentiment?.polarity ?? "neutral"}

CONTENT REQUIREMENTS:
- Tone: ${contentReqs.tone ?? "friendly"}
- Length: ${contentReqs.lengthTarget ?? "medium"}
- Required: ${(contentReqs.requiredElements ?? []).join(", ")}
- Prohibited: ${(contentReqs.prohibitedElements ?? []).join(", ")}

OUR PERSONA: ${JSON.stringify(this.persona)}

RELEVANT KNOWLEDGE: ${knowledge.join("\n")}

GUIDELINES:
- Be authentic and conversational
- Address their specific point/question
- Use appropriate humor if detected
- Keep under 280 characters
- Include @${mention.authorUsername} in reply
- Show personality while being respectful

Provide structured content output as JSON.`;

    const content = await this.llmClient.completeStructured<{
      generatedContent: {
        primaryReply: string;
        alternativeVersions: string[];
        threadPosts?: string[];
        mediaSuggestions: string[];
      };
      contentMetadata: {
        characterCount: number;
        toneAssessment: string;
        hashtagsIncluded: string[];
        mentionsIncluded: string[];
      };
      confidence: number;
      generationNotes: string;
    }>(prompt, {
      type: "object",
      properties: {
        generatedContent: {
          type: "object",
          properties: {
            primaryReply: { type: "string" },
            alternativeVersions: {
              type: "array",
              items: { type: "string" },
            },
            threadPosts: {
              type: ["array", "null"],
              items: { type: "string" },
            },
            mediaSuggestions: {
              type: "array",
              items: { type: "string" },
            },
          },
        },
        contentMetadata: {
          type: "object",
          properties: {
            characterCount: { type: "integer" },
            toneAssessment: { type: "string" },
            hashtagsIncluded: {
              type: "array",
              items: { type: "string" },
            },
            mentionsIncluded: {
              type: "array",
              items: { type: "string" },
            },
          },
        },
        confidence: { type: "number" },
        generationNotes: { type: "string" },
      },
      required: ["generatedContent", "contentMetadata", "confidence"],
    });

    return {
      generatedContent: content.generatedContent,
      contentMetadata: content.contentMetadata,
      confidence: content.confidence,
      generationNotes: content.generationNotes,
    };
  }
}
