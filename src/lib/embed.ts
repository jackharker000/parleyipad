/**
 * Client-side text-embedding helper. Wraps the `/api/embed/openai` proxy
 * with a small LRU cache so identical inputs (a transcript line repeated
 * across turns, a memory text re-queried back-to-back) don't pay the
 * round-trip more than once.
 *
 * Embeddings come from OpenAI's `text-embedding-3-small` (1536-dim). We
 * use it even when the active LLM provider is Anthropic — Anthropic
 * doesn't ship a first-party embedder and this is the cheapest decent
 * option, per the P3 design note.
 *
 * Cache: `Map`-backed LRU keyed by `text.trim().toLowerCase()`. Map
 * iteration order is insertion order, so the oldest entry is at the head;
 * on hit we delete+re-insert to push to the tail.
 */

import { cosine as cosineF32 } from "@/lib/audio/utils";

const LRU_CAPACITY = 256;
/** OpenAI's per-request input cap and our server proxy's enforced ceiling. */
const SERVER_BATCH_CAP = 100;

// Client-side wall-clock bound. The proxy already times out its own upstream,
// but a stall in the proxy hop itself (cold function, edge network) would hang
// the Tier-3 retrieval that gates a suggestion turn. Reject so the caller's
// degradation path runs instead of the cockpit waiting on embeddings forever.
const REQUEST_TIMEOUT_MS = 10_000;

const cache = new Map<string, number[]>();

function cacheKey(text: string): string {
  return text.trim().toLowerCase();
}

function lruGet(key: string): number[] | undefined {
  const v = cache.get(key);
  if (!v) return undefined;
  // Refresh recency.
  cache.delete(key);
  cache.set(key, v);
  return v;
}

function lruSet(key: string, value: number[]): void {
  if (cache.has(key)) cache.delete(key);
  cache.set(key, value);
  while (cache.size > LRU_CAPACITY) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

/**
 * Embed a batch of texts. Returns one vector per input, in the SAME order
 * as the input. Cached inputs short-circuit; uncached inputs are batched
 * into one fetch (or split across multiple if the batch exceeds the
 * server's per-request cap).
 *
 * Empty / whitespace-only inputs are passed through as empty vectors —
 * the matcher should never see them, but we don't want to silently drop
 * indices and shift the output rows.
 */
export async function embedTexts(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];

  const out: number[][] = new Array(texts.length);
  const misses: { index: number; text: string; key: string }[] = [];

  for (let i = 0; i < texts.length; i++) {
    const raw = texts[i] ?? "";
    if (raw.trim().length === 0) {
      out[i] = [];
      continue;
    }
    const key = cacheKey(raw);
    const hit = lruGet(key);
    if (hit) {
      out[i] = hit;
    } else {
      misses.push({ index: i, text: raw, key });
    }
  }

  for (let off = 0; off < misses.length; off += SERVER_BATCH_CAP) {
    const chunk = misses.slice(off, off + SERVER_BATCH_CAP);
    const vectors = await fetchEmbeddings(chunk.map((m) => m.text));
    for (let j = 0; j < chunk.length; j++) {
      const v = vectors[j];
      if (!Array.isArray(v) || v.length === 0) {
        throw new Error(`embedTexts: server returned empty vector for input ${chunk[j].index}`);
      }
      out[chunk[j].index] = v;
      lruSet(chunk[j].key, v);
    }
  }

  return out;
}

async function fetchEmbeddings(texts: string[]): Promise<number[][]> {
  let response: Response;
  try {
    response = await fetch("/api/embed/openai", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ texts }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === "TimeoutError") {
      throw new Error(`embedTexts: request timed out after ${REQUEST_TIMEOUT_MS}ms`);
    }
    throw new Error(`embedTexts: network error: ${(err as Error).message}`);
  }
  if (!response.ok) {
    // Preserve the upstream `{ error: "..." }` text so the cockpit's
    // `detectMissingKey` regex can still pick up
    // "OPENAI_API_KEY not set on the server".
    let msg = `embed proxy ${response.status}`;
    try {
      const body = (await response.json()) as { error?: unknown };
      if (typeof body?.error === "string" && body.error.length > 0) {
        msg = body.error;
      }
    } catch {
      /* fall through */
    }
    throw new Error(msg);
  }
  const data = (await response.json()) as { embeddings?: unknown };
  if (!Array.isArray(data.embeddings)) {
    throw new Error("embedTexts: response missing `embeddings` array");
  }
  return data.embeddings as number[][];
}

/**
 * Cosine similarity over plain number arrays. Thin wrapper around the
 * Float32Array implementation in `audio/utils.ts` — embeddings come back
 * from OpenAI as plain `number[]` so this is the form callers have on
 * hand.
 */
export function cosine(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  // Avoid an extra copy when the arrays are already Float32 (rare for
  // embeddings, but cheap to handle).
  if (a instanceof Float32Array && b instanceof Float32Array) {
    return cosineF32(a as Float32Array, b as Float32Array);
  }
  return cosineF32(Float32Array.from(a), Float32Array.from(b));
}
