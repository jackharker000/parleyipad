/**
 * Post-generation safety net for dead-phrase suppression. The LLM gets a
 * "do NOT propose: …" list in the system prompt (Tier-1 hint), but models
 * occasionally regenerate a banned phrase verbatim — they're just probable
 * next tokens. This filter walks the returned drafts and drops any whose
 * normalised form matches the dead-phrase set, then tops the grid back up
 * to N suggestions with a small set of always-safe fallbacks so the
 * cockpit never displays fewer than expected.
 *
 * Pure function. No DB I/O. Callers feed it the dead-phrase set (already
 * fetched once per conversation via getCrossSessionDeadPhrases) and the
 * raw drafts; we don't re-query on every turn.
 */

import { normalisePhrase } from "@/lib/learning/style-evidence";
import type { SuggestionDraft } from "@/lib/ai";

/**
 * Fallbacks that ship when the post-filter strips a suggestion. These are
 * intentionally bland — they're floor-of-the-loop options, not features.
 * The "give-me-a-moment" buffer is critical: it's what James taps to keep
 * the conversational floor while a real reply forms in his head.
 */
const FALLBACK_DRAFTS: SuggestionDraft[] = [
  { text: "Give me a moment.", category: "give-me-a-moment" },
  { text: "Yes.", category: "answer" },
  { text: "No.", category: "answer" },
  { text: "Could you say that again?", category: "clarify" },
  { text: "What do you think?", category: "question" },
  { text: "Tell me more.", category: "followup" },
];

export type FilterArgs = {
  drafts: SuggestionDraft[];
  /** Already-normalised dead-phrase keys (lowercased, punctuation-stripped).
   * Pass them pre-normalised so the per-turn loop doesn't redo the work. */
  deadPhrases: string[];
  /** Required output size — default 6 to match the cockpit grid. */
  expectedCount?: number;
};

export type FilterResult = {
  drafts: SuggestionDraft[];
  dropped: SuggestionDraft[];
  toppedUp: number;
};

/**
 * Drop drafts whose normalised text matches a dead phrase. Top up with
 * fallback drafts (without re-introducing a phrase we just dropped) so
 * the caller always gets `expectedCount` rows.
 *
 * Dedupes against the input draft set too — if a fallback would duplicate
 * something already returned (e.g. the model also produced "Yes."), skip
 * it and try the next fallback.
 */
export function applyDeadPhraseFilter(args: FilterArgs): FilterResult {
  const expected = args.expectedCount ?? 6;
  const deadSet = new Set(args.deadPhrases);

  const kept: SuggestionDraft[] = [];
  const dropped: SuggestionDraft[] = [];
  const seenKeys = new Set<string>();

  for (const d of args.drafts) {
    const key = normalisePhrase(d.text);
    if (deadSet.has(key)) {
      dropped.push(d);
      continue;
    }
    if (seenKeys.has(key)) {
      // Defensive dedupe — models occasionally emit two near-identical
      // drafts in the same response.
      dropped.push(d);
      continue;
    }
    seenKeys.add(key);
    kept.push(d);
  }

  let toppedUp = 0;
  for (const fb of FALLBACK_DRAFTS) {
    if (kept.length >= expected) break;
    const key = normalisePhrase(fb.text);
    if (seenKeys.has(key)) continue;
    if (deadSet.has(key)) continue;
    kept.push(fb);
    seenKeys.add(key);
    toppedUp++;
  }

  return { drafts: kept.slice(0, expected), dropped, toppedUp };
}
