import { nanoid } from "nanoid";

import { db, type ProfileProposal, type TranscriptSegment } from "@/lib/db";
import { makeAI } from "@/lib/ai";
import { getJamesProfile } from "@/lib/jamesProfile";
import { getSettingsSnapshot } from "@/lib/settings";

/**
 * Tier-2 per-person profile enrichment. For each confirmed participant
 * with ≥ 4 of their own turns, builds a focused transcript (their turns +
 * the 2 surrounding segments either side for context) and asks the
 * smart-tier LLM for conservative additions to their Person row.
 *
 * Up to 5 `profileProposals` rows persist per person per conversation
 * with `status: "auto"` for the user to review in Settings → People.
 *
 * Idempotent — re-running on the same conversation produces no new
 * proposals for any (personId, conversationId) pair that already has them.
 */

const MIN_PERSON_TURNS = 4;
const MAX_PROPOSALS_PER_PERSON = 5;
const MAX_TRANSCRIPT_CHARS = 8_000;
const CONTEXT_SEGMENTS_EITHER_SIDE = 2;

export type EnrichProfilesResult = {
  proposals: number;
  error?: string;
};

export async function enrichProfilesFromConversation(
  conversationId: string,
): Promise<EnrichProfilesResult> {
  try {
    const conversation = await db().conversations.get(conversationId);
    if (!conversation) return { proposals: 0 };
    if (conversation.personIds.length === 0) return { proposals: 0 };

    const segments = await db()
      .transcriptSegments.where("conversationId")
      .equals(conversationId)
      .toArray();
    if (segments.length === 0) return { proposals: 0 };
    const ordered = segments.sort((a, b) => a.startedAt - b.startedAt);

    const jamesProfile = await getJamesProfile();
    const settings = await getSettingsSnapshot();
    const ai = makeAI(settings.llmProvider);
    const jamesName = jamesProfile.displayName || "James";

    let proposalsAdded = 0;
    for (const personId of conversation.personIds) {
      const person = await db().people.get(personId);
      if (!person) continue;

      // Idempotency: skip personIds that already have proposals from this
      // conversation. Cheap count — at most ~5 rows per pair.
      const existingCount = await db()
        .profileProposals.where("conversationId")
        .equals(conversationId)
        .filter((p) => p.personId === personId)
        .count();
      if (existingCount > 0) continue;

      const indices: number[] = [];
      for (let i = 0; i < ordered.length; i++) {
        if (ordered[i].personId === personId && ordered[i].speakerKind !== "self") {
          indices.push(i);
        }
      }
      if (indices.length < MIN_PERSON_TURNS) continue;

      const transcript = buildFocusedTranscript(ordered, indices, personId, jamesName);
      if (!transcript) continue;

      let result: {
        proposals: Array<{ field: string; op: string; value: string; reasoning?: string }>;
      };
      try {
        result = await ai.enrichPersonProfile({
          personName: person.name,
          transcript,
          currentProfile: {
            relationship: person.relationship,
            topicsLoved: person.topicsLoved,
            notes: person.notes,
          },
          jamesProfile,
        });
      } catch (err) {
        console.warn(`[profile-enrich] LLM call failed for ${person.name}:`, err);
        continue;
      }

      const now = Date.now();
      const rows: ProfileProposal[] = [];
      for (const p of result.proposals.slice(0, MAX_PROPOSALS_PER_PERSON)) {
        if (!p.value || p.value.trim().length === 0) continue;
        const op: ProfileProposal["op"] = p.op === "set" || p.op === "remove" ? p.op : "append";
        rows.push({
          id: nanoid(),
          personId,
          conversationId,
          field: p.field,
          value: p.value.trim(),
          op,
          reasoning: p.reasoning,
          status: "auto",
          createdAt: now,
        });
      }
      if (rows.length > 0) {
        await db().profileProposals.bulkAdd(rows);
        proposalsAdded += rows.length;
      }
    }

    return { proposals: proposalsAdded };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { proposals: 0, error: message };
  }
}

function buildFocusedTranscript(
  ordered: TranscriptSegment[],
  focusIndices: number[],
  focusPersonId: string,
  jamesName: string,
): string {
  const keep = new Set<number>();
  for (const i of focusIndices) {
    const lo = Math.max(0, i - CONTEXT_SEGMENTS_EITHER_SIDE);
    const hi = Math.min(ordered.length - 1, i + CONTEXT_SEGMENTS_EITHER_SIDE);
    for (let j = lo; j <= hi; j++) keep.add(j);
  }
  const lines: string[] = [];
  for (let i = 0; i < ordered.length; i++) {
    if (!keep.has(i)) continue;
    const seg = ordered[i];
    const speaker =
      seg.speakerKind === "self" ? jamesName : seg.personId === focusPersonId ? "Them" : "Other";
    lines.push(`${speaker}: ${seg.text}`);
  }
  const joined = lines.join("\n");
  return joined.length > MAX_TRANSCRIPT_CHARS ? joined.slice(-MAX_TRANSCRIPT_CHARS) : joined;
}
