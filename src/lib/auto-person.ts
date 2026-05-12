import { db, newId, type Person, type TranscriptSegment } from "./db";

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
const STOP_NAMES = new Set(
  [
    "James",
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

/** Names introduced via self-intro patterns in the transcript. */
export function extractIntroducedNames(
  segments: { text: string; speaker_label: string }[],
): { name: string; speaker_label: string }[] {
  const out: { name: string; speaker_label: string }[] = [];
  const seen = new Set<string>();
  for (const seg of segments) {
    for (const rx of SELF_INTRO_REGEXES) {
      const m = seg.text.match(rx);
      if (m?.[1]) {
        const name = normaliseName(m[1]);
        if (!name) continue;
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

/**
 * Auto-create Person rows for any introduced names not already in the DB.
 * Returns the full list of new people created.
 */
export async function autoCreateIntroducedPeople(
  segments: TranscriptSegment[],
  existing: Person[],
  opts?: { placeId?: string },
): Promise<Person[]> {
  const introduced = extractIntroducedNames(segments);
  if (introduced.length === 0) return [];
  const haveByFirst = new Set(
    existing.map((p) => p.name.trim().split(/\s+/)[0].toLowerCase()),
  );
  const created: Person[] = [];
  for (const { name } of introduced) {
    const key = name.toLowerCase();
    if (haveByFirst.has(key)) continue;
    haveByFirst.add(key);
    const p: Person = {
      id: newId(),
      name,
      relationship: "",
      interests: [],
      notes: opts?.placeId
        ? `Auto-added — first met during a conversation.`
        : "Auto-added from conversation.",
      style_notes: "",
      created_at: Date.now(),
    };
    await db.people.put(p);
    created.push(p);
  }
  return created;
}