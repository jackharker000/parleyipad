/**
 * Memory retrieval (Tier 3.1).
 *
 * Given a query embedding (typically the embedding of the last few turns)
 * pick the top-K most semantically relevant memories for the person /
 * place currently in scope. Falls back to recency-based selection for
 * memories that don't yet have an embedding (cold-start, or rows produced
 * before this feature).
 *
 * Brute-force cosine over IndexedDB rows is fine for <500 memories per
 * scope; the Supabase pgvector migration is the future server-side path.
 */

import { db, type Memory } from "./db";
import { cosineSimVec, EMBEDDING_MODEL } from "./embeddings";

export type RetrievalOptions = {
  queryEmbedding: number[];
  personId?: string;
  placeId?: string;
  presentPersonIds?: ReadonlySet<string>;
  k?: number;
};

/**
 * Pick the top-K memories that match the query embedding, scoped by
 * person or place if provided. Memories without an embedding (or with a
 * different embedding model) are kept in a recency fallback bucket and
 * surfaced only if the embedding-scored bucket is short.
 */
export async function retrieveTopK(opts: RetrievalOptions): Promise<Memory[]> {
  const k = opts.k ?? 4;
  if (k <= 0) return [];

  let pool: Memory[] = [];
  if (opts.personId) {
    pool = await db.memories.where("person_id").equals(opts.personId).toArray();
  } else if (opts.placeId) {
    pool = await db.memories.where("place_id").equals(opts.placeId).toArray();
  } else {
    pool = await db.memories.orderBy("created_at").reverse().limit(200).toArray();
  }

  // Privacy: when a place-scoped query is filtered through present-people,
  // drop memories that belong to people not in the room.
  if (opts.placeId && opts.presentPersonIds) {
    pool = pool.filter((m) => !m.person_id || opts.presentPersonIds!.has(m.person_id));
  }

  pool = pool.filter((m) => m.status !== "hidden");

  const scored: Array<{ mem: Memory; score: number }> = [];
  const unembedded: Memory[] = [];
  for (const mem of pool) {
    if (
      mem.embedding &&
      mem.embedding.length > 0 &&
      mem.embedding_model === EMBEDDING_MODEL &&
      mem.embedding.length === opts.queryEmbedding.length
    ) {
      scored.push({
        mem,
        score: cosineSimVec(opts.queryEmbedding, mem.embedding),
      });
    } else {
      unembedded.push(mem);
    }
  }

  scored.sort((a, b) => b.score - a.score);
  const top: Memory[] = scored.slice(0, k).map((s) => s.mem);

  if (top.length < k) {
    // Recency fallback for cold-start: backfill from un-embedded rows.
    unembedded.sort((a, b) => b.created_at - a.created_at);
    for (const m of unembedded) {
      if (top.length >= k) break;
      top.push(m);
    }
  }
  return top;
}

/** Format a memory row the same way `context.ts:memoriesForPerson` does. */
export function formatMemoryForPrompt(m: Memory): string {
  return `[${m.kind}] ${m.text}`;
}
