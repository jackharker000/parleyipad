import { nanoid } from "nanoid";

import { db, type Person, type Voiceprint, type VoiceprintContribution } from "@/lib/db";
import { makeAI } from "@/lib/ai";
import { decodeEmbedding, encodeEmbedding, l2Normalize } from "@/lib/audio/utils";
import { getJamesProfile } from "@/lib/jamesProfile";
import { getSettingsSnapshot } from "@/lib/settings";

/**
 * Tier-2 self-introduction detection. Regex pre-filter narrows the
 * transcript to candidate names, then an LLM call confirms which are
 * real self-introductions vs accidental ("meet me at the cafe") matches.
 * Confirmed names become `Person { status: "auto" }` rows the user can
 * review in Settings → People, with a seed voiceprint built from the same
 * conversation's segment embeddings where possible.
 *
 * Idempotent — running twice with no new candidates produces no new rows
 * (we dedupe by case-insensitive name against existing People).
 */

export type DetectIntroductionsResult = {
  created: number;
  error?: string;
};

// Ordered by confidence — strongest, least-ambiguous patterns first.
// All case-insensitive; we normalise the captured name afterwards.
const SELF_INTRO_REGEXES: RegExp[] = [
  /\bmy name['’]?s?\s+(?:is\s+)?([a-zA-Z'-]{2,})\b/i,
  /\bcall me\s+([a-zA-Z'-]{2,})\b/i,
  /\bthis is\s+([a-zA-Z'-]{2,})(?:\s+(?:speaking|here|calling))?\b/i,
  /\bi['’]?m\s+([a-zA-Z'-]{2,})\b/i,
  /\bi am\s+([a-zA-Z'-]{2,})\b/i,
  /\bit['’]?s\s+([a-zA-Z'-]{2,})(?:\s+here)?\b/i,
  /\bmeet\s+([A-Z][a-zA-Z'-]{2,})\b/,
  // "X here" — weakest; require capitalised X to reduce false positives.
  /\b([A-Z][a-zA-Z'-]{2,})\s+here\b/,
];

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
    "So",
    "Very",
    "Still",
    "Mum",
    "Mom",
    "Dad",
    "Nan",
    "Pop",
  ].map((s) => s.toLowerCase()),
);

export async function detectIntroductionsInConversation(
  conversationId: string,
): Promise<DetectIntroductionsResult> {
  try {
    const segments = await db()
      .transcriptSegments.where("conversationId")
      .equals(conversationId)
      .toArray();
    if (segments.length === 0) return { created: 0 };
    const ordered = segments.sort((a, b) => a.startedAt - b.startedAt);

    // 1. Regex pre-filter — collect candidate names tied to a speakerLabel.
    const candidatesByName = new Map<string, { name: string; speakerLabel: string }>();
    for (const seg of ordered) {
      const hits = extractIntroducedNames(seg.text);
      for (const name of hits) {
        const key = name.toLowerCase();
        if (!candidatesByName.has(key)) {
          candidatesByName.set(key, { name, speakerLabel: seg.speakerLabel });
        }
      }
    }
    if (candidatesByName.size === 0) return { created: 0 };

    // 2. Dedupe against existing people. Case-insensitive on first name.
    const allPeople = await db().people.toArray();
    const existingFirstNames = new Set(allPeople.map((p) => firstName(p.name).toLowerCase()));
    const survivors: Array<{ name: string; speakerLabel: string }> = [];
    for (const c of candidatesByName.values()) {
      if (existingFirstNames.has(firstName(c.name).toLowerCase())) continue;
      survivors.push(c);
    }
    if (survivors.length === 0) return { created: 0 };

    // 3. LLM confirmation pass — sees the full transcript context and rules
    // out false positives.
    const settings = await getSettingsSnapshot();
    const ai = makeAI(settings.llmProvider);
    const jamesProfile = await getJamesProfile();
    const jamesName = jamesProfile.displayName || "James";

    const transcript = ordered
      .map((s) => {
        const speaker = s.speakerKind === "self" ? jamesName : s.speakerLabel || "Unknown";
        return `${speaker}: ${s.text}`;
      })
      .join("\n")
      .slice(-8_000);

    let confirmed: Array<{ name: string; confidence: number }> = [];
    try {
      const res = await ai.detectIntroductions({
        transcript,
        candidates: survivors.map((s) => s.name),
      });
      confirmed = res.confirmed.filter((c) => c.confidence >= 0.7);
    } catch (err) {
      console.warn("[intro-detect] LLM call failed:", err);
      return { created: 0 };
    }
    if (confirmed.length === 0) return { created: 0 };

    // 4. Create Person rows + best-effort voiceprint seeds.
    const embeddings = await db()
      .segmentEmbeddings.where("conversationId")
      .equals(conversationId)
      .toArray();
    const labelToEmbeddings = new Map<string, Float32Array[]>();
    for (const e of embeddings) {
      const seg = ordered.find((s) => s.id === e.segmentId);
      if (!seg || seg.speakerKind === "self") continue;
      const label = seg.speakerLabel;
      const bucket = labelToEmbeddings.get(label) ?? [];
      try {
        bucket.push(l2Normalize(decodeEmbedding(e.embedding)));
        labelToEmbeddings.set(label, bucket);
      } catch {
        // skip undecodable
      }
    }

    const now = Date.now();
    let created = 0;
    for (const c of confirmed) {
      const survivor = survivors.find((s) => s.name.toLowerCase() === c.name.toLowerCase());
      if (!survivor) continue;
      // Re-check duplicate by first name (in case multiple intros for one person).
      if (existingFirstNames.has(firstName(survivor.name).toLowerCase())) continue;

      const person: Person = {
        id: nanoid(),
        name: survivor.name,
        status: "auto",
        createdAt: now,
        updatedAt: now,
      };
      await db().people.add(person);
      existingFirstNames.add(firstName(survivor.name).toLowerCase());

      const seedSamples = labelToEmbeddings.get(survivor.speakerLabel);
      if (seedSamples && seedSamples.length > 0) {
        await seedVoiceprint(person.id, seedSamples, conversationId, survivor.name, now);
      }

      created++;
    }
    return { created };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { created: 0, error: message };
  }
}

async function seedVoiceprint(
  personId: string,
  samples: Float32Array[],
  conversationId: string,
  previewText: string,
  now: number,
): Promise<void> {
  const dim = samples[0].length;
  const sum = new Float32Array(dim);
  for (const s of samples) {
    if (s.length !== dim) continue;
    for (let i = 0; i < dim; i++) sum[i] += s[i];
  }
  for (let i = 0; i < dim; i++) sum[i] /= samples.length;
  const centroid = l2Normalize(sum);

  const voiceprint: Voiceprint = {
    personId,
    centroid: encodeEmbedding(centroid),
    sampleCount: samples.length,
    updatedAt: now,
  };
  await db().voiceprints.put(voiceprint);

  // Record contributions so the rebuild job has provenance.
  const rows: VoiceprintContribution[] = samples.map((s) => ({
    id: nanoid(),
    personId,
    embedding: encodeEmbedding(s),
    conversationId,
    source: "conversation",
    previewText: previewText.slice(0, 80),
    rms: 0,
    durationSec: 0,
    createdAt: now,
  }));
  if (rows.length > 0) {
    await db().voiceprintContributions.bulkAdd(rows);
  }
}

/**
 * Run every regex over a single segment's text and return any normalised
 * names that pass the stop-word filter. Order-preserving, deduped within
 * the call (first match wins).
 */
function extractIntroducedNames(text: string): string[] {
  if (!text) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const rx of SELF_INTRO_REGEXES) {
    const m = text.match(rx);
    if (!m?.[1]) continue;
    const normalised = normaliseName(m[1]);
    if (!normalised) continue;
    const key = normalised.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(normalised);
  }
  return out;
}

function normaliseName(raw: string): string | null {
  const stripped = raw.replace(/['’]/g, "").trim();
  if (stripped.length < 2) return null;
  if (STOP_NAMES.has(stripped.toLowerCase())) return null;
  if (!/^[A-Za-z][A-Za-z-]*$/.test(stripped)) return null;
  return stripped[0].toUpperCase() + stripped.slice(1).toLowerCase();
}

function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] ?? name;
}
