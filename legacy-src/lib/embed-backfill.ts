/**
 * Embedding backfill (Tier 3.1).
 *
 * On app mount, scan the IndexedDB memory store for rows that don't yet
 * have an embedding (or whose embedding was generated with a different
 * model), and quietly populate them in the background. Bounded to a few
 * batches per session so we never hammer the OpenAI API on a cold start
 * with thousands of historical memories.
 */

import { db, type Memory } from "./db";
import { embed, EMBEDDING_MODEL } from "./embeddings";

const BATCH = 32;
const MAX_MEMORIES_PER_RUN = 128;

/** Find memories missing an up-to-date embedding. */
async function findStaleMemories(limit: number): Promise<Memory[]> {
  // Reverse-chronological so recent memories get embedded first.
  const recent = await db.memories.orderBy("created_at").reverse().toArray();
  const stale: Memory[] = [];
  for (const m of recent) {
    if (stale.length >= limit) break;
    if (m.status === "hidden") continue;
    if (!m.text || !m.text.trim()) continue;
    if (!m.embedding || m.embedding.length === 0 || m.embedding_model !== EMBEDDING_MODEL) {
      stale.push(m);
    }
  }
  return stale;
}

/** Embed and persist any memories missing an embedding. Safe to call on
 *  every mount — short-circuits when everything is already embedded. */
export async function backfillMemoryEmbeddings(): Promise<{
  embedded: number;
  skipped: number;
}> {
  let embedded = 0;
  const stale = await findStaleMemories(MAX_MEMORIES_PER_RUN);
  if (stale.length === 0) return { embedded: 0, skipped: 0 };

  for (let off = 0; off < stale.length; off += BATCH) {
    const chunk = stale.slice(off, off + BATCH);
    try {
      const vecs = await embed(chunk.map((m) => m.text));
      const updates = chunk.map((m, i) => ({
        ...m,
        embedding: vecs[i],
        embedding_model: EMBEDDING_MODEL,
      }));
      await db.memories.bulkPut(updates);
      embedded += updates.length;
    } catch (e) {
      console.warn("[embed-backfill] batch failed", e);
      // Stop on first failure — usually a transient API error.
      break;
    }
  }
  return { embedded, skipped: Math.max(0, stale.length - embedded) };
}

/** Synchronously embed the given memory texts and patch the rows. Used
 *  immediately after `db.memories.bulkAdd` so new memories are queryable
 *  by the next refresh. Failure is non-fatal — the next backfill will
 *  cover them. */
export async function embedNewMemories(memoryIds: string[]): Promise<void> {
  if (memoryIds.length === 0) return;
  const rows = (await db.memories.bulkGet(memoryIds)).filter((r): r is Memory => !!r);
  if (rows.length === 0) return;
  try {
    const vecs = await embed(rows.map((r) => r.text));
    const updates = rows.map((r, i) => ({
      ...r,
      embedding: vecs[i],
      embedding_model: EMBEDDING_MODEL,
    }));
    await db.memories.bulkPut(updates);
  } catch (e) {
    console.warn("[embed-backfill] embedNewMemories failed", e);
  }
}
