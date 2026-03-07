/**
 * Agent Swarm Types
 * 
 * Core type definitions for the X Agent Swarm system.
 * Integrates with OpenClaw's X channel plugin.
 */

import type { XApiClient } from "../x-api-client.js";
import type { ResolvedXAccount } from "../types.js";
import type { ChannelLogSink } from "openclaw/plugin-sdk";

// ═══════════════════════════════════════════════════════════════════════════════
// Enums
// ═══════════════════════════════════════════════════════════════════════════════

export enum AgentStatus {
  IDLE = "idle",
  RUNNING = "running",
  COMPLETED = "completed",
  FAILED = "failed",
  WAITING = "waiting",
}

export enum IntentCategory {
  QUESTION = "question",
  REQUEST = "request",
  FEEDBACK = "feedback",
  SOCIAL = "social",
  PROMOTIONAL = "promotional",
  ESCALATION = "escalation",
}

export enum SentimentPolarity {
  VERY_POSITIVE = "very_positive",
  POSITIVE = "positive",
  NEUTRAL = "neutral",
  NEGATIVE = "negative",
  VERY_NEGATIVE = "very_negative",
}

export enum UrgencyLevel {
  CRITICAL = "critical",
  HIGH = "high",
  MEDIUM = "medium",
  LOW = "low",
}

export enum Priority {
  CRITICAL = 0,
  HIGH = 1,
  MEDIUM = 2,
  LOW = 3,
  BACKGROUND = 4,
}

export enum MessageType {
  TASK_ASSIGN = "task_assign",
  TASK_RESULT = "task_result",
  TASK_CANCEL = "task_cancel",
  HEARTBEAT = "heartbeat",
  BROADCAST = "broadcast",
  ERROR = "error",
  DIRECT = "direct",
}

// ═══════════════════════════════════════════════════════════════════════════════
// Core Data Structures
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Represents an incoming X mention/tweet
 */
export interface Mention {
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
}

/**
 * Context analysis result from ContextAnalyzer agent
 */
export interface ContextAnalysis {
  threadContext: {
    conversationChain: ThreadPost[];
    rootTweet: ThreadPost | null;
    participants: string[];
    conversationTopic: string;
    conversationDurationMinutes: number;
  };
  userContext: {
    relationshipType: "new" | "follower" | "frequent_interactor";
    previousInteractionsCount: number;
    lastInteractionDate?: string;
    userBioSummary?: string;
    followerCount?: number;
    accountAgeDays?: number;
    typicalEngagementWithUs: "none" | "low" | "medium" | "high";
  };
  ourPreviousResponses: ThreadPost[];
  contextSummary: string;
}

export interface ThreadPost {
  id: string;
  text: string;
  authorId: string;
  authorUsername?: string;
  createdAt?: string;
  conversationId?: string;
}

/**
 * Intent classification result from IntentClassifier agent
 */
export interface IntentClassification {
  primaryIntent: string;
  confidence: number;
  secondaryIntents: string[];
  explicitAsk: string | null;
  implicitNeeds: string[];
  urgencyLevel: UrgencyLevel;
  requiresHumanReview: boolean;
  classificationReasoning: string;
}

/**
 * Sentiment analysis result from SentimentAnalyzer agent
 */
export interface SentimentAnalysis {
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
}

/**
 * Action plan from ActionPlanner agent
 */
export interface ActionPlan {
  decision: {
    shouldRespond: boolean;
    responseType: "reply" | "like" | "retweet" | "escalate" | "ignore";
    priority: UrgencyLevel;
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
}

/**
 * Generated content from ContentGenerator agent
 */
export interface GeneratedContent {
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
}

/**
 * Verification result from VerificationAgent
 */
export interface VerificationResult {
  approved: boolean;
  violations: Array<{
    type: string;
    severity: "low" | "medium" | "high";
    description: string;
  }>;
  modifiedContent?: string;
  verificationNotes: string;
}

/**
 * Fused context combining all Tier-1 agent outputs
 */
export interface FusedContext {
  mention: Mention;
  contextAnalysis: ContextAnalysis;
  intentClassification: IntentClassification;
  sentimentAnalysis: SentimentAnalysis;
  fusedAt: number;
}

/**
 * Final execution result
 */
export interface SwarmExecutionResult {
  success: boolean;
  actionTaken: string;
  content?: string;
  postId?: string;
  error?: string;
  executionTimeMs: number;
  agentMetrics: AgentMetrics[];
}

export interface AgentMetrics {
  agentId: string;
  agentName: string;
  executionTimeMs: number;
  status: AgentStatus;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Agent Interfaces
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Input to an agent
 */
export interface AgentInput {
  data: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  sessionId?: string;
  timestamp?: number;
}

/**
 * Output from an agent
 */
export interface AgentOutput<T = unknown> {
  data: T;
  status: AgentStatus;
  executionTimeMs: number;
  agentId: string;
  errors?: string[];
  warnings?: string[];
}

/**
 * Base agent configuration
 */
export interface AgentConfig {
  agentId: string;
  xApiClient: XApiClient;
  log?: ChannelLogSink;
  llmConfig?: LLMConfig;
  timeoutMs?: number;
}

export interface LLMConfig {
  apiKey: string;
  model?: string;
  temperature?: number;
  maxTokens?: number;
  baseUrl?: string;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Message Bus Types
// ═══════════════════════════════════════════════════════════════════════════════

export interface AgentId {
  agentId: string;
  agentType: "coordinator" | "worker" | "monitor";
  instanceId?: string;
}

export interface MessageHeader {
  version: string;
  messageType: MessageType;
  priority: number;
  sender: AgentId;
  recipient: AgentId;
  deliveryMode: "direct" | "broadcast" | "topic";
}

export interface Message {
  messageId: string;
  correlationId: string;
  timestamp: string;
  ttl: number;
  header: MessageHeader;
  payload: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Coordinator Types
// ═══════════════════════════════════════════════════════════════════════════════

export interface SwarmCoordinatorConfig {
  maxConcurrentTasks: number;
  taskTimeoutMs: number;
  enableTier1Parallel: boolean;
  enableTier2Parallel: boolean;
  cacheResults: boolean;
  cacheTtlMs: number;
}

export interface Task {
  taskId: string;
  mention: Mention;
  account: ResolvedXAccount;
  priority: Priority;
  createdAt: number;
  deadline?: number;
}

export interface SwarmContext {
  xApiClient: XApiClient;
  account: ResolvedXAccount;
  log?: ChannelLogSink;
  llmConfig?: LLMConfig;
}
