/**
 * Mood prediction (Tier 3.3).
 *
 * Mirrors the mood enum used in `aac.functions.ts:suggestionsSchema` so we
 * can flow predictions straight into the suggestion prompt. The route owns
 * two pieces of mood state:
 *
 *   - `manualMood`: set when James (or his support) taps a chip directly.
 *   - `predictedMood`: filled in automatically every few turns.
 *
 * Effective mood = `manualMood ?? predictedMood ?? "normal"`. The manual
 * override always wins; prediction is suppressed entirely while a manual
 * mood is set.
 */

export const MOOD_IDS = [
  "normal",
  "calm",
  "excited",
  "sad",
  "upset",
  "empathetic",
  "amused",
] as const;

export type MoodId = (typeof MOOD_IDS)[number];

/** Predict mood every N committed turns. */
export const MOOD_REFRESH_TURNS = 4;

/** Below this confidence the predictor returns null — keep previous. */
export const MOOD_MIN_CONFIDENCE = 0.55;

/** Should the mood predictor run on this turn count? */
export function isMoodDue(committedTurns: number): boolean {
  if (committedTurns < 2) return false;
  return committedTurns % MOOD_REFRESH_TURNS === 0;
}

/** Effective mood = manual override beats prediction beats default. */
export function effectiveMood(manualMood: MoodId | null, predictedMood: MoodId | null): MoodId {
  return manualMood ?? predictedMood ?? "normal";
}
