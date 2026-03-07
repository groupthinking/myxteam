/**
 * Base Agent
 * 
 * Abstract base class for all swarm agents.
 * Provides common functionality for agent lifecycle, metrics, and error handling.
 */

import type { ChannelLogSink } from "openclaw/plugin-sdk";
import type { XApiClient } from "../../x-api-client.js";
import {
  AgentStatus,
  AgentInput,
  AgentOutput,
  AgentConfig,
  LLMConfig,
  Mention,
} from "../types.js";
import { LLMClient } from "../llm-client.js";

export interface BaseAgentConfig extends AgentConfig {
  name: string;
  description: string;
}

/**
 * Abstract base class for all swarm agents
 */
export abstract class BaseAgent {
  protected agentId: string;
  protected name: string;
  protected description: string;
  protected xApiClient: XApiClient;
  protected llmClient: LLMClient;
  protected log?: ChannelLogSink;
  protected timeoutMs: number;

  private status: AgentStatus = AgentStatus.IDLE;
  private executionCount = 0;
  private totalExecutionTimeMs = 0;
  private lastError?: string;

  constructor(config: BaseAgentConfig) {
    this.agentId = config.agentId;
    this.name = config.name;
    this.description = config.description;
    this.xApiClient = config.xApiClient;
    this.log = config.log;
    this.timeoutMs = config.timeoutMs ?? 30000;

    if (!config.llmConfig) {
      throw new Error(`LLM config required for agent ${this.agentId}`);
    }
    this.llmClient = new LLMClient(config.llmConfig, config.log);
  }

  /**
   * Get agent name
   */
  getName(): string {
    return this.name;
  }

  /**
   * Get agent description
   */
  getDescription(): string {
    return this.description;
  }

  /**
   * Get current status
   */
  getStatus(): AgentStatus {
    return this.status;
  }

  /**
   * Get agent metrics
   */
  getMetrics(): {
    agentId: string;
    name: string;
    executionCount: number;
    averageExecutionTimeMs: number;
    totalExecutionTimeMs: number;
    lastError?: string;
  } {
    return {
      agentId: this.agentId,
      name: this.name,
      executionCount: this.executionCount,
      averageExecutionTimeMs:
        this.executionCount > 0
          ? this.totalExecutionTimeMs / this.executionCount
          : 0,
      totalExecutionTimeMs: this.totalExecutionTimeMs,
      lastError: this.lastError,
    };
  }

  /**
   * Execute the agent with input data
   */
  async execute<T>(input: AgentInput): Promise<AgentOutput<T>> {
    const startTime = Date.now();
    this.status = AgentStatus.RUNNING;
    this.lastError = undefined;

    try {
      // Validate input
      const validation = this.validateInput(input);
      if (!validation.valid) {
        throw new Error(`Invalid input: ${validation.errors.join(", ")}`);
      }

      // Execute with timeout
      const result = await this.executeWithTimeout(input);

      const executionTimeMs = Date.now() - startTime;
      this.executionCount++;
      this.totalExecutionTimeMs += executionTimeMs;
      this.status = AgentStatus.COMPLETED;

      this.log?.debug?.(
        `[${this.agentId}] Completed in ${executionTimeMs}ms`
      );

      return {
        data: result as T,
        status: AgentStatus.COMPLETED,
        executionTimeMs,
        agentId: this.agentId,
      };
    } catch (error) {
      const executionTimeMs = Date.now() - startTime;
      this.lastError =
        error instanceof Error ? error.message : String(error);
      this.status = AgentStatus.FAILED;

      this.log?.error?.(`[${this.agentId}] Failed: ${this.lastError}`);

      return {
        data: {} as T,
        status: AgentStatus.FAILED,
        executionTimeMs,
        agentId: this.agentId,
        errors: [this.lastError],
      };
    }
  }

  /**
   * Execute with timeout wrapper
   */
  private async executeWithTimeout(
    input: AgentInput
  ): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        reject(new Error(`Agent ${this.agentId} timed out after ${this.timeoutMs}ms`));
      }, this.timeoutMs);

      this.process(input)
        .then((result) => {
          clearTimeout(timeoutId);
          resolve(result);
        })
        .catch((error) => {
          clearTimeout(timeoutId);
          reject(error);
        });
    });
  }

  /**
   * Reset agent state
   */
  reset(): void {
    this.status = AgentStatus.IDLE;
    this.lastError = undefined;
  }

  /**
   * Validate input before processing
   * Override in subclass for custom validation
   */
  protected validateInput(input: AgentInput): {
    valid: boolean;
    errors: string[];
  } {
    const requiredFields = this.getRequiredInputFields();
    const errors: string[] = [];

    for (const field of requiredFields) {
      if (!(field in input.data)) {
        errors.push(`Missing required field: ${field}`);
      }
    }

    return { valid: errors.length === 0, errors };
  }

  /**
   * Get list of required input fields
   * Override in subclass
   */
  protected abstract getRequiredInputFields(): string[];

  /**
   * Main processing logic
   * Override in subclass
   */
  protected abstract process(input: AgentInput): Promise<unknown>;

  /**
   * Helper: Extract mention from input
   */
  protected extractMention(input: AgentInput): Mention {
    return input.data.mention as Mention;
  }

  /**
   * Helper: Get LLM metrics
   */
  getLLMMetrics(): ReturnType<LLMClient["getMetrics"]> {
    return this.llmClient.getMetrics();
  }
}
