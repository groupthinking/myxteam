import { describe, expect, it } from "vitest";
import {
  formatApiKeyPreview,
  normalizeApiKeyInput,
  validateApiKeyInput,
} from "./auth-choice.api-key.js";

describe("normalizeApiKeyInput", () => {
  it("trims whitespace from the input", () => {
    expect(normalizeApiKeyInput("  sk-test-key  ")).toBe("sk-test-key");
  });

  it("handles empty or null-like inputs", () => {
    expect(normalizeApiKeyInput("")).toBe("");
    expect(normalizeApiKeyInput(null as unknown as string)).toBe("");
    expect(normalizeApiKeyInput("   ")).toBe("");
  });

  it("handles shell-style assignments with export", () => {
    // Current implementation: unquoting happens BEFORE semicolon removal,
    // so 'export KEY="val";' results in '"val"' because it doesn't end with '"' (it ends with ';')
    expect(normalizeApiKeyInput('export MY_KEY="sk-test-key"')).toBe("sk-test-key");
    expect(normalizeApiKeyInput("export MY_KEY=sk-test-key")).toBe("sk-test-key");
  });

  it("handles shell-style assignments without export", () => {
    expect(normalizeApiKeyInput('MY_KEY="sk-test-key"')).toBe("sk-test-key");
    expect(normalizeApiKeyInput("MY_KEY=sk-test-key")).toBe("sk-test-key");
  });

  it("handles double-quoted values", () => {
    expect(normalizeApiKeyInput('"sk-test-key"')).toBe("sk-test-key");
  });

  it("handles single-quoted values", () => {
    expect(normalizeApiKeyInput("'sk-test-key'")).toBe("sk-test-key");
  });

  it("handles backtick-quoted values", () => {
    expect(normalizeApiKeyInput("`sk-test-key`")).toBe("sk-test-key");
  });

  it("handles trailing semicolons", () => {
    expect(normalizeApiKeyInput("sk-test-key;")).toBe("sk-test-key");
  });

  it("handles combinations of quotes and semicolons (legacy behavior test)", () => {
    // These tests document the CURRENT behavior, which seems slightly buggy
    // but the task is to add tests for existing code.
    expect(normalizeApiKeyInput('"sk-test-key";')).toBe('"sk-test-key"');
    expect(normalizeApiKeyInput("'sk-test-key';")).toBe("'sk-test-key'");
  });
});

describe("validateApiKeyInput", () => {
  it('returns "Required" for empty input', () => {
    expect(validateApiKeyInput("")).toBe("Required");
  });

  it('returns "Required" for whitespace-only input', () => {
    expect(validateApiKeyInput("   ")).toBe("Required");
  });

  it('handles shell assignment with empty value (current behavior)', () => {
    // Current implementation: "export KEY=" does not match assignmentMatch because of (.+)
    // so it uses the whole string "export KEY=" as the value.
    expect(validateApiKeyInput("export KEY=")).toBeUndefined();
  });

  it("returns undefined for valid input", () => {
    expect(validateApiKeyInput("sk-test-key")).toBeUndefined();
  });

  it("returns undefined for valid shell assignment", () => {
    expect(validateApiKeyInput('export KEY="sk-test-key"')).toBeUndefined();
  });
});

describe("formatApiKeyPreview", () => {
  it('returns "…" for empty or whitespace input', () => {
    expect(formatApiKeyPreview("")).toBe("…");
    expect(formatApiKeyPreview("   ")).toBe("…");
  });

  it("formats short keys that are within head + tail length", () => {
    expect(formatApiKeyPreview("12345")).toBe("12…45");
    expect(formatApiKeyPreview("12")).toBe("12…");
    expect(formatApiKeyPreview("1")).toBe("1…");
  });

  it("formats long keys with default settings", () => {
    expect(formatApiKeyPreview("1234567890")).toBe("1234…7890");
  });

  it("formats long keys with custom settings", () => {
    expect(formatApiKeyPreview("1234567890", { head: 2, tail: 2 })).toBe("12…90");
    expect(formatApiKeyPreview("abcdefghijkl", { head: 3, tail: 1 })).toBe("abc…l");
  });

  it("handles keys exactly equal to head + tail", () => {
    expect(formatApiKeyPreview("12345678")).toBe("12…78");
  });
});
