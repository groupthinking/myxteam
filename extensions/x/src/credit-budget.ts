/**
 * X API Credit Budget Enforcement
 *
 * Monitors X API credit consumption via the Usage API and enforces a
 * configurable monthly budget. When the budget is reached (or within a
 * warning threshold), posting is blocked and the operator is alerted.
 *
 * The X API Usage endpoint returns daily usage data. This module aggregates
 * the current calendar month's usage and compares it against the budget.
 *
 * Reference: https://docs.x.com/x-api/usage/introduction
 */

import type { ChannelLogSink } from "openclaw/plugin-sdk";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface CreditBudgetConfig {
  /** Monthly credit budget limit. 0 or undefined = no enforcement. */
  budget: number;
  /** App-level Bearer Token for the Usage API. */
  bearerToken: string;
  /** How often (ms) to refresh usage from the API. Default: 60 minutes. */
  refreshIntervalMs?: number;
  /** Warn when usage reaches this fraction of budget (0–1). Default: 0.8 (80%). */
  warnThreshold?: number;
  /** Optional logger. */
  log?: ChannelLogSink;
  /** Callback when budget is exceeded. */
  onBudgetExceeded?: (usage: number, budget: number) => void | Promise<void>;
  /** Callback when usage crosses the warning threshold. */
  onBudgetWarning?: (usage: number, budget: number) => void | Promise<void>;
}

export interface CreditUsageSnapshot {
  /** Total credits used in the current calendar month. */
  totalUsed: number;
  /** The configured budget limit. */
  budget: number;
  /** Whether the budget has been exceeded. */
  exceeded: boolean;
  /** Whether usage is above the warning threshold. */
  warning: boolean;
  /** Fraction used (0–1). */
  fraction: number;
  /** When this snapshot was last refreshed. */
  lastRefreshedAt: number;
}

// ─── Constants ───────────────────────────────────────────────────────────────

const X_API_BASE = "https://api.x.com/2";
const DEFAULT_REFRESH_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
const DEFAULT_WARN_THRESHOLD = 0.8; // 80%

// ─── Module State ─────────────────────────────────────────────────────────────

let budgetConfig: CreditBudgetConfig | null = null;
let usageSnapshot: CreditUsageSnapshot | null = null;
let refreshTimer: ReturnType<typeof setInterval> | null = null;

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Initialize credit budget monitoring.
 * Fetches initial usage and schedules periodic refresh.
 */
export async function initCreditBudget(config: CreditBudgetConfig): Promise<void> {
  if (!config.budget || config.budget <= 0) {
    // No budget configured — monitoring is disabled
    return;
  }

  budgetConfig = config;

  // Fetch initial usage
  await refreshUsage();

  // Schedule periodic refresh
  const intervalMs = config.refreshIntervalMs ?? DEFAULT_REFRESH_INTERVAL_MS;
  refreshTimer = setInterval(async () => {
    await refreshUsage();
  }, intervalMs);

  config.log?.info?.(
    `Credit budget monitoring initialized. Budget: ${config.budget} credits. ` +
    `Refresh interval: ${Math.round(intervalMs / 60_000)} min.`,
  );
}

/**
 * Stop credit budget monitoring and clear state.
 */
export function clearCreditBudget(): void {
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
  budgetConfig = null;
  usageSnapshot = null;
}

/**
 * Check whether posting is currently allowed under the budget.
 *
 * Returns:
 * - `{ allowed: true }` if no budget is configured or usage is under budget
 * - `{ allowed: false, reason, usage, budget }` if budget is exceeded
 */
export function checkCreditBudget(): {
  allowed: boolean;
  reason?: string;
  usage?: number;
  budget?: number;
} {
  if (!budgetConfig || !budgetConfig.budget) {
    return { allowed: true };
  }

  if (!usageSnapshot) {
    // Usage not yet fetched — allow but log a warning
    budgetConfig.log?.warn?.(
      "Credit usage not yet available. Allowing post (will check on next refresh).",
    );
    return { allowed: true };
  }

  if (usageSnapshot.exceeded) {
    return {
      allowed: false,
      reason: `Monthly credit budget exceeded: ${usageSnapshot.totalUsed}/${usageSnapshot.budget} credits used.`,
      usage: usageSnapshot.totalUsed,
      budget: usageSnapshot.budget,
    };
  }

  return { allowed: true, usage: usageSnapshot.totalUsed, budget: usageSnapshot.budget };
}

