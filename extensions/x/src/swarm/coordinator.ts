/**
 * Swarm Coordinator
 * 
 * Central orchestrator for the X Agent Swarm.
 * Manages agent lifecycle, parallel execution, and result fusion.
 */

import type { ChannelLogSink } from "openclaw/plugin-sdk";
import type { XApiClient } from "../x-api-client.js";
import type { ResolvedXAccount } from "../types.js";
import {
  Mention,
  Task,
  Priority,
  SwarmCoordinatorConfig,
  SwarmExecutionResult,
  FusedContext,
  AgentStatus,
  AgentInput,
  AgentOutput,
  ContextAnalysis,
  IntentClassification,
  SentimentAnalysis,
  ActionPlan,
  GeneratedContent,
  VerificationResult,
  LLMConfig,
} from "./types.js";
import {
  ContextAnalyzerAgent,
  IntentClassifierAgent,
  SentimentAnalyzerAgent,
  ActionPlannerAgent,
  ContentGeneratorAgent,
  VerificationAgent,
} from "./agents/index.js";
import { MessageBus } from "./communication/message-bus.js";

interface CoordinatorDependencies {
  xApiClient: XApiClient;
  account: ResolvedXAccount;
  log?: ChannelLogSink;
  llmConfig: LLMConfig;
}

/**
 * Swarm Coordinator - orchestrates multi-agent processing
 */
export class SwarmCoordinator {
  private config: SwarmCoordinatorConfig;
  private deps: CoordinatorDependencies;
  private messageBus: MessageBus;

  // Tier 1 Agents (parallel)
  private contextAnalyzer: ContextAnalyzerAgent;
  private intentClassifier: IntentClassifierAgent;
  private sentimentAnalyzer: SentimentAnalyzerAgent;

  // Tier 2 Agents (conditional)
  private actionPlanner: ActionPlannerAgent;
  private contentGenerator: ContentGeneratorAgent;
  private verificationAgent: VerificationAgent;

  // Metrics
  private totalTasks = 0;
  private successfulTasks = 0;
  private failedTasks = 0;
  private totalExecutionTimeMs = 0;

  constructor(config: SwarmCoordinatorConfig, deps: CoordinatorDependencies) {
    this.config = {
      maxConcurrentTasks: 10,
      taskTimeoutMs: 30000,
      enableTier1Parallel: true,
      enableTier2Parallel: true,
      cacheResults: true,
      cacheTtlMs: 3600000,
      ...config,
    };
    this.deps = deps;
    this.messageBus = new MessageBus(deps.log);

    // Initialize agents
    const baseConfig = {
      xApiClient: deps.xApiClient,
      log: deps.log,
      llmConfig: deps.llmConfig,
      timeoutMs: config.taskTimeoutMs,
    };

    this.contextAnalyzer = new ContextAnalyzerAgent({
      ...baseConfig,
      agentId: "context-analyzer",
      fetchDepth: 10,
      includeUserHistory: true,
    });

    this.intentClassifier = new IntentClassifierAgent({
      ...baseConfig,
      agentId: "intent-classifier",
    });

    this.sentimentAnalyzer = new SentimentAnalyzerAgent({
      ...baseConfig,
      agentId: "sentiment-analyzer",
    });

    this.actionPlanner = new ActionPlannerAgent({
      ...baseConfig,
      agentId: "action-planner",
    });

    this.contentGenerator = new ContentGeneratorAgent({
      ...baseConfig,
      agentId: "content-generator",
    });

    this.verificationAgent = new VerificationAgent({
      ...baseConfig,
      agentId: "verification-agent",
    });

    deps.log?.info?.("[SwarmCoordinator] Initialized with 6 agents");
  }

