/**
 * Channel Event Bus
 *
 * Lightweight, typed event emitter for internal event routing within the
 * X channel plugin. Simplified event bus with no agent IDs, no message
 * headers, no TTLs — just topic → handler.
 *
 * Usage:
 *   const bus = new ChannelEventBus(log);
 *   bus.on("smart-reply:classified", (data) => { ... });
 *   bus.emit("smart-reply:classified", { mentionId: "123", classification });
 */

import type { ChannelLogSink } from "openclaw/plugin-sdk";

export type EventHandler<T = unknown> = (data: T) => void | Promise<void>;

/**
 * Simple topic-based event bus for the X channel plugin.
 */
export class ChannelEventBus {
  private readonly handlers = new Map<string, EventHandler[]>();
  private readonly log?: ChannelLogSink;

  constructor(log?: ChannelLogSink) {
    this.log = log;
  }

  /**
   * Subscribe to a topic. Returns an unsubscribe function.
   */
  on<T = unknown>(topic: string, handler: EventHandler<T>): () => void {
    if (!this.handlers.has(topic)) {
      this.handlers.set(topic, []);
    }
    this.handlers.get(topic)!.push(handler as EventHandler);

    return () => {
      const list = this.handlers.get(topic);
      if (list) {
        const idx = list.indexOf(handler as EventHandler);
        if (idx !== -1) list.splice(idx, 1);
      }
    };
  }

  /**
   * Emit an event to all handlers subscribed to the topic.
   */
  async emit<T = unknown>(topic: string, data: T): Promise<void> {
    const list = this.handlers.get(topic);
    if (!list || list.length === 0) return;

    for (const handler of list) {
      try {
        await handler(data);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.log?.error?.(`[EventBus] Handler error on "${topic}": ${msg}`);
      }
    }
  }

  /**
   * Remove all handlers (useful for teardown / tests).
   */
  clear(): void {
    this.handlers.clear();
  }
}
