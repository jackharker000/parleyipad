/**
 * Embedding backfill (Tier 3.1).
 *
 * On app mount, scan the IndexedDB memory store for rows that don't yet
 * have a usable embedding (missing, empty, or produced by an INCOMPATIBLE
 * model), and quietly populate them in the background. Bounded to a few
 * batches per session so we never hammer the embeddings API on a cold start
 * with thousands of historical memories.
 *
 * The real embedding model is threaded through from `embedWithModel` and
 * stored verbatim — vectors are never mislabeled with a fixed provider id,
 * so cross-space cosine comparisons can't happen (retrieval's guard relies
 * on the stored label being truthful).
 */

import { db, type Memory } from "./db";
import { embedWithModel, embeddingModelsCompatible, EMBEDDING_MODEL } from "./embeddings";

const BATCH = 32;
const MAX_MEMORIES_PER_RUN = 128;

/** A row counts as "fresh" if it has a non-empty embedding whose stored
 *  model is compatible with the model we'd produce now. Rows embedded by a
 *  different-but-compatible provider (e.g. Gemini when OpenAI is the current
 *  key) are left alone — their vectors still share the 1536-dim space. */
function hasUsableEmbedding(m: Memory): boolean {
  return (
    !!m.embedding &&
    m.embedding.length > 0 &&
    embeddingModelsCompatible(m.embedding_model, EMBEDDING_MODEL)
  );
}

/** Find memories missing a usable embedding. */
async function findStaleMemories(limit: number): Promise<Memory[]> {
  // Reverse-chronological so recent memories get embedded first.
  const recent = await db.memories.orderBy("created_at").reverse().toArray();
  const stale: Memory[] = [];
  for (const m of recent) {
    if (stale.length >= limit) break;
    if (m.status === "hidden") continue;
    if (!m.text || !m.text.trim()) continue;
    if (!hasUsableEmbedding(m)) stale.push(m);
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
      const { vectors, model } = await embedWithModel(chunk.map((m) => m.text));
      // No embeddings provider configured → empty vectors labeled "none".
      // Don't persist those (they'd mark rows non-stale and stop retrying);
      // a later run after a key is set will pick them up.
      if (model === "none" || vectors.length === 0) break;
      const updates = chunk
        .map((m, i) => ({ ...m, embedding: vectors[i], embedding_model: model }))
        .filter((u) => u.embedding && u.embedding.length > 0);
      if (updates.length === 0) break;
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
    const { vectors, model } = await embedWithModel(rows.map((r) => r.text));
    if (model === "none" || vectors.length === 0) return;
    const updates = rows
      .map((r, i) => ({ ...r, embedding: vectors[i], embedding_model: model }))
      .filter((u) => u.embedding && u.embedding.length > 0);
    if (updates.length === 0) return;
    await db.memories.bulkPut(updates);
  } catch (e) {
    console.warn("[embed-backfill] embedNewMemories failed", e);
  }
}
