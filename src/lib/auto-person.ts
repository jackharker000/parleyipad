import type { Person } from "./db";

// Ordered by confidence — strongest, least-ambiguous patterns first.
// All case-insensitive; we normalise the captured name afterwards.
const SELF_INTRO_REGEXES = [
  /\bmy name['’]?s?\s+(?:is\s+)?([a-zA-Z'-]{2,})\b/i,
  /\bcall me\s+([a-zA-Z'-]{2,})\b/i,
  /\bthis is\s+([a-zA-Z'-]{2,})(?:\s+(?:speaking|here|calling))?\b/i,
  /\bi['’]?m\s+([a-zA-Z'-]{2,})\b/i,
  /\bi am\s+([a-zA-Z'-]{2,})\b/i,
  /\bit['’]?s\s+([a-zA-Z'-]{2,})(?:\s+here)?\b/i,
  // "X here" — weakest; require capitalised X to reduce false positives.
  /\b([A-Z][a-zA-Z'-]{1,})\s+here\b/,
];

// Words that look like names but aren't. Compared case-insensitively.
// NOTE: the account owner's own name is excluded dynamically (see the
// `ownerName` param below) rather than hardcoded here, so this list stays
// generic across every user of the app.
const STOP_NAMES = new Set(
  [
    "Mr",
    "Mrs",
    "Ms",
    "Dr",
    "Hello",
    "Hi",
    "Hey",
    "Yes",
    "No",
    "OK",
    "Okay",
    "Sorry",
    "Thanks",
    "Thank",
    "Speaker",
    // Pronouns & filler that previously slipped through ("Im here…")
    "I",
    "Im",
    "Ive",
    "Ill",
    "Id",
    "A",
    "An",
    "The",
    "Just",
    "Only",
    "Actually",
    "Really",
    "Here",
    "There",
    "Back",
    "Home",
    "Out",
    "In",
    "On",
    "Off",
    "Up",
    "Down",
    "Now",
    "Today",
    "Tonight",
    "Tomorrow",
    "Yesterday",
    "Going",
    "Coming",
    "Doing",
    "Trying",
    "Looking",
    "Sure",
    "Fine",
    "Good",
    "Great",
    "Right",
    "Wrong",
    "Tired",
    "Happy",
    "Sad",
    "Sorry",
    "So",
    "Very",
    "Still",
    "Almost",
    "Nearly",
    "Mum",
    "Mom",
    "Dad",
    "Nan",
    "Pop",
  ].map((s) => s.toLowerCase()),
);

function normaliseName(raw: string): string | null {
  const stripped = raw.replace(/['’]/g, "").trim();
  if (stripped.length < 2) return null;
  if (STOP_NAMES.has(stripped.toLowerCase())) return null;
  // Reject anything with internal punctuation that isn't a hyphen.
  if (!/^[A-Za-z][A-Za-z-]*$/.test(stripped)) return null;
  return stripped[0].toUpperCase() + stripped.slice(1).toLowerCase();
}

/**
 * Names introduced via self-intro patterns in the transcript.
 *
 * `ownerName` (the signed-in account owner) is excluded so the app never
 * proposes creating a Person record for the user it's speaking as — even
 * when their own name is spoken during an introduction.
 */
export function extractIntroducedNames(
  segments: { text: string; speaker_label: string }[],
  ownerName?: string,
): { name: string; speaker_label: string }[] {
  const out: { name: string; speaker_label: string }[] = [];
  const seen = new Set<string>();
  const ownerLc = ownerName?.trim().toLowerCase();
  for (const seg of segments) {
    for (const rx of SELF_INTRO_REGEXES) {
      const m = seg.text.match(rx);
      if (m?.[1]) {
        const name = normaliseName(m[1]);
        if (!name) continue;
        if (ownerLc && name.toLowerCase() === ownerLc) continue;
        const key = name.toLowerCase() + "|" + seg.speaker_label;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ name, speaker_label: seg.speaker_label });
        break;
      }
    }
  }
  return out;
}

// Re-export retained type for convenience.
export type { Person };