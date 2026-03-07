/**
 * Swarm Integration for X Channel
 * 
 * This file shows how to integrate the SwarmCoordinator into the existing
 * X channel's channel.ts file.
 * 
 * Usage: Replace the existing mention handling logic in channel.ts with
 * the swarm-based processing shown below.
 */

import type { ChannelPlugin, ChannelConfig, SendTextParams } from "openclaw/plugin-sdk";
import type { OpenClawConfig } from "openclaw/plugin-sdk";
import { XApiClient } from "./x-api-client.js";
import { resolveXAccount, findAccountByUsername, ResolvedXAccount } from "./types.js";
import { getXRuntime } from "./runtime.js";
import { updateThreadState, resolveReplyToId } from "./thread-state.js";
import { StreamHandler } from "./stream-handler.js";
import { checkCreditBudget } from "./credit-budget.js";

// Swarm imports
import {
  SwarmCoordinator,
  SwarmCoordinatorConfig,
  Mention,
  Priority,
} from "./swarm/index.js";

/**
 * Extended X channel configuration with swarm settings
 */
interface XChannelConfigWithSwarm extends ChannelConfig {
  swarm?: SwarmCoordinatorConfig;
  llmConfig?: {
    apiKey: string;
    model?: string;
    temperature?: number;
    maxTokens?: number;
  };
}

/**
 * XChannelPlugin with Swarm Integration
 * 
 * This is a modified version of channel.ts that uses the SwarmCoordinator
 * for processing mentions instead of direct handling.
 */
export class XChannelPluginWithSwarm implements ChannelPlugin {
  readonly id = "x";
  readonly name = "X (Twitter)";

  private config?: XChannelConfigWithSwarm;
  private runtimeConfig?: OpenClawConfig;
  private streamHandler?: StreamHandler;
  private xApiClients: Map<string, XApiClient> = new Map();
  private swarmCoordinators: Map<string, SwarmCoordinator> = new Map();
  private log = getXRuntime().log;

  async initialize(config: XChannelConfigWithSwarm): Promise<void> {
    this.config = config;
    this.runtimeConfig = getXRuntime().config;

    this.log.info("[XChannel] Initializing with swarm support...");

    // Validate credit budget
    const budgetOk = await checkCreditBudget(this.runtimeConfig, this.log);
    if (!budgetOk) {
      throw new Error("Credit budget exceeded");
    }

    // Initialize X API clients for each account
    const accountIds = Object.keys(
      (this.runtimeConfig.channels as Record<string, { accounts?: Record<string, unknown> }>)?.x
        ?.accounts ?? {}
    );

    for (const accountId of accountIds) {
      const account = resolveXAccount({
        cfg: this.runtimeConfig,
        accountId,
      });

      if (!account.configured || !account.enabled) {
        this.log.warn(`[XChannel] Account ${accountId} not configured or disabled`);
        continue;
      }

      // Create X API client
      const xApiClient = new XApiClient({
        accessToken: account.accessToken,
        oauth1Credentials:
          account.authMode === "oauth1"
            ? {
                consumerKey: account.oauth1ConsumerKey ?? "",
                consumerSecret: account.oauth1ConsumerSecret ?? "",
                accessToken: account.oauth1AccessToken ?? "",
                accessTokenSecret: account.oauth1AccessTokenSecret ?? "",
              }
            : undefined,
        authMode: account.authMode,
        accountId: account.accountId,
        log: this.log,
      });

      this.xApiClients.set(accountId, xApiClient);

      // Create SwarmCoordinator for this account
      const swarmConfig: SwarmCoordinatorConfig = {
        maxConcurrentTasks: 5,
        taskTimeoutMs: 30000,
        enableTier1Parallel: true,
        enableTier2Parallel: true,
        cacheResults: true,
        cacheTtlMs: 3600000,
        ...config.swarm,
      };

      const llmConfig = config.llmConfig ?? {
        apiKey: process.env.XAI_API_KEY ?? "",
        model: "grok-2",
        temperature: 0.7,
        maxTokens: 1000,
      };

      if (!llmConfig.apiKey) {
        this.log.warn(
          `[XChannel] XAI_API_KEY not set, swarm will not function`
        );
      }

      const swarmCoordinator = new SwarmCoordinator(swarmConfig, {
        xApiClient,
        account,
        log: this.log,
        llmConfig,
      });

      this.swarmCoordinators.set(accountId, swarmCoordinator);
      this.log.info(`[XChannel] Swarm coordinator initialized for ${accountId}`);
    }

    // Initialize stream handler
    this.streamHandler = new StreamHandler({
      bearerToken: resolveAppBearerToken(this.runtimeConfig) ?? "",
      agentUsernames: this.getAgentUsernames(),
      onMention: this.handleMention.bind(this),
      log: this.log,
    });

    this.log.info("[XChannel] Initialization complete with swarm");
  }

