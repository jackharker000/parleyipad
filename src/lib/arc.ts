/**
 * Conversation-arc awareness (Tier 3.2).
 *
 * A live classifier that tags the current conversation with one of a small
 * fixed set of arcs (greeting, decision, venting…). The suggestion prompt
 * uses the tag to adapt its register and structure — concrete answers
 * during a decision arc, empathy during venting, brevity during a
 * wrap-up. The classifier runs on the fast model and is cached for
 * several turns to keep cost trivial.
 */

export const CONVERSATION_ARCS = [
  "greeting",
  "catching_up",
  "decision",
  "venting",
  "wrapping_up",
  "logistics",
  "small_talk",
] as const;

export type ConversationArc = (typeof CONVERSATION_ARCS)[number];

/** How often to refresh the arc classification. Smaller = more reactive,
 *  larger = cheaper. Arcs change slowly so 5 turns is a reasonable midpoint. */
export const ARC_REFRESH_TURNS = 5;

/** Lowest tag confidence we'll trust without falling back to the previous arc. */
export const ARC_MIN_CONFIDENCE = 0.55;

/** Lightweight cache entry stored on a ref in the route. */
export type ArcCacheEntry = {
  arc: ConversationArc;
  atTurn: number;
};

/** Decide whether the arc classifier is due to run again given a fresh
 *  transcript length and the previous cache entry. */
export function isArcDue(committedTurns: number, cache: ArcCacheEntry | null): boolean {
  if (committedTurns < 2) return false;
  if (!cache) return true;
  return committedTurns - cache.atTurn >= ARC_REFRESH_TURNS;
}
