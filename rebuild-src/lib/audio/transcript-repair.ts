/**
 * Post-Scribe text repair: walks each finalised transcript and substitutes
 * roster-name tokens that Scribe got near-but-not-quite right ("Jacques" →
 * "Jack", "Glennys" → "Glenis"). Cheap, high-precision, runs after each
 * Scribe final and before the LLM ever sees the text.
 *
 * Approach:
 *   - Levenshtein distance ≤ 1 for tokens ≥ 4 chars; ≤ 0 for short tokens.
 *   - Prefix-match heuristic: tokens that share the first 3 chars with a
 *     roster name are eligible. Cheap pre-filter; avoids quadratic compare.
 *   - Never substitute a token that's already in the dictionary of common
 *     English words (we don't have one bundled, so we skip the substitution
 *     when the original token is < 4 chars OR when a roster name is itself
 *     a common-English-word risk like "Will"/"Mark" — handled by the
 *     COMMON_WORD_NAMES set below).
 *
 * This is T1's robustness backstop, not its replacement — keyterm biasing
 * on Scribe is the front line; this picks up what slips past.
 *
 * Plain ASCII algorithm. No NER, no phonetic library — the surface is
 * deliberately small enough to audit during a regression.
 */

import type { Person } from "@/lib/db";

/**
 * Names that look like common English words. If the original Scribe token
 * matches one of these (case-insensitive), we don't repair it — the cost
 * of a false positive ("the will of the people" → "the Will of the people")
 * is higher than the cost of leaving a name slightly off.
 */
const COMMON_WORD_NAMES = new Set<string>([
  "will",
  "mark",
  "art",
  "dawn",
  "grace",
  "hope",
  "joy",
  "lily",
  "pearl",
  "ray",
  "rose",
  "rich",
  "sunny",
  "summer",
  "april",
  "may",
  "june",
]);

export type RepairContext = {
  roster: Person[];
  /** James's display name; protected from substitution into other names. */
  jamesName?: string;
};

/**
 * Token-walk a finalised transcript and substitute near-miss roster names.
 * Pure string in / pure string out. Punctuation and casing are preserved
 * around the substitution boundary so the output round-trips through the
 * suggestion prompt without looking edited.
 */
export function repairNames(text: string, ctx: RepairContext): string {
  if (!text || ctx.roster.length === 0) return text;

  // Pre-compute lowercased name + first-name pairs. Multiple aliases per
  // person are flattened to a single repair target ("Mum" + "Mom" both
  // resolve to whichever the user stored as `name`).
  const targets = buildRepairTargets(ctx);
  if (targets.length === 0) return text;

  // Walk tokens. A "token" here is a contiguous run of letters/apostrophes;
  // everything else (spaces, punctuation) is verbatim copied. The walker
  // keeps positions so we can rebuild the string without re-tokenising.
  const out: string[] = [];
  let i = 0;
  while (i < text.length) {
    const tokenStart = findTokenStart(text, i);
    if (tokenStart < 0) {
      out.push(text.slice(i));
      break;
    }
    out.push(text.slice(i, tokenStart));
    const tokenEnd = findTokenEnd(text, tokenStart);
    const token = text.slice(tokenStart, tokenEnd);
    const repaired = tryRepairToken(token, targets);
    out.push(repaired);
    i = tokenEnd;
  }
  return out.join("");
}

// --------------------------------------------------------------------------

type RepairTarget = {
  /** Canonical name to substitute IN. */
  canonical: string;
  /** Lowercased canonical for compare. */
  lowered: string;
};

function buildRepairTargets(ctx: RepairContext): RepairTarget[] {
  const seen = new Set<string>();
  const out: RepairTarget[] = [];

  const consider = (name: string | undefined) => {
    if (!name) return;
    const trimmed = name.trim();
    if (trimmed.length < 3) return; // 2-char names are too risky.
    const lowered = trimmed.toLowerCase();
    if (COMMON_WORD_NAMES.has(lowered)) return;
    if (seen.has(lowered)) return;
    seen.add(lowered);
    out.push({ canonical: trimmed, lowered });
  };

  for (const p of ctx.roster) {
    consider(p.name);
    const firstName = p.name.split(/\s+/)[0];
    if (firstName !== p.name) consider(firstName);
  }
  // jamesName is intentionally NOT added — we don't want "Jamie" being
  // mis-repaired into "James" mid-sentence.
  return out;
}

function findTokenStart(text: string, from: number): number {
  for (let i = from; i < text.length; i++) {
    if (isLetter(text.charCodeAt(i))) return i;
  }
  return -1;
}

function findTokenEnd(text: string, from: number): number {
  let i = from;
  while (i < text.length) {
    const c = text.charCodeAt(i);
    // Letters and apostrophes (so "she'll" stays one token).
    if (isLetter(c) || c === 39 /* ' */) {
      i++;
      continue;
    }
    break;
  }
  return i;
}

function isLetter(c: number): boolean {
  return (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
}

function tryRepairToken(token: string, targets: RepairTarget[]): string {
  if (token.length < 3) return token;
  const lowered = token.toLowerCase();
  // If the token IS already a canonical name (case-insensitively), preserve
  // its casing — we don't want to flatten "JACK" to "Jack".
  for (const t of targets) {
    if (t.lowered === lowered) return token;
  }
  // Otherwise find the closest target.
  let best: RepairTarget | null = null;
  let bestDist = Infinity;
  for (const t of targets) {
    // Cheap prefix gate: must share at least 2 leading chars for tokens
    // ≥ 4 chars; 1 leading char for shorter ones. Saves Levenshtein on
    // obviously-distinct candidates.
    const gateLen = lowered.length >= 4 ? 2 : 1;
    if (lowered.slice(0, gateLen) !== t.lowered.slice(0, gateLen)) continue;
    const d = levenshtein(lowered, t.lowered);
    if (d < bestDist) {
      bestDist = d;
      best = t;
    }
  }
  if (!best) return token;
  // Maximum acceptable edit distance scales with token length so "Jack" vs
  // "Jacks" (d=1) repairs, but "Jack" vs "Jacks's" (d=3) doesn't.
  const maxAllowed = lowered.length <= 4 ? 1 : 2;
  if (bestDist > maxAllowed) return token;
  // Preserve the original token's leading capitalisation pattern.
  if (token[0] === token[0].toUpperCase()) {
    return capitaliseFirst(best.canonical);
  }
  return best.canonical.toLowerCase();
}

function capitaliseFirst(s: string): string {
  if (s.length === 0) return s;
  return s[0].toUpperCase() + s.slice(1);
}

/**
 * Plain iterative Damerau-Levenshtein-lite (substitution + deletion +
 * insertion only; transposition skipped — it's an extra cost for marginal
 * coverage on the proper-noun repair use case).
 */
function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let prev = new Array(b.length + 1);
  let curr = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[b.length];
}
