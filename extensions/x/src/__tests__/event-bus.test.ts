/**
 * Channel Event Bus Tests
 */

import { describe, it, expect, vi } from "vitest";
import { ChannelEventBus } from "../event-bus.js";

describe("ChannelEventBus", () => {
  describe("on / emit", () => {
    it("should deliver events to subscribed handlers", async () => {
      const bus = new ChannelEventBus();
      const handler = vi.fn();

      bus.on("test:event", handler);
      await bus.emit("test:event", { value: 42 });

      expect(handler).toHaveBeenCalledWith({ value: 42 });
    });

    it("should support multiple handlers on the same topic", async () => {
      const bus = new ChannelEventBus();
      const h1 = vi.fn();
      const h2 = vi.fn();

      bus.on("topic", h1);
      bus.on("topic", h2);
      await bus.emit("topic", "data");

      expect(h1).toHaveBeenCalledWith("data");
      expect(h2).toHaveBeenCalledWith("data");
    });

    it("should not deliver events to unrelated topics", async () => {
      const bus = new ChannelEventBus();
      const handler = vi.fn();

      bus.on("topic-a", handler);
      await bus.emit("topic-b", "data");

      expect(handler).not.toHaveBeenCalled();
    });

    it("should handle async handlers", async () => {
      const bus = new ChannelEventBus();
      const results: number[] = [];

      bus.on("async", async (data: unknown) => {
        await new Promise((r) => setTimeout(r, 10));
        results.push(data as number);
      });

      await bus.emit("async", 1);
      expect(results).toEqual([1]);
    });

    it("should catch and log handler errors without breaking other handlers", async () => {
      const mockLog = { error: vi.fn() } as any;
      const bus = new ChannelEventBus(mockLog);
      const h1 = vi.fn().mockRejectedValue(new Error("boom"));
      const h2 = vi.fn();

      bus.on("topic", h1);
      bus.on("topic", h2);
      await bus.emit("topic", "data");

      expect(h1).toHaveBeenCalled();
      expect(h2).toHaveBeenCalled();
      expect(mockLog.error).toHaveBeenCalledWith(
        expect.stringContaining("boom"),
      );
    });
  });

  describe("unsubscribe", () => {
    it("should stop delivering events after unsubscribe", async () => {
      const bus = new ChannelEventBus();
      const handler = vi.fn();

      const unsub = bus.on("topic", handler);
      await bus.emit("topic", "first");
      expect(handler).toHaveBeenCalledTimes(1);

      unsub();
      await bus.emit("topic", "second");
      expect(handler).toHaveBeenCalledTimes(1); // Still 1
    });
  });

  describe("clear", () => {
    it("should remove all handlers", async () => {
      const bus = new ChannelEventBus();
      const handler = vi.fn();

      bus.on("a", handler);
      bus.on("b", handler);
      bus.clear();

      await bus.emit("a", "data");
      await bus.emit("b", "data");
      expect(handler).not.toHaveBeenCalled();
    });
  });

  describe("no subscribers", () => {
    it("should silently ignore emits with no subscribers", async () => {
      const bus = new ChannelEventBus();
      // Should not throw
      await bus.emit("nonexistent", "data");
    });
  });
});