  /**
   * Process a mention through the agent swarm
   */
  async processMention(
    mention: Mention,
    priority: Priority = Priority.MEDIUM
  ): Promise<SwarmExecutionResult> {
    const startTime = Date.now();
    this.totalTasks++;

    const task: Task = {
      taskId: generateTaskId(),
      mention,
      account: this.deps.account,
      priority,
      createdAt: Date.now(),
    };

    this.deps.log?.info?.(
      `[SwarmCoordinator] Processing task ${task.taskId} for mention ${mention.id}`
    );

    try {
      // Phase 1: Tier 1 Agents (Parallel)
      const tier1Results = await this.executeTier1(task);
      if (!tier1Results.success) {
        throw new Error(`Tier 1 execution failed: ${tier1Results.error}`);
      }

      // Phase 2: Context Fusion
      const fusedContext = this.fuseContext(
        task.mention,
        tier1Results.contextAnalysis!,
        tier1Results.intentClassification!,
        tier1Results.sentimentAnalysis!
      );

      // Phase 3: Tier 2 Agents (Conditional)
      const tier2Results = await this.executeTier2(task, fusedContext);
      if (!tier2Results.success) {
        throw new Error(`Tier 2 execution failed: ${tier2Results.error}`);
      }

      // Phase 4: Execute Action
      const executionResult = await this.executeAction(
        task,
        tier2Results.actionPlan!,
        tier2Results.generatedContent!,
        tier2Results.verificationResult!
      );

      const executionTimeMs = Date.now() - startTime;
      this.successfulTasks++;
      this.totalExecutionTimeMs += executionTimeMs;

      this.deps.log?.info?.(
        `[SwarmCoordinator] Task ${task.taskId} completed in ${executionTimeMs}ms`
      );

      return {
        success: true,
        actionTaken: executionResult.action,
        content: executionResult.content,
        postId: executionResult.postId,
        executionTimeMs,
        agentMetrics: this.collectAgentMetrics(),
      };
    } catch (error) {
      const executionTimeMs = Date.now() - startTime;
      this.failedTasks++;
      this.totalExecutionTimeMs += executionTimeMs;

      const errorMessage =
        error instanceof Error ? error.message : String(error);
      this.deps.log?.error?.(
        `[SwarmCoordinator] Task ${task.taskId} failed: ${errorMessage}`
      );

      return {
        success: false,
        actionTaken: "none",
        error: errorMessage,
        executionTimeMs,
        agentMetrics: this.collectAgentMetrics(),
      };
    }
  }

  /**
   * Execute Tier 1 agents (Context, Intent, Sentiment)
   */
  private async executeTier1(
    task: Task
  ): Promise<{
    success: boolean;
    contextAnalysis?: ContextAnalysis;
    intentClassification?: IntentClassification;
    sentimentAnalysis?: SentimentAnalysis;
    error?: string;
  }> {
    const mention = task.mention;

    const baseInput: AgentInput = {
      data: { mention },
      metadata: { taskId: task.taskId, accountId: task.account.accountId },
      timestamp: Date.now(),
    };

    if (this.config.enableTier1Parallel) {
      // Execute in parallel
      const [contextResult, intentResult, sentimentResult] = await Promise.all([
        this.contextAnalyzer.execute<ContextAnalysis>(baseInput),
        this.intentClassifier.execute<IntentClassification>(baseInput),
        this.sentimentAnalyzer.execute<SentimentAnalysis>(baseInput),
      ]);

      // Check for failures
      const failures = [
        contextResult,
        intentResult,
        sentimentResult,
      ].filter((r) => r.status === AgentStatus.FAILED);

      if (failures.length > 0) {
        return {
          success: false,
          error: `Tier 1 failures: ${failures
            .map((f) => f.errors?.join(", "))
            .join("; ")}`,
        };
      }

      return {
        success: true,
        contextAnalysis: contextResult.data,
        intentClassification: intentResult.data,
        sentimentAnalysis: sentimentResult.data,
      };
    } else {
      // Execute sequentially
      const contextResult = await this.contextAnalyzer.execute<ContextAnalysis>(
        baseInput
      );
      if (contextResult.status === AgentStatus.FAILED) {
        return { success: false, error: "Context analyzer failed" };
      }

      const intentInput: AgentInput = {
        data: {
          mention,
          contextSummary: contextResult.data.contextSummary,
          threadContext: contextResult.data.threadContext.conversationChain,
        },
        timestamp: Date.now(),
      };
      const intentResult = await this.intentClassifier.execute<IntentClassification>(
        intentInput
      );
      if (intentResult.status === AgentStatus.FAILED) {
        return { success: false, error: "Intent classifier failed" };
      }

      const sentimentInput: AgentInput = {
        data: {
          mention,
          threadContext: contextResult.data.threadContext.conversationChain,
          intentClassification: intentResult.data,
        },
        timestamp: Date.now(),
      };
      const sentimentResult = await this.sentimentAnalyzer.execute<SentimentAnalysis>(
        sentimentInput
      );
      if (sentimentResult.status === AgentStatus.FAILED) {
        return { success: false, error: "Sentiment analyzer failed" };
      }

      return {
        success: true,
        contextAnalysis: contextResult.data,
        intentClassification: intentResult.data,
        sentimentAnalysis: sentimentResult.data,
      };
    }
  }

