import { db, type SuggestionLog } from "./db";

/**
 * Per-category performance signals used to bias real-time suggestion
 * generation. Categories that James reliably taps fast → "trusted"; ones
 * that consistently lag or get edited → "near-miss". Everything else is
 * neutral. The bias is fed into the suggestion prompt so the model can
 * lean into proven categories and try harder on under-performing ones.
 */
export type CategoryBiasLabel = "trusted" | "neutral" | "near-miss";

/** Categories the AI is allowed to emit. Mirrors aac.functions.ts. */
export const SUGGESTION_CATEGORIES = [
  "answer",
  "question",
  "follow-up",
  "planned-point",
  "quick-phrase",
  "humor",
  "clarify",
  "give-me-a-moment",
] as const;
export type SuggestionCategory = (typeof SUGGESTION_CATEGORIES)[number];

/** Minimum number of selected logs across all categories before we
 *  surface any bias at all. Avoids over-fitting to the first few taps. */
export const COLD_START_MIN_LOGS = 20;

/** Load recent suggestion logs, newest first, capped at `maxRows`. */
export async function loadRecentLogs(maxRows = 200): Promise<SuggestionLog[]> {
  const rows = await db.suggestions_log.orderBy("shown_at").reverse().limit(maxRows).toArray();
  return rows;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/**
 * Bucket each category into trusted / neutral / near-miss based on James's
 * tap-time + edit-rate history.
 *
 * Heuristics:
 * - trusted: median `time_to_tap_ms` < 2000ms AND edited fraction < 0.10
 * - near-miss: median `time_to_tap_ms` > 8000ms OR edited fraction > 0.30
 * - else neutral.
 *
 * Cold-start: if fewer than COLD_START_MIN_LOGS selected logs exist
 * across all categories, returns an empty record (caller treats as
 * "all neutral, no bias block").
 */
export function computeCategoryBias(logs: SuggestionLog[]): Record<string, CategoryBiasLabel> {
  const selected = logs.filter((l) => l.selected && typeof l.time_to_tap_ms === "number");
  if (selected.length < COLD_START_MIN_LOGS) return {};

  // Group the last 50 selected logs per category.
  const byCategory = new Map<string, SuggestionLog[]>();
  for (const log of selected) {
    const arr = byCategory.get(log.category) ?? [];
    if (arr.length < 50) arr.push(log);
    byCategory.set(log.category, arr);
  }

  const out: Record<string, CategoryBiasLabel> = {};
  for (const [category, rows] of byCategory.entries()) {
    if (rows.length < 3) {
      // Too few samples to judge this category — leave neutral.
      out[category] = "neutral";
      continue;
    }
    const times = rows
      .map((r) => r.time_to_tap_ms)
      .filter((t): t is number => typeof t === "number");
    const med = median(times);
    const editedFraction =
      rows.filter((r) => !!r.edited_to && r.edited_to.trim().length > 0).length / rows.length;

    if (med < 2000 && editedFraction < 0.1) {
      out[category] = "trusted";
    } else if (med > 8000 || editedFraction > 0.3) {
      out[category] = "near-miss";
    } else {
      out[category] = "neutral";
    }
  }
  return out;
}

/** Convenience: derive bias from the latest logs. Used on mount + after stop. */
export async function loadRecentBias(): Promise<Record<string, CategoryBiasLabel>> {
  const logs = await loadRecentLogs(200);
  return computeCategoryBias(logs);
}

/** Has the bias map crossed cold-start — i.e. is any block worth emitting? */
export function hasUsefulBias(bias: Record<string, CategoryBiasLabel>): boolean {
  if (Object.keys(bias).length === 0) return false;
  return Object.values(bias).some((b) => b !== "neutral");
}
