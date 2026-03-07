/**
 * X Agent Swarm
 * 
 * Multi-agent system for autonomous X (Twitter) interactions.
 * Integrates with OpenClaw's X channel plugin.
 */

// Core exports
export { SwarmCoordinator } from "./coordinator.js";
export { MessageBus } from "./communication/message-bus.js";
export { LLMClient } from "./llm-client.js";

// Agent exports
export {
  BaseAgent,
  ContextAnalyzerAgent,
  IntentClassifierAgent,
  SentimentAnalyzerAgent,
  ActionPlannerAgent,
  ContentGeneratorAgent,
  VerificationAgent,
} from "./agents/index.js";

// Type exports
export type {
  Mention,
  Task,
  Priority,
  SwarmCoordinatorConfig,
  SwarmExecutionResult,
  FusedContext,
  ContextAnalysis,
  IntentClassification,
  SentimentAnalysis,
  ActionPlan,
  GeneratedContent,
  VerificationResult,
  AgentStatus,
  AgentInput,
  AgentOutput,
  AgentConfig,
  LLMConfig,
  Message,
  MessageType,
  AgentId,
} from "./types.js";
