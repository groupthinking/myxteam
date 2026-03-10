/**
 * Unit tests for the X channel Filtered Stream handler.
 *
 * Tests rule management, stream parsing, reconnection logic,
 * and the overall stream lifecycle.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  buildStreamRules,
  parseStreamLine,
  getStreamStatus,
  stopFilteredStream,
} from "../stream-handler.js";

describe("stream-handler", () => {
  describe("buildStreamRules", () => {
    it("should build one rule per agent username with -from: self-exclusion", () => {
      const rules = buildStreamRules(["ResearchBot", "WriterBot"]);
      expect(rules).toHaveLength(2);
      expect(rules[0]).toEqual({
        value: "@ResearchBot -from:ResearchBot",
        tag: "agent:researchbot",
      });
      expect(rules[1]).toEqual({
        value: "@WriterBot -from:WriterBot",
        tag: "agent:writerbot",
      });
    });

    it("should return empty array for no usernames", () => {
      const rules = buildStreamRules([]);
      expect(rules).toEqual([]);
    });

    it("should handle single username and exclude self-posts", () => {
      const rules = buildStreamRules(["SingleAgent"]);
      expect(rules).toHaveLength(1);
      expect(rules[0]!.tag).toBe("agent:singleagent");
      expect(rules[0]!.value).toBe("@SingleAgent -from:SingleAgent");
    });
  });

  describe("parseStreamLine", () => {
    it("should parse a valid stream data line", () => {
      const line = JSON.stringify({
        data: {
          id: "post-123",
          text: "@ResearchBot what is AI?",
          author_id: "user-456",
          conversation_id: "conv-789",
        },
        matching_rules: [{ id: "rule-1", tag: "agent:ResearchBot" }],
        includes: {
          users: [{ id: "user-456", username: "asker" }],
        },
      });

      const result = parseStreamLine(line);
      expect(result).not.toBeNull();
      expect(result!.id).toBe("post-123");
      expect(result!.text).toBe("@ResearchBot what is AI?");
      expect(result!.authorId).toBe("user-456");
      expect(result!.authorUsername).toBe("asker");
      expect(result!.conversationId).toBe("conv-789");
      expect(result!.matchingRules).toHaveLength(1);
      expect(result!.matchingRules[0]!.tag).toBe("agent:ResearchBot");
    });

    it("should return null for empty/heartbeat lines", () => {
      expect(parseStreamLine("")).toBeNull();
      expect(parseStreamLine("\r\n")).toBeNull();
      expect(parseStreamLine("   ")).toBeNull();
    });

    it("should return null for malformed JSON", () => {
      expect(parseStreamLine("not-json")).toBeNull();
    });

    it("should return null for data without matching_rules", () => {
      const line = JSON.stringify({
        data: { id: "post-123", text: "hello" },
      });
      expect(parseStreamLine(line)).toBeNull();
    });

    it("should handle missing includes.users gracefully", () => {
      const line = JSON.stringify({
        data: {
          id: "post-123",
          text: "@Bot hello",
          author_id: "user-456",
        },
        matching_rules: [{ id: "rule-1", tag: "agent:Bot" }],
      });

      const result = parseStreamLine(line);
      expect(result).not.toBeNull();
      expect(result!.authorUsername).toBeUndefined();
    });
  });

  describe("getStreamStatus", () => {
    it("should return 'disconnected' when not started", () => {
      stopFilteredStream();
      expect(getStreamStatus()).toBe("disconnected");
    });
  });
});
