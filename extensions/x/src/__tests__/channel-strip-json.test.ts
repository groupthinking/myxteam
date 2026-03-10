/**
 * Unit tests for stripLeadingContextJsonBlock in channel.ts.
 *
 * This function strips leading OpenClaw context JSON blocks from outbound
 * tweet text to prevent runtime metadata from bleeding into replies.
 */
import { describe, it, expect } from "vitest";
import { stripLeadingContextJsonBlock } from "../strip-context-json.js";

describe("stripLeadingContextJsonBlock", () => {
  describe("strips bare ```json blocks at the start", () => {
    it("strips the exact bug-report pattern (bare json object, no label)", () => {
      const input =
        '```json\n{\n  "conversation_label": "@MyXStack"\n}\n```\n\n@milkxxman BTC is at $102k';
      expect(stripLeadingContextJsonBlock(input)).toBe("@milkxxman BTC is at $102k");
    });

    it("strips a bare json array block at the start", () => {
      const input =
        '```json\n[\n  {"sender": "@user", "body": "hello"}\n]\n```\n\nHere is my reply.';
      expect(stripLeadingContextJsonBlock(input)).toBe("Here is my reply.");
    });

    it("handles bare block with no trailing text (returns empty string)", () => {
      const input = '```json\n{\n  "conversation_label": "@MyXStack"\n}\n```\n';
      expect(stripLeadingContextJsonBlock(input)).toBe("");
    });
  });

  describe("strips known OpenClaw label lines followed by a json block", () => {
    it("strips 'Conversation info (untrusted metadata):' label + json object", () => {
      const input =
        'Conversation info (untrusted metadata):\n```json\n{\n  "conversation_label": "@MyXStack"\n}\n```\n\nBTC is at $102k';
      expect(stripLeadingContextJsonBlock(input)).toBe("BTC is at $102k");
    });

    it("strips 'Sender (untrusted metadata):' label + json object", () => {
      const input =
        'Sender (untrusted metadata):\n```json\n{\n  "label": "@user",\n  "name": "User"\n}\n```\n\nHello!';
      expect(stripLeadingContextJsonBlock(input)).toBe("Hello!");
    });

    it("strips 'Thread starter (untrusted, for context):' label + json object", () => {
      const input =
        'Thread starter (untrusted, for context):\n```json\n{\n  "body": "What is BTC price?"\n}\n```\n\nBTC is $102k.';
      expect(stripLeadingContextJsonBlock(input)).toBe("BTC is $102k.");
    });

    it("strips 'Replied message (untrusted, for context):' label + json object", () => {
      const input =
        'Replied message (untrusted, for context):\n```json\n{\n  "body": "original message"\n}\n```\n\nGot it.';
      expect(stripLeadingContextJsonBlock(input)).toBe("Got it.");
    });

    it("strips 'Forwarded message context (untrusted metadata):' label + json object", () => {
      const input =
        'Forwarded message context (untrusted metadata):\n```json\n{\n  "from": "@someone"\n}\n```\n\nForwarded reply.';
      expect(stripLeadingContextJsonBlock(input)).toBe("Forwarded reply.");
    });

    it("strips 'Chat history since last reply (untrusted, for context):' label + json array", () => {
      const input =
        'Chat history since last reply (untrusted, for context):\n```json\n[\n  {"sender": "@user", "body": "hi"}\n]\n```\n\nHey there!';
      expect(stripLeadingContextJsonBlock(input)).toBe("Hey there!");
    });
  });

  describe("does NOT strip when it should not", () => {
    it("does not modify normal tweet text", () => {
      const input = "@milkxxman BTC is at $102k right now";
      expect(stripLeadingContextJsonBlock(input)).toBe(input);
    });

    it("does not strip a json block that appears mid-text", () => {
      const input =
        'Good afternoon! Here is some info:\n```json\n{"price": 102000}\n```\nThat is the price.';
      expect(stripLeadingContextJsonBlock(input)).toBe(input);
    });

    it("does not strip when an unknown label precedes the json block", () => {
      const input =
        'Some arbitrary label:\n```json\n{"conversation_label": "@MyXStack"}\n```\nThat is the price.';
      expect(stripLeadingContextJsonBlock(input)).toBe(input);
    });

    it("returns empty string unchanged", () => {
      expect(stripLeadingContextJsonBlock("")).toBe("");
    });

    it("does not strip a json block that is not a code fence", () => {
      const input = '{"conversation_label": "@MyXStack"}\n\nHello!';
      expect(stripLeadingContextJsonBlock(input)).toBe(input);
    });
  });

  describe("handles edge cases", () => {
    it("handles leading whitespace before the json block", () => {
      const input = '  \n```json\n{\n  "conversation_label": "@MyXStack"\n}\n```\n\nHello!';
      expect(stripLeadingContextJsonBlock(input)).toBe("Hello!");
    });

    it("handles text with only whitespace after stripping", () => {
      const input = '```json\n{"x": 1}\n```\n   ';
      expect(stripLeadingContextJsonBlock(input).trim()).toBe("");
    });
  });
});
