import { nanoid } from "nanoid";

import { db, type PersonLexiconEntry, type TranscriptSegment } from "@/lib/db";
import type { DomainAI } from "@/lib/ai";
import { getJamesProfile } from "@/lib/jamesProfile";

/**
 * Post-conversation lexicon updater. Walks the just-finished transcript,
 * extracts per-person proper nouns / jargon / pet names / unusual words via
 * the smart-tier LLM, and persists them to `personLexicon` so future Scribe
 * sessions can bias toward those terms (see `buildKeyterms`).
 *
 * Idempotency: deduped against existing rows by case-insensitive term match
 * per person, so re-running on the same conversation produces no new rows.
 * Safe to retry from the pendingJobs drainer.
 *
 * Gates:
 *   - James's own ("self") segments are excluded — we're learning the
 *     *other* person's vocabulary, not James's signature phrases (which
 *     come from the profile).
 *   - Persons with <4 of their own segments are skipped (too little signal,
 *     and the LLM tends to invent terms when starved for context).
 *   - Cap 10 new terms per person per conversation.
 */
export async function updatePersonLexicon(conversationId: string, ai: DomainAI): Promise<void> {
  const segments = await db()
    .transcriptSegments.where("conversationId")
    .equals(conversationId)
    .toArray();
  if (segments.length === 0) return;

  const ordered = segments.sort((a, b) => a.startedAt - b.startedAt);

  // Group by personId; only segments attributed to a known person count.
  const byPerson = new Map<string, TranscriptSegment[]>();
  for (const seg of ordered) {
    if (seg.speakerKind === "self") continue;
    if (!seg.personId) continue;
    let bucket = byPerson.get(seg.personId);
    if (!bucket) {
      bucket = [];
      byPerson.set(seg.personId, bucket);
    }
    bucket.push(seg);
  }

  // Resolve the user's display name once so the contextual transcript labels
  // their own turns with the actual name rather than the legacy "James" sentinel.
  const jamesProfile = await getJamesProfile();
  const selfLabel = jamesProfile.displayName?.trim() || "Me";

  for (const [personId, personSegments] of byPerson) {
    if (personSegments.length < 4) continue;

    const person = await db().people.get(personId);
    if (!person) continue;

    const transcriptBlock = buildContextualTranscript(ordered, personId, selfLabel);

    // Existing terms — passed to the LLM so it skips repeats. Lowercased
    // for dedupe and term filter both.
    const existing = await db().personLexicon.where("personId").equals(personId).toArray();
    const existingTermsLower = new Set(existing.map((row) => row.term.trim().toLowerCase()));
    const existingTerms = existing.map((row) => row.term);

    let result: { terms: Array<{ term: string; weight: number; reasoning?: string }> };
    try {
      result = await ai.extractLexicon({
        transcript: transcriptBlock,
        personName: person.name,
        existingTerms,
      });
    } catch (err) {
      console.warn(`[lexicon-extract] LLM call failed for ${person.name}:`, err);
      continue;
    }

    const now = Date.now();
    const rows: PersonLexiconEntry[] = [];
    for (const entry of result.terms.slice(0, 10)) {
      const term = entry.term?.trim();
      if (!term) continue;
      if (existingTermsLower.has(term.toLowerCase())) continue;
      const weight = clamp(entry.weight ?? 1.0, 0.5, 2.0);
      rows.push({
        id: nanoid(),
        term,
        personId,
        weight,
        source: "transcript",
        createdAt: now,
      });
      // Mark as seen so duplicates inside the same LLM output don't sneak through.
      existingTermsLower.add(term.toLowerCase());
    }

    if (rows.length > 0) {
      await db().personLexicon.bulkAdd(rows);
    }
  }
}

/**
 * Build a focused transcript view for one person: their own turns plus the
 * single segment immediately before each (for question-context). Keeps the
 * LLM prompt grounded without burning the full conversation budget.
 */
function buildContextualTranscript(
  allSegments: TranscriptSegment[],
  focusPersonId: string,
  selfLabel: string,
): string {
  const lines: string[] = [];
  for (let i = 0; i < allSegments.length; i++) {
    const seg = allSegments[i];
    const isFocus = seg.personId === focusPersonId && seg.speakerKind !== "self";
    if (!isFocus) continue;
    // Pull one segment of context if available and not already included.
    const prev = i > 0 ? allSegments[i - 1] : undefined;
    if (prev && (!lines.length || !lines[lines.length - 1].includes(prev.text))) {
      const prevSpeaker = prev.speakerKind === "self" ? selfLabel : (prev.speakerLabel ?? "Other");
      lines.push(`${prevSpeaker}: ${prev.text}`);
    }
    lines.push(`Them: ${seg.text}`);
  }
  return lines.join("\n");
}

function clamp(x: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, x));
}