/**
 * Get the current usage snapshot.
 * Returns null if budget monitoring is not initialized.
 */
export function getCreditUsageSnapshot(): CreditUsageSnapshot | null {
  return usageSnapshot;
}

/**
 * Force an immediate refresh of usage data from the X API.
 */
export async function refreshUsage(): Promise<void> {
  if (!budgetConfig) return;

  const { bearerToken, budget, log, warnThreshold, onBudgetExceeded, onBudgetWarning } =
    budgetConfig;

  try {
    const totalUsed = await fetchMonthlyUsage(bearerToken, log);
    const threshold = warnThreshold ?? DEFAULT_WARN_THRESHOLD;
    const fraction = budget > 0 ? totalUsed / budget : 0;
    const exceeded = totalUsed >= budget;
    const warning = !exceeded && fraction >= threshold;

    const prevSnapshot = usageSnapshot;
    usageSnapshot = {
      totalUsed,
      budget,
      exceeded,
      warning,
      fraction,
      lastRefreshedAt: Date.now(),
    };

    log?.info?.(
      `Credit usage: ${totalUsed}/${budget} (${Math.round(fraction * 100)}%)${exceeded ? " — BUDGET EXCEEDED" : warning ? " — WARNING" : ""}`,
    );

    // Fire callbacks on state transitions
    if (exceeded && (!prevSnapshot || !prevSnapshot.exceeded)) {
      log?.error?.(
        `[BUDGET EXCEEDED] Monthly X API credit budget of ${budget} has been reached. ` +
        `Posting will be blocked until the budget is increased or the month resets.`,
      );
      await onBudgetExceeded?.(totalUsed, budget);
    } else if (warning && (!prevSnapshot || !prevSnapshot.warning)) {
      log?.warn?.(
        `[BUDGET WARNING] X API credit usage is at ${Math.round(fraction * 100)}% of monthly budget ` +
        `(${totalUsed}/${budget}).`,
      );
      await onBudgetWarning?.(totalUsed, budget);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log?.error?.(`Failed to refresh credit usage: ${msg}`);
    // Non-fatal — keep the last known snapshot
  }
}

// ─── Internal ────────────────────────────────────────────────────────────────

/**
 * Fetch the total credit usage for the current calendar month from the X API.
 *
 * The Usage API returns daily usage data. We sum all days in the current
 * calendar month to get the monthly total.
 */
async function fetchMonthlyUsage(
  bearerToken: string,
  log?: ChannelLogSink,
): Promise<number> {
  const now = new Date();
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  const startStr = startOfMonth.toISOString().split("T")[0]; // YYYY-MM-DD
  const endStr = now.toISOString().split("T")[0]; // YYYY-MM-DD

  const params = new URLSearchParams({
    start_time: startStr!,
    end_time: endStr!,
    granularity: "Daily",
  });

  const response = await fetch(`${X_API_BASE}/usage/tweets?${params.toString()}`, {
    headers: {
      Authorization: `Bearer ${bearerToken}`,
    },
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Usage API error: ${response.status} ${response.statusText} — ${body}`);
  }

  const data = (await response.json()) as {
    data?: Array<{
      date?: string;
      usage?: Array<{ bucket?: string; value?: number }>;
    }>;
  };

  if (!data.data || !Array.isArray(data.data)) {
    log?.warn?.("Usage API returned no data. Assuming 0 credits used.");
    return 0;
  }

  // Sum all usage values across all days and all buckets
  let total = 0;
  for (const day of data.data) {
    if (Array.isArray(day.usage)) {
      for (const bucket of day.usage) {
        total += bucket.value ?? 0;
      }
    }
  }

  return total;
}
