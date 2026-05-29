/**
 * Pure-DB read helpers for the AI-learning loop. Two consumers:
 *   - `generateSuggestions` user-prompt builder: passes per-person evidence
 *     and cross-session dead phrases to the model.
 *   - Settings → System tab "Style profile" card: shows when the last
 *     distillation ran and what evidence it had to work with.
 *
 * No LLM calls. No DOM. Cheap brute-force scans over `suggestionsLog` +
 * `helperDrafts` — both tables are small enough (≤ 10 000 rows on a year
 * of single-user data) that a sequential scan beats the maintenance cost
 * of a query index.
 */

import { db, type SuggestionLog, type HelperDraft, type SuggestionCategory } from "@/lib/db";

export type PerPersonCategoryHints = Partial<Record<SuggestionCategory, number>>;

export type StyleEvidence = {
  /** Per-person category preference (selected / total shown), -1 if N < 20. */
  perPerson: Map<string, PerPersonCategoryHints>;
  /** Global category preference across all people / suggestions. */
  global: PerPersonCategoryHints;
  /** Total rows fed in. */
  sampleCount: number;
};

/**
 * Build per-person + global category preference distributions. The cockpit
 * passes the per-person map into `SuggestionContext` so the model sees
 * "James usually picks question/answer for this speaker".
 *
 * Window: last 90 days. Min sample threshold: 20 per person — below that
 * we fall back to global (otherwise one ignored row swings the prior).
 */
export async function getStyleEvidence(args?: {
  windowDays?: number;
  minPerPersonSamples?: number;
}): Promise<StyleEvidence> {
  const windowMs = (args?.windowDays ?? 90) * 24 * 60 * 60 * 1000;
  const minSamples = args?.minPerPersonSamples ?? 20;
  const since = Date.now() - windowMs;

  const rows = await db().suggestionsLog.where("createdAt").above(since).toArray();
  if (rows.length === 0) {
    return { perPerson: new Map(), global: {}, sampleCount: 0 };
  }

  // Tally per-person selection rates per category. We don't yet penalise
  // ignored separately — the calling prompt is more interested in
  // "what does he pick" than "what doesn't he pick" (that's dead phrases).
  const perPersonCounts = new Map<
    string,
    Partial<Record<SuggestionCategory, { shown: number; selected: number }>>
  >();
  const globalCounts: Partial<Record<SuggestionCategory, { shown: number; selected: number }>> = {};

  for (const row of rows) {
    if (!row.category) continue;
    tally(globalCounts, row.category, row);
    if (row.personId) {
      const existing = perPersonCounts.get(row.personId) ?? {};
      tally(existing, row.category, row);
      perPersonCounts.set(row.personId, existing);
    }
  }

  const perPerson = new Map<string, PerPersonCategoryHints>();
  for (const [personId, counts] of perPersonCounts.entries()) {
    const total = Object.values(counts).reduce((s, c) => s + (c?.shown ?? 0), 0);
    if (total < minSamples) continue;
    perPerson.set(personId, ratesFromCounts(counts));
  }

  return { perPerson, global: ratesFromCounts(globalCounts), sampleCount: rows.length };
}

function tally(
  bucket: Partial<Record<SuggestionCategory, { shown: number; selected: number }>>,
  cat: SuggestionCategory,
  row: SuggestionLog,
): void {
  if (!bucket[cat]) bucket[cat] = { shown: 0, selected: 0 };
  const c = bucket[cat]!;
  c.shown++;
  if (row.selected) c.selected++;
}

function ratesFromCounts(
  counts: Partial<Record<SuggestionCategory, { shown: number; selected: number }>>,
): PerPersonCategoryHints {
  const out: PerPersonCategoryHints = {};
  for (const k of Object.keys(counts) as SuggestionCategory[]) {
    const c = counts[k]!;
    out[k] = c.shown === 0 ? 0 : c.selected / c.shown;
  }
  return out;
}

// --------------------------------------------------------------------------
// Cross-session dead phrases
// --------------------------------------------------------------------------

export type DeadPhrasesArgs = {
  /** Show a phrase ≥ N times before we count it as "consistently ignored". */
  shownTimes?: number;
  /** Look at the last N days only. */
  windowDays?: number;
  /** Cap the returned list. */
  max?: number;
};

/**
 * Returns lowercased, distinct phrases that have been generated ≥ N times
 * across distinct conversations in the window and never selected.
 *
 * Used in two places:
 *   1. Suggestion prompt: "Do NOT propose: …" hint.
 *   2. Post-generation filter: drop any output that matches and top up with
 *      a fallback. The filter lives at the call site; this just provides
 *      the set.
 *
 * Conservative defaults (3 shows, 7 days) — false positives are costly.
 */
export async function getCrossSessionDeadPhrases(args?: DeadPhrasesArgs): Promise<string[]> {
  const shownTimes = args?.shownTimes ?? 3;
  const windowDays = args?.windowDays ?? 7;
  const max = args?.max ?? 30;
  const since = Date.now() - windowDays * 24 * 60 * 60 * 1000;

  const rows = await db().suggestionsLog.where("createdAt").above(since).toArray();
  if (rows.length === 0) return [];

  const groups = new Map<string, { shown: Set<string>; selected: number }>();
  for (const r of rows) {
    if (!r.text) continue;
    const key = normalisePhrase(r.text);
    if (key.length < 3) continue;
    const g = groups.get(key) ?? { shown: new Set<string>(), selected: 0 };
    g.shown.add(r.conversationId);
    if (r.selected) g.selected++;
    groups.set(key, g);
  }

  const dead: Array<{ phrase: string; count: number }> = [];
  for (const [phrase, g] of groups.entries()) {
    if (g.selected > 0) continue;
    if (g.shown.size < shownTimes) continue;
    dead.push({ phrase, count: g.shown.size });
  }
  dead.sort((a, b) => b.count - a.count);
  return dead.slice(0, max).map((d) => d.phrase);
}

/**
 * Lower-cased, punctuation-stripped phrase key. The model's regeneration of
 * "Sounds great!", "sounds great.", "Sounds great" should all bucket as the
 * same dead phrase.
 */
export function normalisePhrase(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s']/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// --------------------------------------------------------------------------
// Helper-tab style signal
// --------------------------------------------------------------------------

/**
 * Aggregate evidence rows from the Helpers tab — drafts where James edited
 * the recommended text and/or marked it sent. These rows go into the
 * Tier-1 style distillation alongside `suggestionsLog`.
 *
 * Returns the raw rows; the distiller does the LLM-side aggregation. We
 * just gate by recency + signal-bearing (edited or sent).
 */
export async function getHelperDraftEvidence(args?: {
  windowDays?: number;
  max?: number;
}): Promise<HelperDraft[]> {
  const windowDays = args?.windowDays ?? 90;
  const since = Date.now() - windowDays * 24 * 60 * 60 * 1000;
  const max = args?.max ?? 200;
  const rows = await db().helperDrafts.where("createdAt").above(since).toArray();
  return rows
    .filter((r) => Boolean(r.jamesEdit) || Boolean(r.sentAt))
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, max);
}