  /**
   * Fuse Tier 1 outputs into unified context
   */
  private fuseContext(
    mention: Mention,
    contextAnalysis: ContextAnalysis,
    intentClassification: IntentClassification,
    sentimentAnalysis: SentimentAnalysis
  ): FusedContext {
    return {
      mention,
      contextAnalysis,
      intentClassification,
      sentimentAnalysis,
      fusedAt: Date.now(),
    };
  }

  /**
   * Execute Tier 2 agents (ActionPlanner, ContentGenerator, Verification)
   */
  private async executeTier2(
    task: Task,
    fusedContext: FusedContext
  ): Promise<{
    success: boolean;
    actionPlan?: ActionPlan;
    generatedContent?: GeneratedContent;
    verificationResult?: VerificationResult;
    error?: string;
  }> {
    const { mention, contextAnalysis, intentClassification, sentimentAnalysis } =
      fusedContext;

    // Step 1: Action Planning
    const actionInput: AgentInput = {
      data: {
        mention,
        contextAnalysis,
        intentClassification,
        sentimentAnalysis,
        systemConstraints: {
          maxRepliesPerHour: 50,
          maxRepliesPerDay: 200,
        },
      },
      timestamp: Date.now(),
    };

    const actionResult = await this.actionPlanner.execute<ActionPlan>(actionInput);
    if (actionResult.status === AgentStatus.FAILED) {
      return { success: false, error: "Action planner failed" };
    }

    const actionPlan = actionResult.data;

    // Check if we should respond
    if (!actionPlan.decision.shouldRespond) {
      return {
        success: true,
        actionPlan,
        generatedContent: {
          generatedContent: {
            primaryReply: "",
            alternativeVersions: [],
            mediaSuggestions: [],
          },
          contentMetadata: {
            characterCount: 0,
            toneAssessment: "none",
            hashtagsIncluded: [],
            mentionsIncluded: [],
          },
          confidence: 1,
          generationNotes: "Decision: do not respond",
        },
        verificationResult: {
          approved: true,
          violations: [],
          verificationNotes: "No response needed",
        },
      };
    }

    if (this.config.enableTier2Parallel) {
      // Generate content and run verification in parallel
      const contentInput: AgentInput = {
        data: {
          mention,
          contextAnalysis,
          intentClassification,
          sentimentAnalysis,
          actionPlan,
          knowledgeBase: [],
        },
        timestamp: Date.now(),
      };

      const [contentResult] = await Promise.all([
        this.contentGenerator.execute<GeneratedContent>(contentInput),
      ]);

      if (contentResult.status === AgentStatus.FAILED) {
        return { success: false, error: "Content generator failed" };
      }

      // Run verification after content is generated
      const verificationInput: AgentInput = {
        data: {
          mention,
          generatedContent: contentResult.data,
          actionPlan,
        },
        timestamp: Date.now(),
      };

      const verificationResult = await this.verificationAgent.execute<VerificationResult>(
        verificationInput
      );

      if (verificationResult.status === AgentStatus.FAILED) {
        return { success: false, error: "Verification agent failed" };
      }

      return {
        success: true,
        actionPlan,
        generatedContent: contentResult.data,
        verificationResult: verificationResult.data,
      };
    } else {
      // Sequential execution
      const contentInput: AgentInput = {
        data: {
          mention,
          contextAnalysis,
          intentClassification,
          sentimentAnalysis,
          actionPlan,
          knowledgeBase: [],
        },
        timestamp: Date.now(),
      };

      const contentResult = await this.contentGenerator.execute<GeneratedContent>(
        contentInput
      );
      if (contentResult.status === AgentStatus.FAILED) {
        return { success: false, error: "Content generator failed" };
      }

      const verificationInput: AgentInput = {
        data: {
          mention,
          generatedContent: contentResult.data,
          actionPlan,
        },
        timestamp: Date.now(),
      };

      const verificationResult = await this.verificationAgent.execute<VerificationResult>(
        verificationInput
      );
      if (verificationResult.status === AgentStatus.FAILED) {
        return { success: false, error: "Verification agent failed" };
      }

      return {
        success: true,
        actionPlan,
        generatedContent: contentResult.data,
        verificationResult: verificationResult.data,
      };
    }
  }

