/**
 * Unit tests for thread-state.ts
 *
 * Tests the per-conversation last-post-ID tracking used for multi-chunk
 * reply threading on X.
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  resolveReplyToIdForChunk,
  recordPostedChunk,
  clearThreadState,
  clearAllThreadState,
  getThreadStateSize,
} from "../thread-state.js";

describe("thread-state", () => {
  beforeEach(() => {
    clearAllThreadState();
  });

  describe("resolveReplyToIdForChunk", () => {
    it("returns originalReplyToId when no previous chunk has been posted", () => {
      const result = resolveReplyToIdForChunk("conv-123", "original-post-id");
      expect(result).toBe("original-post-id");
    });

    it("returns undefined when no previous chunk and no originalReplyToId", () => {
      const result = resolveReplyToIdForChunk("conv-123", undefined);
      expect(result).toBeUndefined();
    });

    it("returns undefined when no previous chunk and null originalReplyToId", () => {
      const result = resolveReplyToIdForChunk("conv-123", null);
      expect(result).toBeUndefined();
    });

    it("returns the last posted chunk ID after one chunk is recorded", () => {
      recordPostedChunk("conv-123", "chunk-1-id");
      const result = resolveReplyToIdForChunk("conv-123", "original-post-id");
      expect(result).toBe("chunk-1-id");
    });

    it("returns the most recent chunk ID after multiple chunks are recorded", () => {
      recordPostedChunk("conv-123", "chunk-1-id");
      recordPostedChunk("conv-123", "chunk-2-id");
      recordPostedChunk("conv-123", "chunk-3-id");
      const result = resolveReplyToIdForChunk("conv-123", "original-post-id");
      expect(result).toBe("chunk-3-id");
    });

    it("isolates state between different conversations", () => {
      recordPostedChunk("conv-A", "chunk-A-1");
      recordPostedChunk("conv-B", "chunk-B-1");

      expect(resolveReplyToIdForChunk("conv-A", "original-A")).toBe("chunk-A-1");
      expect(resolveReplyToIdForChunk("conv-B", "original-B")).toBe("chunk-B-1");
      expect(resolveReplyToIdForChunk("conv-C", "original-C")).toBe("original-C");
    });
  });

  describe("recordPostedChunk", () => {
    it("updates the last post ID for a conversation", () => {
      recordPostedChunk("conv-123", "post-1");
      expect(resolveReplyToIdForChunk("conv-123", "original")).toBe("post-1");

      recordPostedChunk("conv-123", "post-2");
      expect(resolveReplyToIdForChunk("conv-123", "original")).toBe("post-2");
    });
  });

  describe("clearThreadState", () => {
    it("removes the state for a specific conversation", () => {
      recordPostedChunk("conv-A", "chunk-A");
      recordPostedChunk("conv-B", "chunk-B");

      clearThreadState("conv-A");

      // conv-A should fall back to original
      expect(resolveReplyToIdForChunk("conv-A", "original-A")).toBe("original-A");
      // conv-B should still have its state
      expect(resolveReplyToIdForChunk("conv-B", "original-B")).toBe("chunk-B");
    });
  });

  describe("clearAllThreadState", () => {
    it("removes all conversation state", () => {
      recordPostedChunk("conv-A", "chunk-A");
      recordPostedChunk("conv-B", "chunk-B");
      recordPostedChunk("conv-C", "chunk-C");

      clearAllThreadState();

      expect(getThreadStateSize()).toBe(0);
      expect(resolveReplyToIdForChunk("conv-A", "original-A")).toBe("original-A");
      expect(resolveReplyToIdForChunk("conv-B", "original-B")).toBe("original-B");
    });
  });

  describe("getThreadStateSize", () => {
    it("returns 0 when no state exists", () => {
      expect(getThreadStateSize()).toBe(0);
    });

    it("returns the correct count of active conversations", () => {
      recordPostedChunk("conv-A", "chunk-A");
      recordPostedChunk("conv-B", "chunk-B");
      expect(getThreadStateSize()).toBe(2);

      recordPostedChunk("conv-C", "chunk-C");
      expect(getThreadStateSize()).toBe(3);

      clearThreadState("conv-A");
      expect(getThreadStateSize()).toBe(2);
    });
  });

  describe("multi-chunk threading scenario", () => {
    it("simulates a 3-chunk response threading correctly", () => {
      const chatId = "conversation-456";
      const originalMentionId = "mention-001";

      // Chunk 1: no previous state → reply to original mention
      const replyTo1 = resolveReplyToIdForChunk(chatId, originalMentionId);
      expect(replyTo1).toBe(originalMentionId);
      // Simulate posting chunk 1 → record its ID
      recordPostedChunk(chatId, "posted-001");

      // Chunk 2: previous state exists → reply to chunk 1
      const replyTo2 = resolveReplyToIdForChunk(chatId, originalMentionId);
      expect(replyTo2).toBe("posted-001");
      // Simulate posting chunk 2 → record its ID
      recordPostedChunk(chatId, "posted-002");

      // Chunk 3: previous state exists → reply to chunk 2
      const replyTo3 = resolveReplyToIdForChunk(chatId, originalMentionId);
      expect(replyTo3).toBe("posted-002");
      // Simulate posting chunk 3 → record its ID
      recordPostedChunk(chatId, "posted-003");

      // Final state: last chunk is chunk 3
      expect(resolveReplyToIdForChunk(chatId, originalMentionId)).toBe("posted-003");
    });
  });
});
