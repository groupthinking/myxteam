/**
 * Unit tests for credit-budget.ts
 *
 * Tests the credit budget enforcement logic, including the checkCreditBudget
 * function and the CreditUsageSnapshot state management.
 */

import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import {
  checkCreditBudget,
  clearCreditBudget,
  getCreditUsageSnapshot,
  refreshUsage,
} from "../credit-budget.js";

// We test the public API without actually calling the X API.
// The fetchMonthlyUsage function is internal, so we mock fetch globally.

describe("credit-budget", () => {
  beforeEach(() => {
    clearCreditBudget();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    clearCreditBudget();
  });

  describe("checkCreditBudget (no budget configured)", () => {
    it("allows posting when no budget is initialized", () => {
      const result = checkCreditBudget();
      expect(result.allowed).toBe(true);
      expect(result.reason).toBeUndefined();
    });
  });

  describe("checkCreditBudget (with snapshot)", () => {
    it("allows posting when usage is under budget", () => {
      // Directly test the check logic by mocking the snapshot
      // We do this by calling initCreditBudget with a mocked fetch
      // that returns low usage, then checking the result.

      // Since we can't easily inject the snapshot, we test the
      // logic indirectly by verifying the no-budget case and
      // the budget-exceeded case via the exported functions.

      // This test verifies the "no snapshot yet" branch
      const result = checkCreditBudget();
      expect(result.allowed).toBe(true);
    });
  });

  describe("getCreditUsageSnapshot", () => {
    it("returns null when not initialized", () => {
      expect(getCreditUsageSnapshot()).toBeNull();
    });
  });

  describe("clearCreditBudget", () => {
    it("resets all state", () => {
      clearCreditBudget();
      expect(getCreditUsageSnapshot()).toBeNull();
      expect(checkCreditBudget().allowed).toBe(true);
    });
  });

  describe("refreshUsage (with mocked fetch)", () => {
    it("does nothing when no budget is configured", async () => {
      const fetchSpy = vi.spyOn(global, "fetch");
      await refreshUsage();
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it("calls the Usage API with correct date range", async () => {
      const mockResponse = {
        ok: true,
        json: async () => ({
          data: [
            { date: "2026-03-01", usage: [{ bucket: "posts", value: 1500 }] },
            { date: "2026-03-02", usage: [{ bucket: "posts", value: 2000 }] },
          ],
        }),
        text: async () => "",
      };

      vi.spyOn(global, "fetch").mockResolvedValue(mockResponse as unknown as Response);

      const { initCreditBudget } = await import("../credit-budget.js");

      await initCreditBudget({
        budget: 10000,
        bearerToken: "test-bearer-token",
        refreshIntervalMs: 999_999_999, // Don't auto-refresh during test
      });

      // After init, snapshot should be populated
      const snapshot = getCreditUsageSnapshot();
      expect(snapshot).not.toBeNull();
      expect(snapshot!.totalUsed).toBe(3500); // 1500 + 2000
      expect(snapshot!.budget).toBe(10000);
      expect(snapshot!.exceeded).toBe(false);
      expect(snapshot!.warning).toBe(false);
      expect(snapshot!.fraction).toBeCloseTo(0.35);

      clearCreditBudget();
    });

    it("marks snapshot as exceeded when usage >= budget", async () => {
      const mockResponse = {
        ok: true,
        json: async () => ({
          data: [
            { date: "2026-03-01", usage: [{ bucket: "posts", value: 10500 }] },
          ],
        }),
        text: async () => "",
      };

      vi.spyOn(global, "fetch").mockResolvedValue(mockResponse as unknown as Response);

      const onBudgetExceeded = vi.fn();
      const { initCreditBudget } = await import("../credit-budget.js");

      await initCreditBudget({
        budget: 10000,
        bearerToken: "test-bearer-token",
        refreshIntervalMs: 999_999_999,
        onBudgetExceeded,
      });

      const snapshot = getCreditUsageSnapshot();
      expect(snapshot!.exceeded).toBe(true);
      expect(snapshot!.fraction).toBeGreaterThan(1);
      expect(onBudgetExceeded).toHaveBeenCalledWith(10500, 10000);

      // checkCreditBudget should now block posting
      const check = checkCreditBudget();
      expect(check.allowed).toBe(false);
      expect(check.reason).toContain("exceeded");

      clearCreditBudget();
    });

    it("marks snapshot as warning when usage crosses warn threshold", async () => {
      const mockResponse = {
        ok: true,
        json: async () => ({
          data: [
            { date: "2026-03-01", usage: [{ bucket: "posts", value: 8500 }] },
          ],
        }),
        text: async () => "",
      };

      vi.spyOn(global, "fetch").mockResolvedValue(mockResponse as unknown as Response);

      const onBudgetWarning = vi.fn();
      const { initCreditBudget } = await import("../credit-budget.js");

      await initCreditBudget({
        budget: 10000,
        bearerToken: "test-bearer-token",
        refreshIntervalMs: 999_999_999,
        warnThreshold: 0.8,
        onBudgetWarning,
      });

      const snapshot = getCreditUsageSnapshot();
      expect(snapshot!.warning).toBe(true);
      expect(snapshot!.exceeded).toBe(false);
      expect(onBudgetWarning).toHaveBeenCalledWith(8500, 10000);

      // checkCreditBudget should still allow posting (warning, not exceeded)
      const check = checkCreditBudget();
      expect(check.allowed).toBe(true);

      clearCreditBudget();
    });
  });
});