  /**
   * Execute the final action (post reply, like, etc.)
   */
  private async executeAction(
    task: Task,
    actionPlan: ActionPlan,
    generatedContent: GeneratedContent,
    verificationResult: VerificationResult
  ): Promise<{
    action: string;
    content?: string;
    postId?: string;
  }> {
    // Check verification
    if (!verificationResult.approved) {
      this.deps.log?.warn?.(
        `[SwarmCoordinator] Content rejected by verification: ${verificationResult.verificationNotes}`
      );
      return { action: "rejected" };
    }

    const decision = actionPlan.decision;

    switch (decision.responseType) {
      case "reply": {
        const content =
          verificationResult.modifiedContent ??
          generatedContent.generatedContent.primaryReply;

        if (!content) {
          return { action: "no_content" };
        }

        const result = await this.deps.xApiClient.createPost({
          text: content,
          inReplyToPostId: task.mention.id,
        });

        if (result.ok) {
          return { action: "replied", content, postId: result.postId };
        } else {
          throw new Error(`Failed to post reply: ${result.error}`);
        }
      }

      case "like":
        // Like functionality would need to be added to XApiClient
        this.deps.log?.info?.(`[SwarmCoordinator] Like action not implemented`);
        return { action: "like_not_implemented" };

      case "retweet":
        // Retweet functionality would need to be added to XApiClient
        this.deps.log?.info?.(
          `[SwarmCoordinator] Retweet action not implemented`
        );
        return { action: "retweet_not_implemented" };

      case "ignore":
        return { action: "ignored" };

      case "escalate":
        return { action: "escalated" };

      default:
        return { action: `unknown_${decision.responseType}` };
    }
  }

  /**
   * Collect metrics from all agents
   */
  private collectAgentMetrics() {
    return [
      this.contextAnalyzer.getMetrics(),
      this.intentClassifier.getMetrics(),
      this.sentimentAnalyzer.getMetrics(),
      this.actionPlanner.getMetrics(),
      this.contentGenerator.getMetrics(),
      this.verificationAgent.getMetrics(),
    ];
  }

  /**
   * Get coordinator metrics
   */
  getMetrics() {
    const total = this.totalTasks;
    return {
      totalTasks: this.totalTasks,
      successfulTasks: this.successfulTasks,
      failedTasks: this.failedTasks,
      successRate: total > 0 ? this.successfulTasks / total : 0,
      averageExecutionTimeMs:
        total > 0 ? this.totalExecutionTimeMs / total : 0,
      agentMetrics: this.collectAgentMetrics(),
      messageBusMetrics: this.messageBus.getMetrics(),
    };
  }

  /**
   * Reset all agents and metrics
   */
  reset(): void {
    this.contextAnalyzer.reset();
    this.intentClassifier.reset();
    this.sentimentAnalyzer.reset();
    this.actionPlanner.reset();
    this.contentGenerator.reset();
    this.verificationAgent.reset();

    this.totalTasks = 0;
    this.successfulTasks = 0;
    this.failedTasks = 0;
    this.totalExecutionTimeMs = 0;
  }
}

function generateTaskId(): string {
  return `task-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}
