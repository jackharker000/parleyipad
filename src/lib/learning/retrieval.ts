/**
 * Tier-3 semantic memory retrieval. Cheap brute-force cosine over the
 * IndexedDB `memories` table — there are at most a few hundred per person,
 * so a kd-tree or HNSW would be premature.
 *
 * Two callers:
 *   - live cockpit: at each turn, retrieve top-K memories for the people
 *     currently in the room (plus optionally the active place) and prepend
 *     them to the suggestion user-prompt.
 *   - drainer: re-embeds any memory whose text changed but whose embedding
 *     is stale; not the primary read path, exposed here so the same module
 *     owns the math.
 *
 * Pure I/O + math. No LLM calls, no DOM dependencies. Safe to import from
 * a worker if we ever move retrieval off the main thread.
 */

import { db, type Memory } from "@/lib/db";
import { embedTexts } from "@/lib/embed";
import { decodeEmbedding } from "@/lib/audio/utils";

export type RetrievalContext = {
  /** People currently in the room. */
  personIds: string[];
  /** Optional place context — used as a fallback scope when no people. */
  placeId?: string;
  /** Recent transcript lines used to build the query embedding. */
  recentTurns: Array<{ speaker: string; text: string }>;
};

export type RetrievedMemory = {
  memory: Memory;
  /** Cosine similarity 0–1 (or NaN-replaced 0 for un-embedded rows). */
  score: number;
};

const DEFAULT_TOP_K = 4;
/**
 * Build the query embedding from the last N turns concatenated. Cheap and
 * good enough for top-K matching — better than embedding each turn
 * separately and averaging (which dilutes per-turn meaning).
 */
const QUERY_TURN_WINDOW = 3;

/**
 * Retrieve the top-K most-similar memories for the active context.
 *
 * Scope precedence:
 *   1. If any personIds present, restrict to memories belonging to those people.
 *   2. Else if placeId present, restrict to memories at that place.
 *   3. Else open scope (all active memories).
 *
 * Memories without an embedding (legacy rows, or extraction failures)
 * fall through with score 0 — they're still returned by recency if the
 * caller asked for more rows than scored.
 */
export async function retrieveMemories(
  ctx: RetrievalContext,
  topK: number = DEFAULT_TOP_K,
): Promise<RetrievedMemory[]> {
  const candidates = await loadCandidates(ctx);
  if (candidates.length === 0) return [];

  const query = buildQueryText(ctx.recentTurns);
  if (!query) {
    // No meaningful query — return most-recently-updated memories.
    return candidates
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, topK)
      .map((m) => ({ memory: m, score: 0 }));
  }

  // Single embedding call for the query — the candidates already have
  // their embeddings persisted with them. The server returns plain JSON
  // arrays; convert once to Float32 for the cosine inner loop.
  const [queryArr] = await embedTexts([query]);
  const queryVec = new Float32Array(queryArr);

  const scored: RetrievedMemory[] = [];
  for (const m of candidates) {
    if (!m.embedding) {
      // Skip un-embedded rows from the scored set; they'll be considered
      // via the recency-fallback below if needed.
      continue;
    }
    let memoryVec: Float32Array;
    try {
      memoryVec = decodeEmbedding(m.embedding);
    } catch {
      continue;
    }
    if (memoryVec.length !== queryVec.length) continue;
    const score = cosineFloat(memoryVec, queryVec);
    scored.push({ memory: m, score });
  }
  scored.sort((a, b) => b.score - a.score);

  if (scored.length >= topK) return scored.slice(0, topK);

  // Recency-fallback to fill the remaining slots from un-embedded
  // candidates. Helps the cockpit not flash empty when a fresh user has
  // memories but no embeddings yet.
  const scoredIds = new Set(scored.map((s) => s.memory.id));
  const recencyFallback = candidates
    .filter((m) => !scoredIds.has(m.id))
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, topK - scored.length)
    .map((m) => ({ memory: m, score: 0 }));

  return [...scored, ...recencyFallback];
}

// --------------------------------------------------------------------------

async function loadCandidates(ctx: RetrievalContext): Promise<Memory[]> {
  const all = await db().memories.toArray();
  const active = all.filter((m) => m.status === "active");

  if (ctx.personIds.length > 0) {
    const ids = new Set(ctx.personIds);
    return active.filter((m) => m.personId && ids.has(m.personId));
  }
  if (ctx.placeId) {
    return active.filter((m) => m.placeId === ctx.placeId);
  }
  return active;
}

function buildQueryText(turns: RetrievalContext["recentTurns"]): string {
  const tail = turns.slice(-QUERY_TURN_WINDOW);
  if (tail.length === 0) return "";
  return tail
    .map((t) => `${t.speaker}: ${t.text}`)
    .join("\n")
    .trim();
}

/**
 * Cosine for two Float32Arrays. The shared util in `src/lib/audio/utils.ts`
 * has the same logic for the speaker-ID matcher; duplicating two lines here
 * keeps the embedding pipeline free of audio-side dependencies (the audio
 * utils module pulls in WASM helpers).
 */
function cosineFloat(a: Float32Array, b: Float32Array): number {
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
