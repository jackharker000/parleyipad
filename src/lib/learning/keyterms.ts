import { db, type JamesProfile, type Person, type PersonLexiconEntry } from "@/lib/db";

/**
 * Aggregate the per-conversation Scribe `keyterms` list. ElevenLabs Scribe v2
 * accepts a list of biased terms (the realtime API caps it at 50 entries of
 * 20 chars each; we conservatively cap at 30) and uses them to lift proper
 * nouns / jargon out of the language model's natural distribution. Without
 * this, names like "Jack" get mis-rendered as "Jacques" / "Jacks" every time.
 *
 * Source: https://elevenlabs.io/docs/eleven-api/guides/how-to/speech-to-text/batch/keyterm-prompting
 * + https://elevenlabs.io/docs/api-reference/speech-to-text/v-1-speech-to-text-realtime
 *
 * Tiers, weighted by descending priority:
 *   3.0  — every roster person's name + first-name, and their stored
 *          PersonLexiconEntry rows (which carry their own weight).
 *   1.5  — James's signature phrases (first ~3 words each) +
 *          first 5 entries from topicsLoved.
 *   1.2  — active place name, active event name + first 5 nouns from
 *          event.keyInfo (stop-word filtered).
 *   1.0  — extracted lexicon rows of type `transcript` per rostered person
 *          (cap 30 each before final dedupe).
 *
 * Returns a deduplicated array (case-insensitive on key, original casing
 * preserved on first occurrence), sorted by descending weight, capped at 30.
 */

export type BuildKeytermsArgs = {
  /** Roster — typically the closed set if declared, else every enrolled person. */
  people: Person[];
  jamesProfile?: JamesProfile;
  placeId?: string;
  eventId?: string;
};

export async function buildKeyterms(args: BuildKeytermsArgs): Promise<string[]> {
  const accumulator = new KeytermAccumulator();
  const personIds = args.people.map((p) => p.id);

  // Tier 1 — roster names + stored lexicon (any source) for those people.
  for (const person of args.people) {
    const name = person.name?.trim();
    if (!name) continue;
    accumulator.add(name, 3.0);
    const firstName = name.split(/\s+/)[0];
    if (firstName && firstName !== name) accumulator.add(firstName, 3.0);
  }

  let storedLexicon: PersonLexiconEntry[] = [];
  if (personIds.length > 0) {
    try {
      storedLexicon = await db().personLexicon.where("personId").anyOf(personIds).toArray();
    } catch {
      // Fresh DB / no rows — skip silently.
    }
  }
  for (const row of storedLexicon) {
    if (!row.term) continue;
    accumulator.add(row.term, row.weight ?? 1.0);
  }

  // Tier 2 — James's signature phrases (head words) + topicsLoved.
  if (args.jamesProfile) {
    const sigs = args.jamesProfile.signaturePhrases ?? [];
    for (const phrase of sigs) {
      const head = phrase.trim().split(/\s+/).slice(0, 3).join(" ");
      if (head) accumulator.add(head, 1.5);
    }
    const topics = (args.jamesProfile.topicsLoved ?? []).slice(0, 5);
    for (const topic of topics) {
      const trimmed = topic.trim();
      if (trimmed) accumulator.add(trimmed, 1.5);
    }
  }

  // Tier 3 — active place + active event name + nouns from event.keyInfo.
  if (args.placeId) {
    try {
      const place = await db().places.get(args.placeId);
      if (place?.name) accumulator.add(place.name, 1.2);
    } catch {
      /* ignore */
    }
  }
  if (args.eventId) {
    try {
      const event = await db().events.get(args.eventId);
      if (event?.name) accumulator.add(event.name, 1.2);
      if (event?.keyInfo) {
        const nouns = extractCandidateNouns(event.keyInfo).slice(0, 5);
        for (const noun of nouns) accumulator.add(noun, 1.2);
      }
    } catch {
      /* ignore */
    }
  }

  // Tier 4 — per-person transcript lexicon, cap 30 per person, weight 1.0.
  // Tier 1 above already merged every stored row at its stored weight, so
  // this is mostly redundant for transcript-sourced entries — but the cap-30
  // per-person guard documents the intent if someone later edits Tier 1
  // to exclude the transcript source.
  for (const personId of personIds) {
    try {
      const rows = await db()
        .personLexicon.where("source")
        .equals("transcript")
        .filter((e) => e.personId === personId)
        .limit(30)
        .toArray();
      for (const row of rows) {
        if (!row.term) continue;
        accumulator.add(row.term, Math.max(1.0, row.weight ?? 1.0));
      }
    } catch {
      /* ignore */
    }
  }

  return accumulator.take(30);
}

