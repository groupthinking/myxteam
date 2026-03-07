/**
 * Message Bus
 * 
 * High-performance inter-agent communication system.
 * Supports in-process messaging with sub-millisecond latency.
 */

import type { ChannelLogSink } from "openclaw/plugin-sdk";
import {
  Message,
  MessageType,
  AgentId,
  AgentStatus,
  AgentOutput,
} from "../types.js";

export type MessageHandler = (message: Message) => void | Promise<void>;

interface Subscription {
  agentId: string;
  handler: MessageHandler;
  messageTypes: MessageType[];
}

/**
 * In-process message bus for agent communication
 */
export class MessageBus {
  private subscriptions: Map<string, Subscription[]> = new Map();
  private log?: ChannelLogSink;
  private messageCount = 0;
  private startTime = Date.now();

  constructor(log?: ChannelLogSink) {
    this.log = log;
  }

  /**
   * Subscribe to messages
   */
  subscribe(
    agentId: string,
    handler: MessageHandler,
    messageTypes: MessageType[] = [MessageType.DIRECT]
  ): () => void {
    const subscription: Subscription = { agentId, handler, messageTypes };

    if (!this.subscriptions.has(agentId)) {
      this.subscriptions.set(agentId, []);
    }
    this.subscriptions.get(agentId)!.push(subscription);

    this.log?.debug?.(`[MessageBus] ${agentId} subscribed to ${messageTypes.join(", ")}`);

    // Return unsubscribe function
    return () => {
      const subs = this.subscriptions.get(agentId);
      if (subs) {
        const index = subs.indexOf(subscription);
        if (index > -1) subs.splice(index, 1);
      }
    };
  }

  /**
   * Send message to specific agent
   */
  async send(message: Message): Promise<void> {
    this.messageCount++;

    const recipientId = message.header.recipient.agentId;

    if (recipientId === "*") {
      // Broadcast to all subscribers
      await this.broadcast(message);
      return;
    }

    const subs = this.subscriptions.get(recipientId);
    if (!subs || subs.length === 0) {
      this.log?.warn?.(`[MessageBus] No subscribers for ${recipientId}`);
      return;
    }

    // Find matching subscriptions
    const matchingSubs = subs.filter(
      (sub) =>
        sub.messageTypes.includes(message.header.messageType) ||
        sub.messageTypes.includes(MessageType.DIRECT)
    );

    // Deliver to all matching subscribers
    await Promise.all(
      matchingSubs.map(async (sub) => {
        try {
          await sub.handler(message);
        } catch (error) {
          this.log?.error?.(
            `[MessageBus] Handler error for ${recipientId}: ${
              error instanceof Error ? error.message : String(error)
            }`
          );
        }
      })
    );
  }

  /**
   * Broadcast message to all subscribers
   */
  private async broadcast(message: Message): Promise<void> {
    const allSubs = Array.from(this.subscriptions.values()).flat();

    await Promise.all(
      allSubs.map(async (sub) => {
        try {
          await sub.handler(message);
        } catch (error) {
          this.log?.error?.(
            `[MessageBus] Broadcast handler error: ${
              error instanceof Error ? error.message : String(error)
            }`
          );
        }
      })
    );
  }

  /**
   * Create a task assignment message
   */
  static createTaskMessage(
    sender: AgentId,
    recipient: AgentId,
    taskType: string,
    parameters: Record<string, unknown>,
    correlationId?: string
  ): Message {
    return {
      messageId: generateId(),
      correlationId: correlationId ?? generateId(),
      timestamp: new Date().toISOString(),
      ttl: 30,
      header: {
        version: "1.0",
        messageType: MessageType.TASK_ASSIGN,
        priority: 5,
        sender,
        recipient,
        deliveryMode: "direct",
      },
      payload: {
        taskType,
        parameters,
      },
    };
  }

  /**
   * Create a task result message
   */
  static createResultMessage<T>(
    sender: AgentId,
    recipient: AgentId,
    correlationId: string,
    result: AgentOutput<T>
  ): Message {
    return {
      messageId: generateId(),
      correlationId,
      timestamp: new Date().toISOString(),
      ttl: 30,
      header: {
        version: "1.0",
        messageType: MessageType.TASK_RESULT,
        priority: 5,
        sender,
        recipient,
        deliveryMode: "direct",
      },
      payload: {
        result: {
          data: result.data,
          status: result.status,
          executionTimeMs: result.executionTimeMs,
          agentId: result.agentId,
          errors: result.errors,
          warnings: result.warnings,
        },
      },
    };
  }

  /**
   * Get message bus metrics
   */
  getMetrics(): {
    totalMessages: number;
    messagesPerSecond: number;
    subscriberCount: number;
  } {
    const elapsedSeconds = (Date.now() - this.startTime) / 1000;
    return {
      totalMessages: this.messageCount,
      messagesPerSecond: elapsedSeconds > 0 ? this.messageCount / elapsedSeconds : 0,
      subscriberCount: this.subscriptions.size,
    };
  }
}

function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}
