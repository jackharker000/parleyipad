import { nanoid } from "nanoid";

import { db, type Memory, type TranscriptSegment } from "@/lib/db";
import { makeAI } from "@/lib/ai";
import { encodeEmbedding } from "@/lib/audio/utils";
import { embedTexts } from "@/lib/embed";
import { getJamesProfile } from "@/lib/jamesProfile";
import { getSettingsSnapshot } from "@/lib/settings";

/**
 * Tier-3 memory extraction job — runs after each conversation Stop via
 * the pendingJobs drainer. Pulls the saved transcript, asks the smart-tier
 * LLM for up to 8 short factual memories worth keeping, embeds each so the
 * retrieval pipeline can do top-K cosine, then writes them to `memories`.
 *
 * Idempotent: skips if any memory for this conversation already exists.
 */

const MIN_SEGMENTS = 6;
const MAX_TRANSCRIPT_CHARS = 12_000;

export type ExtractMemoriesResult = {
  memoriesAdded: number;
  error?: string;
};

export async function extractMemoriesFromConversation(
  conversationId: string,
): Promise<ExtractMemoriesResult> {
  try {
    const existing = await db().memories.where("conversationId").equals(conversationId).count();
    if (existing > 0) return { memoriesAdded: 0 };

    const conversation = await db().conversations.get(conversationId);
    if (!conversation) return { memoriesAdded: 0 };
    if (conversation.personIds.length === 0) return { memoriesAdded: 0 };

    const segments = await db()
      .transcriptSegments.where("conversationId")
      .equals(conversationId)
      .toArray();
    if (segments.length < MIN_SEGMENTS) return { memoriesAdded: 0 };

    const people = await db().people.bulkGet(conversation.personIds);
    const present = people.filter((p): p is NonNullable<typeof p> => !!p);
    if (present.length === 0) return { memoriesAdded: 0 };
    const nameById = new Map(present.map((p) => [p.id, p.name]));
    const peopleNames = present.map((p) => p.name);

    const settings = await getSettingsSnapshot();
    const ai = makeAI(settings.llmProvider);
    const jamesProfile = await getJamesProfile();
    const selfLabel = jamesProfile.displayName?.trim() || "Me";

    const transcript = buildTranscript(segments, nameById, selfLabel);

    const result = await ai.extractMemories({
      transcript,
      conversationId,
      peopleNames,
      jamesProfile,
    });
    if (result.memories.length === 0) return { memoriesAdded: 0 };

    // Resolve the model's name-string `personId` field back to actual ids.
    const idByLowerName = new Map(present.map((p) => [p.name.toLowerCase(), p.id]));
    const resolved = result.memories.map((m) => ({
      kind: m.kind as string,
      text: m.text,
      personId: m.personId ? idByLowerName.get(m.personId.toLowerCase()) : undefined,
    }));

    // Batch-embed every memory text in one call.
    const vectors = await embedTexts(resolved.map((m) => m.text));

    const now = Date.now();
    const rows: Memory[] = [];
    for (let i = 0; i < resolved.length; i++) {
      const v = vectors[i];
      const embedding =
        Array.isArray(v) && v.length > 0 ? encodeEmbedding(new Float32Array(v)) : undefined;
      rows.push({
        id: nanoid(),
        personId: resolved[i].personId,
        conversationId,
        text: resolved[i].text,
        kind: resolved[i].kind,
        status: "active",
        embedding,
        createdAt: now,
        updatedAt: now,
      });
    }
    if (rows.length > 0) {
      await db().memories.bulkAdd(rows);
    }
    return { memoriesAdded: rows.length };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { memoriesAdded: 0, error: message };
  }
}

function buildTranscript(
  segments: TranscriptSegment[],
  nameById: Map<string, string>,
  selfLabel: string,
): string {
  const ordered = segments.slice().sort((a, b) => a.startedAt - b.startedAt);
  const lines = ordered.map((s) => {
    const speaker =
      s.speakerKind === "self"
        ? selfLabel
        : (s.personId && nameById.get(s.personId)) || s.speakerLabel || "Unknown";
    return `${speaker}: ${s.text}`;
  });
  const joined = lines.join("\n");
  // Head-trim to keep the tail, which usually has the freshest, most
  // memory-worthy content.
  return joined.length > MAX_TRANSCRIPT_CHARS ? joined.slice(-MAX_TRANSCRIPT_CHARS) : joined;
}
