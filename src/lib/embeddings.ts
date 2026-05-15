/**
 * Embedding helpers (Tier 3.1).
 *
 * Wraps the `embedTexts` server function with a small in-memory LRU cache
 * so identical query contexts (which happen often during a sustained
 * conversation — only one or two turns differ) don't pay the OpenAI API
 * round-trip twice.
 *
 * Embeddings are produced by `openai/text-embedding-3-small` (1536 dims,
 * $0.02 / M tokens). Storage lives on the IndexedDB `Memory` and
 * `TranscriptSegment` rows; this module owns nothing persistent.
 */

import { embedTexts } from "./aac.functions";

export const EMBEDDING_MODEL = "text-embedding-3-small";
export const EMBEDDING_DIMS = 1536;

// Single in-memory LRU keyed by a stable hash of the input text.
const LRU_CAPACITY = 64;
const cache = new Map<string, number[]>();

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

function lruGet(key: string): number[] | undefined {
  const v = cache.get(key);
  if (!v) return undefined;
  // Refresh recency.
  cache.delete(key);
  cache.set(key, v);
  return v;
}

function lruSet(key: string, value: number[]) {
  if (cache.has(key)) cache.delete(key);
  cache.set(key, value);
  if (cache.size > LRU_CAPACITY) {
    const first = cache.keys().next().value;
    if (first !== undefined) cache.delete(first);
  }
}

/**
 * Embed a batch of texts. Returns one vector per input, in order. Hits the
 * LRU before calling out. Empty / whitespace-only inputs are filtered up
 * front (the API rejects them and they're meaningless anyway).
 */
export async function embed(texts: string[]): Promise<number[][]> {
  const cleaned = texts.map((t) => t.trim()).filter((t) => t.length > 0);
  if (cleaned.length === 0) return [];

  const out: number[][] = new Array(cleaned.length);
  const misses: { index: number; text: string; key: string }[] = [];

  for (let i = 0; i < cleaned.length; i++) {
    const key = hashKey(cleaned[i]);
    const hit = lruGet(key);
    if (hit) {
      out[i] = hit;
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
      result.embeddings.forEach((vec, j) => {
        const slot = chunk[j];
        out[slot.index] = vec;
        lruSet(slot.key, vec);
      });
    }
  }
  return out;
}

/** Embed a single string (convenience). Returns null on failure / empty. */
export async function embedOne(text: string): Promise<number[] | null> {
  try {
    const vecs = await embed([text]);
    return vecs[0] ?? null;
  } catch (e) {
    console.warn("[embeddings] embedOne failed", e);
    return null;
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
