/**
 * Context Analyzer Agent
 * 
 * Gathers and synthesizes historical context about the user,
 * conversation thread, and previous interactions.
 * 
 * Typical latency: 300-800ms
 * xMCP calls: 2-3
 */

import { BaseAgent, BaseAgentConfig } from "./base.js";
import {
  AgentInput,
  ContextAnalysis,
  Mention,
  ThreadPost,
} from "../types.js";

interface ContextAnalyzerConfig extends BaseAgentConfig {
  fetchDepth?: number;
  includeUserHistory?: boolean;
}

export class ContextAnalyzerAgent extends BaseAgent {
  private fetchDepth: number;
  private includeUserHistory: boolean;

  constructor(config: ContextAnalyzerConfig) {
    super({
      ...config,
      name: "ContextAnalyzer",
      description: "Analyzes conversation history and user relationship context",
    });
    this.fetchDepth = config.fetchDepth ?? 10;
    this.includeUserHistory = config.includeUserHistory ?? true;
  }

  protected getRequiredInputFields(): string[] {
    return ["mention"];
  }

  protected async process(input: AgentInput): Promise<ContextAnalysis> {
    const mention = this.extractMention(input);

    this.log?.info?.(
      `[ContextAnalyzer] Analyzing context for mention ${mention.id} from @${mention.authorUsername}`
    );

    // Fetch thread context
    const threadData = await this.fetchThread(mention.conversationId);

    // Fetch user timeline
    const userTimeline = this.includeUserHistory
      ? await this.fetchUserTimeline(mention.authorId)
      : [];

    // Search past interactions
    const pastInteractions = await this.searchPastInteractions(
      mention.authorUsername
    );

    // Synthesize with LLM
    const contextSummary = await this.synthesizeContext(
      mention,
      threadData,
      userTimeline,
      pastInteractions
    );

    return {
      threadContext: {
        conversationChain: threadData,
        rootTweet: threadData[0] ?? null,
        participants: this.extractParticipants(threadData),
        conversationTopic: contextSummary.topic,
        conversationDurationMinutes: this.calculateDuration(threadData),
      },
      userContext: this.extractUserContext(userTimeline, pastInteractions),
      ourPreviousResponses: pastInteractions,
      contextSummary: contextSummary.summary,
    };
  }

  private async fetchThread(conversationId: string): Promise<ThreadPost[]> {
    if (!conversationId) return [];

    try {
      const result = await this.xApiClient.fetchThread(conversationId);
      return result.posts.slice(-this.fetchDepth);
    } catch (error) {
      this.log?.error?.(
        `[ContextAnalyzer] Failed to fetch thread: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
      return [];
    }
  }

  private async fetchUserTimeline(userId: string): Promise<ThreadPost[]> {
    if (!userId) return [];

    // Note: This would require a new method in XApiClient
    // For now, return empty array
    this.log?.debug?.(
      `[ContextAnalyzer] User timeline fetch not implemented, skipping`
    );
    return [];
  }

  private async searchPastInteractions(username: string): Promise<ThreadPost[]> {
    if (!username) return [];

    // Note: This would require search functionality in XApiClient
    // For now, return empty array
    this.log?.debug?.(
      `[ContextAnalyzer] Past interactions search not implemented, skipping`
    );
    return [];
  }

  private async synthesizeContext(
    mention: Mention,
    thread: ThreadPost[],
    timeline: ThreadPost[],
    interactions: ThreadPost[]
  ): Promise<{
    summary: string;
    topic: string;
    userRelationship: string;
    conversationFlow: string;
    relevantContext: string;
  }> {
    const prompt = `You are the ContextAnalyzer agent for an X (Twitter) autonomous agent system.

Analyze the following conversation context:

CURRENT MENTION:
- Text: "${mention.text}"
- From: @${mention.authorUsername}
- Time: ${mention.createdAt}

THREAD HISTORY (${thread.length} tweets):
${JSON.stringify(thread.slice(-5), null, 2)}

USER RECENT TWEETS (${timeline.length} tweets):
${JSON.stringify(timeline.slice(0, 3), null, 2)}

PAST INTERACTIONS WITH US (${interactions.length}):
${JSON.stringify(interactions.slice(0, 3), null, 2)}

Provide a structured analysis with:
1. summary: 2-3 sentence synthesis of the situation
2. topic: Main conversation topic (1-3 words)
3. userRelationship: new|follower|frequent_interactor
4. conversationFlow: How the conversation has progressed
5. relevantContext: Any important background information

Output as JSON.`;

    return this.llmClient.completeStructured<{
      summary: string;
      topic: string;
      userRelationship: string;
      conversationFlow: string;
      relevantContext: string;
    }>(prompt, {
      type: "object",
      properties: {
        summary: { type: "string" },
        topic: { type: "string" },
        userRelationship: { type: "string" },
        conversationFlow: { type: "string" },
        relevantContext: { type: "string" },
      },
      required: ["summary", "topic", "userRelationship"],
    });
  }

  private extractParticipants(thread: ThreadPost[]): string[] {
    const participants = new Set<string>();
    for (const post of thread) {
      if (post.authorUsername) {
        participants.add(post.authorUsername);
      }
    }
    return Array.from(participants);
  }

  private calculateDuration(thread: ThreadPost[]): number {
    if (thread.length < 2) return 0;

    const timestamps = thread
      .map((p) => (p.createdAt ? new Date(p.createdAt).getTime() : 0))
      .filter((t) => t > 0);

    if (timestamps.length < 2) return 0;

    const min = Math.min(...timestamps);
    const max = Math.max(...timestamps);
    return Math.round((max - min) / (1000 * 60)); // Convert to minutes
  }

  private extractUserContext(
    timeline: ThreadPost[],
    interactions: ThreadPost[]
  ): ContextAnalysis["userContext"] {
    const hasInteractions = interactions.length > 0;
    const interactionCount = interactions.length;

    let relationshipType: "new" | "follower" | "frequent_interactor" = "new";
    if (interactionCount > 5) {
      relationshipType = "frequent_interactor";
    } else if (interactionCount > 0) {
      relationshipType = "follower";
    }

    return {
      relationshipType,
      previousInteractionsCount: interactionCount,
      lastInteractionDate: interactions[0]?.createdAt,
      typicalEngagementWithUs:
        interactionCount > 10
          ? "high"
          : interactionCount > 3
          ? "medium"
          : hasInteractions
          ? "low"
          : "none",
    };
  }
}
