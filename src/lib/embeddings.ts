/**
 * Embedding helpers (Tier 3.1).
 *
 * Wraps the `embedTexts` server function with a small in-memory LRU cache
 * so identical query contexts (which happen often during a sustained
 * conversation — only one or two turns differ) don't pay the OpenAI API
 * round-trip twice.
 *
 * Embeddings are produced server-side by whichever provider key is present —
 * `gemini-embedding-001` or `openai/text-embedding-3-small`, both at 1536
 * dims so they share a comparable space (see COMPATIBLE_EMBEDDING_MODELS).
 * The real model is threaded back through `embedWithModel` so callers persist
 * the true `embedding_model` instead of assuming a fixed provider. Storage
 * lives on the IndexedDB `Memory` and `TranscriptSegment` rows; this module
 * owns nothing persistent.
 */

import { embedTexts } from "./aac.functions";

export const EMBEDDING_MODEL = "text-embedding-3-small";
export const EMBEDDING_DIMS = 1536;

/**
 * Embedding models that produce vectors in a COMPATIBLE 1536-dim space and
 * may be cosine-compared against each other. Both the OpenAI and Gemini
 * paths in `embedTexts` request 1536 dims, so a query embedded by one can be
 * matched against rows embedded by the other without crossing embedding
 * spaces in a way that wrecks similarity. Anything outside this set (e.g. a
 * legacy 768-dim `text-embedding-004` row, or the `"none"` no-provider
 * sentinel) is treated as incompatible by retrieval and falls to the recency
 * bucket.
 */
export const COMPATIBLE_EMBEDDING_MODELS: ReadonlySet<string> = new Set([
  "text-embedding-3-small",
  "gemini-embedding-001",
]);

/** Are two embedding-model labels safe to cosine-compare? Same model always
 *  matches; different models only match when both are in the compatible set. */
export function embeddingModelsCompatible(
  a: string | undefined,
  b: string | undefined,
): boolean {
  if (!a || !b) return false;
  if (a === b) return true;
  return COMPATIBLE_EMBEDDING_MODELS.has(a) && COMPATIBLE_EMBEDDING_MODELS.has(b);
}

// Single in-memory LRU keyed by a stable hash of the input text. Each entry
// carries the model that produced it so the real embedding space can be
// threaded through to storage (never hard-coded to EMBEDDING_MODEL).
type CacheEntry = { vec: number[]; model: string };
const LRU_CAPACITY = 64;
const cache = new Map<string, CacheEntry>();

function hashKey(text: string): string {
  // Cheap deterministic hash — collisions are tolerable (worst case: cache
  // miss → an extra API call). Length-prefix keeps inputs of different
  // sizes from colliding too easily.
  let h = 5381;
  for (let i = 0; i < text.length; i++) {
    h = (h * 33) ^ text.charCodeAt(i);
  }
  return `${text.length}:${(h >>> 0).toString(36)}`;
}

function lruGet(key: string): CacheEntry | undefined {
  const v = cache.get(key);
  if (!v) return undefined;
  // Refresh recency.
  cache.delete(key);
  cache.set(key, v);
  return v;
}

function lruSet(key: string, value: CacheEntry) {
  if (cache.has(key)) cache.delete(key);
  cache.set(key, value);
  if (cache.size > LRU_CAPACITY) {
    const first = cache.keys().next().value;
    if (first !== undefined) cache.delete(first);
  }
}

/**
 * Embed a batch of texts, returning the vectors AND the embedding model that
 * produced them — so callers can persist the real `embedding_model` rather
 * than assuming a fixed provider. Hits the LRU before calling out.
 *
 * The model is reported once per call: whichever model the fresh `embedTexts`
 * round-trip returned (or, for an all-cache-hit batch, the model stored with
 * the first hit). Because every provider path requests 1536 dims and the
 * compatible-models set treats them as one space, a batch can't end up with
 * vectors that are unsafe to compare under a single returned label.
 */
export async function embedWithModel(
  texts: string[],
): Promise<{ vectors: number[][]; model: string }> {
  const cleaned = texts.map((t) => t.trim()).filter((t) => t.length > 0);
  if (cleaned.length === 0) return { vectors: [], model: EMBEDDING_MODEL };

  const out: number[][] = new Array(cleaned.length);
  const misses: { index: number; text: string; key: string }[] = [];
  let model: string | undefined;

  for (let i = 0; i < cleaned.length; i++) {
    const key = hashKey(cleaned[i]);
    const hit = lruGet(key);
    if (hit) {
      out[i] = hit.vec;
      model ??= hit.model;
    } else {
      misses.push({ index: i, text: cleaned[i], key });
    }
  }

  if (misses.length > 0) {
    // The server fn caps inputs at 64; chunk if we're somehow over.
    for (let off = 0; off < misses.length; off += 64) {
      const chunk = misses.slice(off, off + 64);
      const result = await embedTexts({
        data: { texts: chunk.map((m) => m.text) },
      });
      // The server reports the real model that produced these vectors
      // (text-embedding-3-small | gemini-embedding-001 | none). Thread it
      // through so storage records the true embedding space.
      const fetchedModel = result.model ?? EMBEDDING_MODEL;
      model = fetchedModel;
      result.embeddings.forEach((vec, j) => {
        const slot = chunk[j];
        out[slot.index] = vec;
        lruSet(slot.key, { vec, model: fetchedModel });
      });
    }
  }
  return { vectors: out, model: model ?? EMBEDDING_MODEL };
}

/**
 * Embed a batch of texts. Returns one vector per input, in order. Thin
 * back-compat wrapper over `embedWithModel` for callers that don't need the
 * model label.
 */
export async function embed(texts: string[]): Promise<number[][]> {
  const { vectors } = await embedWithModel(texts);
  return vectors;
}

/** Embed a single string (convenience). Returns null on failure / empty. */
export async function embedOne(text: string): Promise<number[] | null> {
  try {
    const { vectors } = await embedWithModel([text]);
    return vectors[0] ?? null;
  } catch (e) {
    console.warn("[embeddings] embedOne failed", e);
    return null;
  }
}

/** Embed a single string AND report the model used. Returns null vector on
 *  failure / empty so callers can skip silently (graceful degradation). */
export async function embedOneWithModel(
  text: string,
): Promise<{ vector: number[] | null; model: string }> {
  try {
    const { vectors, model } = await embedWithModel([text]);
    return { vector: vectors[0] ?? null, model };
  } catch (e) {
    console.warn("[embeddings] embedOneWithModel failed", e);
    return { vector: null, model: EMBEDDING_MODEL };
  }
}

/** Cosine similarity between two equal-length vectors. */
export function cosineSimVec(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}