class KeytermAccumulator {
  private byKey = new Map<string, { original: string; weight: number }>();

  add(term: string, weight: number): void {
    const trimmed = term.trim();
    if (!trimmed) return;
    const key = trimmed.toLowerCase();
    const existing = this.byKey.get(key);
    if (existing) {
      // Keep the higher weight, keep the original casing (first occurrence wins).
      if (weight > existing.weight) existing.weight = weight;
      return;
    }
    this.byKey.set(key, { original: trimmed, weight });
  }

  take(limit: number): string[] {
    const sorted = Array.from(this.byKey.values()).sort((a, b) => b.weight - a.weight);
    return sorted.slice(0, limit).map((e) => e.original);
  }
}

/**
 * Cheap "noun-y" token extractor used by both the Tier 3 keyterms pull and
 * the Tier 1 lexicon extractor. Tokenises on whitespace + punctuation,
 * lowercases, drops a short English stop-word set, drops tokens <3 chars,
 * all-digit tokens, and tokens starting with a digit. Returns unique tokens
 * in first-seen order.
 *
 * Deliberately not an NER — we don't need recall, we need precision. A
 * Scribe keyterm doesn't have to be a noun; it just has to be unusual
 * enough that the language model would otherwise mis-render it.
 */
export function extractCandidateNouns(text: string): string[] {
  if (!text) return [];
  const tokens = text
    .toLowerCase()
    .split(/[^a-z0-9'-]+/u)
    .map((t) => t.replace(/^[-']+|[-']+$/g, ""))
    .filter((t) => t.length >= 3)
    .filter((t) => !/^\d/.test(t))
    .filter((t) => !/^\d+$/.test(t))
    .filter((t) => !STOP_WORDS.has(t));
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of tokens) {
    if (seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}

// ~80-entry English stop-word set. Intentionally small — we want
// proper-nounish tokens to survive; aggressive lists strip too much.
const STOP_WORDS = new Set<string>([
  "the",
  "and",
  "for",
  "are",
  "but",
  "not",
  "you",
  "all",
  "can",
  "had",
  "her",
  "was",
  "one",
  "our",
  "out",
  "day",
  "get",
  "has",
  "him",
  "his",
  "how",
  "man",
  "new",
  "now",
  "old",
  "see",
  "two",
  "way",
  "who",
  "boy",
  "did",
  "its",
  "let",
  "put",
  "say",
  "she",
  "too",
  "use",
  "any",
  "this",
  "that",
  "with",
  "from",
  "they",
  "have",
  "were",
  "been",
  "their",
  "what",
  "your",
  "when",
  "will",
  "would",
  "there",
  "could",
  "other",
  "than",
  "then",
  "them",
  "these",
  "into",
  "only",
  "some",
  "just",
  "very",
  "also",
  "where",
  "which",
  "while",
  "about",
  "before",
  "after",
  "because",
  "should",
  "such",
  "more",
  "most",
  "much",
  "many",
  "make",
  "made",
  "thing",
  "things",
  "well",
  "back",
  "even",
  "still",
  "going",
  "really",
  "around",
  "every",
]);
