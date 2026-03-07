/**
 * Action Planner Agent
 * 
 * Decides what actions to take based on intent, sentiment, and context.
 * 
 * Typical latency: 200-400ms
 * xMCP calls: 0
 */

import { BaseAgent, BaseAgentConfig } from "./base.js";
import {
  AgentInput,
  ActionPlan,
  Mention,
  ContextAnalysis,
  IntentClassification,
  SentimentAnalysis,
} from "../types.js";

interface ActionPlannerConfig extends BaseAgentConfig {
  availableActions?: string[];
}

export class ActionPlannerAgent extends BaseAgent {
  private availableActions: string[];

  private static readonly DEFAULT_ACTIONS = [
    "post_reply",
    "post_quote_tweet",
    "like_tweet",
    "retweet",
    "fetch_thread",
    "fetch_user_info",
    "send_dm",
    "create_thread",
    "escalate",
    "ignore",
    "wait",
    "monitor",
  ];

  constructor(config: ActionPlannerConfig) {
    super({
      ...config,
      name: "ActionPlanner",
      description: "Decides which X actions to take",
    });
    this.availableActions = config.availableActions ?? ActionPlannerAgent.DEFAULT_ACTIONS;
  }

  protected getRequiredInputFields(): string[] {
    return ["mention", "intentClassification", "sentimentAnalysis"];
  }

  protected async process(input: AgentInput): Promise<ActionPlan> {
    const mention = this.extractMention(input);
    const context = (input.data.contextAnalysis as ContextAnalysis) ?? {};
    const intent = (input.data.intentClassification as IntentClassification) ?? {};
    const sentiment = (input.data.sentimentAnalysis as SentimentAnalysis) ?? {};
    const constraints = (input.data.systemConstraints as Record<string, unknown>) ?? {};

    this.log?.info?.(
      `[ActionPlanner] Planning actions for mention ${mention.id}`
    );

    const prompt = `You are the ActionPlanner agent.

Create an action plan based on:

MENTION: "${mention.text}"
INTENT: ${JSON.stringify(intent)}
SENTIMENT: ${JSON.stringify(sentiment)}
CONTEXT: ${JSON.stringify(context)}
AVAILABLE ACTIONS: ${this.availableActions.join(", ")}
CONSTRAINTS: ${JSON.stringify(constraints)}

DECISION FRAMEWORK:
1. SHOULD WE RESPOND? (spam→ignore, harassment→escalate, etc.)
2. RESPONSE TYPE: (reply/like/retweet/escalate/ignore)
3. ACTION SEQUENCE: Ordered list of actions
4. CONTENT REQUIREMENTS: Tone, length, elements needed
5. VERIFICATION NEEDS: Auto-approve or require review

Provide structured action plan output as JSON.`;

    const plan = await this.llmClient.completeStructured<{
      decision: {
        shouldRespond: boolean;
        responseType: "reply" | "like" | "retweet" | "escalate" | "ignore";
        priority: "critical" | "high" | "medium" | "low";
      };
      actionSequence: Array<{
        order: number;
        action: string;
        params: Record<string, unknown>;
      }>;
      contentRequirements: {
        tone: string;
        lengthTarget: "short" | "medium" | "long";
        requiredElements: string[];
        prohibitedElements: string[];
      };
      verificationRequirements: {
        needsApproval: boolean;
        approvalReason?: string;
        autoVerify: boolean;
      };
      planReasoning: string;
    }>(prompt, {
      type: "object",
      properties: {
        decision: {
          type: "object",
          properties: {
            shouldRespond: { type: "boolean" },
            responseType: {
              type: "string",
              enum: ["reply", "like", "retweet", "escalate", "ignore"],
            },
            priority: {
              type: "string",
              enum: ["critical", "high", "medium", "low"],
            },
          },
        },
        actionSequence: {
          type: "array",
          items: {
            type: "object",
            properties: {
              order: { type: "integer" },
              action: { type: "string" },
              params: { type: "object" },
            },
          },
        },
        contentRequirements: {
          type: "object",
          properties: {
            tone: { type: "string" },
            lengthTarget: {
              type: "string",
              enum: ["short", "medium", "long"],
            },
            requiredElements: { type: "array", items: { type: "string" } },
            prohibitedElements: { type: "array", items: { type: "string" } },
          },
        },
        verificationRequirements: {
          type: "object",
          properties: {
            needsApproval: { type: "boolean" },
            approvalReason: { type: ["string", "null"] },
            autoVerify: { type: "boolean" },
          },
        },
        planReasoning: { type: "string" },
      },
      required: ["decision", "actionSequence", "contentRequirements"],
    });

    return {
      decision: plan.decision,
      actionSequence: plan.actionSequence,
      contentRequirements: plan.contentRequirements,
      verificationRequirements: plan.verificationRequirements,
      planReasoning: plan.planReasoning,
    };
  }
}