  async start(): Promise<void> {
    this.log.info("[XChannel] Starting with swarm...");
    await this.streamHandler?.start();
  }

  async stop(): Promise<void> {
    this.log.info("[XChannel] Stopping...");
    await this.streamHandler?.stop();
  }

  /**
   * Handle incoming mention using swarm
   */
  private async handleMention(tweet: {
    id: string;
    text: string;
    authorId: string;
    authorUsername: string;
    createdAt: string;
    conversationId: string;
    inReplyToTweetId?: string;
    publicMetrics?: {
      retweetCount?: number;
      replyCount?: number;
      likeCount?: number;
      quoteCount?: number;
    };
    mentionedUsernames: string[];
  }): Promise<void> {
    this.log.info(
      `[XChannel] Mention from @${tweet.authorUsername}: ${tweet.text.slice(0, 50)}...`
    );

    // Find which agent was mentioned
    const mentionedAgent = tweet.mentionedUsernames.find((username) =>
      this.getAgentUsernames().includes(username.toLowerCase())
    );

    if (!mentionedAgent) {
      this.log.warn(`[XChannel] No matching agent for mention`);
      return;
    }

    // Find account for this agent
    const account = findAccountByUsername(this.runtimeConfig!, mentionedAgent);
    if (!account) {
      this.log.error(`[XChannel] No account found for @${mentionedAgent}`);
      return;
    }

    const swarmCoordinator = this.swarmCoordinators.get(account.accountId);
    if (!swarmCoordinator) {
      this.log.error(`[XChannel] No swarm coordinator for ${account.accountId}`);
      return;
    }

    // Convert to Mention type
    const mention: Mention = {
      id: tweet.id,
      text: tweet.text,
      authorId: tweet.authorId,
      authorUsername: tweet.authorUsername,
      createdAt: tweet.createdAt,
      conversationId: tweet.conversationId,
      inReplyToTweetId: tweet.inReplyToTweetId,
      publicMetrics: tweet.publicMetrics,
    };

    // Process through swarm
    const result = await swarmCoordinator.processMention(mention, Priority.HIGH);

    if (result.success) {
      this.log.info(
        `[XChannel] Swarm processed mention in ${result.executionTimeMs}ms, action: ${result.actionTaken}`
      );

      // Update thread state if a reply was posted
      if (result.postId && result.content) {
        updateThreadState(tweet.conversationId, result.postId);
      }
    } else {
      this.log.error(`[XChannel] Swarm failed: ${result.error}`);
    }

    // Log agent metrics
    const metrics = swarmCoordinator.getMetrics();
    this.log.debug?.(
      `[XChannel] Swarm metrics: ${JSON.stringify(metrics, null, 2)}`
    );
  }

  /**
   * Send text (used by OpenClaw for outgoing messages)
   */
  async sendText(params: SendTextParams): Promise<void> {
    const { chatId, text, replyToId, accountId } = params;

    const account = resolveXAccount({
      cfg: this.runtimeConfig!,
      accountId: accountId ?? null,
    });

    const xApiClient = this.xApiClients.get(account.accountId);
    if (!xApiClient) {
      throw new Error(`No X API client for account ${account.accountId}`);
    }

    // Resolve reply target (thread-aware)
    const resolvedReplyToId = resolveReplyToId(chatId, replyToId);

    const result = await xApiClient.createPost({
      text,
      inReplyToPostId: resolvedReplyToId,
    });

    if (!result.ok) {
      throw new Error(`Failed to send text: ${result.error}`);
    }

    // Update thread state
    if (result.postId) {
      updateThreadState(chatId, result.postId);
    }
  }

  /**
   * Get all configured agent usernames
   */
  private getAgentUsernames(): string[] {
    const usernames: string[] = [];
    const accounts =
      (this.runtimeConfig?.channels as Record<string, { accounts?: Record<string, { agentUsername?: string }> }>)?.x
        ?.accounts ?? {};

    for (const [, accountConfig] of Object.entries(accounts)) {
      if (accountConfig.agentUsername) {
        usernames.push(accountConfig.agentUsername.toLowerCase());
      }
    }

    return usernames;
  }
}

// Helper function (should be in types.ts)
function resolveAppBearerToken(cfg: OpenClawConfig): string | undefined {
  const channels = cfg.channels as Record<string, { bearerToken?: string }> | undefined;
  return channels?.x?.bearerToken?.trim();
}
