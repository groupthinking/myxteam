import { describe, expect, it, vi } from "vitest";
import { evaluateViaPlaywright } from "./pw-tools-core.interactions.js";

vi.mock("./pw-session.js", () => ({
  ensurePageState: vi.fn(),
  forceDisconnectPlaywrightForTarget: vi.fn(),
  getPageForTargetId: vi.fn(async () => ({
    evaluate: vi.fn(async (fn, args) => {
      if (typeof fn === "function") {
        return await fn(args);
      }
      return null;
    }),
  })),
  refLocator: vi.fn(() => ({
    evaluate: vi.fn(async (fn, args) => {
      if (typeof fn === "function") {
        return await fn({ textContent: "mocked" }, args);
      }
      return null;
    }),
  })),
  restoreRoleRefsForTarget: vi.fn(),
}));

vi.mock("./pw-tools-core.shared.js", () => ({
  normalizeTimeoutMs: vi.fn((t) => t || 20000),
  requireRef: vi.fn((r) => r),
  toAIFriendlyError: vi.fn((e) => e),
}));

describe("evaluateViaPlaywright Logic Verification", () => {
  it("passes an executable function to page.evaluate", async () => {
    const page = {
      evaluate: vi.fn(async (fn, args) => {
        if (typeof fn === "function") {
          // Simulate the browser-side evaluation logic
          const { fnBody } = args;
          // eslint-disable-next-line no-new-func
          const candidate = new Function(`return (${fnBody})`)();
          return typeof candidate === "function" ? candidate() : candidate;
        }
      }),
    };
    const { getPageForTargetId } = await import("./pw-session.js");
    (getPageForTargetId as any).mockResolvedValueOnce(page);

    const result = await evaluateViaPlaywright({
      cdpUrl: "http://localhost:9222",
      fn: "1 + 1",
    });
    expect(result).toBe(2);

    const result2 = await evaluateViaPlaywright({
      cdpUrl: "http://localhost:9222",
      fn: "() => 42",
    });
    expect(result2).toBe(42);
  });

  it("passes an executable function to locator.evaluate", async () => {
    const locator = {
      evaluate: vi.fn(async (fn, args) => {
        if (typeof fn === "function") {
          const { fnBody } = args;
          const el = { textContent: "mocked-element" };
          // eslint-disable-next-line no-new-func
          const candidate = new Function(`return (${fnBody})`)();
          return typeof candidate === "function" ? candidate(el) : candidate;
        }
      }),
    };
    const { refLocator } = await import("./pw-session.js");
    (refLocator as any).mockReturnValueOnce(locator);

    const result = await evaluateViaPlaywright({
      cdpUrl: "http://localhost:9222",
      fn: "(el) => el.textContent",
      ref: "some-ref",
    });
    expect(result).toBe("mocked-element");
  });
});
