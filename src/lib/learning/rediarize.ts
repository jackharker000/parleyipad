import { nanoid } from "nanoid";

import {
  db,
  type Person,
  type TranscriptSegment,
  type Voiceprint,
  type VoiceprintContribution,
} from "@/lib/db";
import { cosine, decodeEmbedding, encodeEmbedding, l2Normalize } from "@/lib/audio/utils";
import { makeAI } from "@/lib/ai";
import { getSettingsSnapshot } from "@/lib/settings";

/**
 * Tier-2 post-conversation re-diarize. Uses the saved per-segment ECAPA
 * embeddings to refine cluster → person mapping with hindsight. Cosine
 * matching against stored voiceprint centroids, then a short k-means
 * tightening pass, then an LLM tie-breaker for the segments whose top-2
 * posteriors stayed within an ambiguity gap.
 */

const MIN_SEGMENTS = 6;
const MIN_OTHER_PARTICIPANTS = 2;
const ACCEPT_COSINE = 0.55;
const ASSIGN_GAP = 0.05;
const TIE_BREAKER_GAP = 0.04;
const TIE_BREAKER_MAX_CANDIDATES = 12;
const KMEANS_MAX_ITERATIONS = 8;

export type RediarizeResult = {
  updates: number;
  error?: string;
};

export async function rediarizeConversation(conversationId: string): Promise<RediarizeResult> {
  try {
    const conversation = await db().conversations.get(conversationId);
    if (!conversation) return { updates: 0 };

    const otherParticipants = conversation.personIds;
    if (otherParticipants.length < MIN_OTHER_PARTICIPANTS) return { updates: 0 };

    const segments = await db()
      .transcriptSegments.where("conversationId")
      .equals(conversationId)
      .toArray();
    if (segments.length < MIN_SEGMENTS) return { updates: 0 };

    const embeddings = await db()
      .segmentEmbeddings.where("conversationId")
      .equals(conversationId)
      .toArray();
    if (embeddings.length === 0) return { updates: 0 };
    const embeddingBySegmentId = new Map<string, Float32Array>();
    for (const e of embeddings) {
      try {
        embeddingBySegmentId.set(e.segmentId, decodeEmbedding(e.embedding));
      } catch {
        // skip undecodable rows
      }
    }

    const voiceprints = await db().voiceprints.bulkGet(otherParticipants);
    const centroids = decodeVoiceprintCentroids(voiceprints);
    if (centroids.length < MIN_OTHER_PARTICIPANTS) return { updates: 0 };

    // 1. Cosine-against-centroid pass with accept threshold + gap rule.
    // Also remember the top-2 posteriors per segment so step 3 knows which
    // segments to escalate to the tie-breaker.
    const candidates = collectCandidates(segments, embeddingBySegmentId);
    if (candidates.length === 0) return { updates: 0 };
    const initialAssign = new Map<string, string | "unknown">();
    const topPairs = new Map<string, TopPair>();
    for (const c of candidates) {
      const pair = topTwoByCosine(c.embedding, centroids);
      topPairs.set(c.segmentId, pair);
      initialAssign.set(c.segmentId, finaliseFromPair(pair));
    }

    // 2. K-means tightening seeded from the same centroids + an unknown
    // bucket. Stops on convergence or after KMEANS_MAX_ITERATIONS rounds.
    const finalAssign = kmeansTighten(candidates, centroids, initialAssign);

    // 3. LLM tie-breaker for segments whose top-2 stayed within the
    // ambiguity gap (siblings, parent + adult child, etc). Cheap because
    // it's one call per conversation and only over the truly ambiguous
    // segments — bounded by TIE_BREAKER_MAX_CANDIDATES.
    await applyTieBreaker({
      conversationId,
      segments,
      finalAssign,
      topPairs,
      personIds: otherParticipants,
    });

    // 4. Persist any segment whose assignment changed, plus voiceprint
    // contributions so the rebuild job picks up the corrections.
    return await applyAssignments(conversationId, segments, finalAssign, embeddingBySegmentId);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { updates: 0, error: message };
  }
}

type Centroid = { personId: string; vector: Float32Array };
type Candidate = { segmentId: string; embedding: Float32Array };

function decodeVoiceprintCentroids(voiceprints: (Voiceprint | undefined)[]): Centroid[] {
  const out: Centroid[] = [];
  for (const vp of voiceprints) {
    if (!vp) continue;
    try {
      out.push({ personId: vp.personId, vector: decodeEmbedding(vp.centroid) });
    } catch {
      /* skip undecodable */
    }
  }
  return out;
}

function collectCandidates(
  segments: TranscriptSegment[],
  embeddingBySegmentId: Map<string, Float32Array>,
): Candidate[] {
  const out: Candidate[] = [];
  for (const seg of segments) {
    if (seg.speakerKind === "self") continue;
    const e = embeddingBySegmentId.get(seg.id);
    if (!e) continue;
    out.push({ segmentId: seg.id, embedding: e });
  }
  return out;
}

type TopPair = {
  bestId: string | "unknown";
  bestSim: number;
  secondId: string | "unknown";
  secondSim: number;
};

function topTwoByCosine(embedding: Float32Array, centroids: Centroid[]): TopPair {
  let bestId: string | "unknown" = "unknown";
  let bestSim = -Infinity;
  let secondId: string | "unknown" = "unknown";
  let secondSim = -Infinity;
  for (const c of centroids) {
    if (c.vector.length !== embedding.length) continue;
    const sim = cosine(c.vector, embedding);
    if (sim > bestSim) {
      secondId = bestId;
      secondSim = bestSim;
      bestId = c.personId;
      bestSim = sim;
    } else if (sim > secondSim) {
      secondId = c.personId;
      secondSim = sim;
    }
  }
  return { bestId, bestSim, secondId, secondSim };
}

function finaliseFromPair(pair: TopPair): string | "unknown" {
  if (pair.bestSim < ACCEPT_COSINE) return "unknown";
  if (pair.bestSim - pair.secondSim < ASSIGN_GAP) return "unknown";
  return pair.bestId;
}

/**
 * Port of `legacy-src/lib/rediarize.ts:kmeansRediarize`. Seeded with the
 * stored voiceprint centroids plus an unknown bucket. Re-derives centroids
 * from the assigned embeddings each iteration; bails on convergence.
 */
function kmeansTighten(
  candidates: Candidate[],
  centroids: Centroid[],
  initial: Map<string, string | "unknown">,
): Map<string, string | "unknown"> {
  if (candidates.length === 0) return initial;
  const dim = candidates[0].embedding.length;
  type Seed = { label: string | "unknown"; vector: Float32Array };
  const seeds: Seed[] = centroids
    .filter((c) => c.vector.length === dim)
    .map((c) => ({ label: c.personId as string | "unknown", vector: new Float32Array(c.vector) }));
  if (seeds.length === 0) return initial;

  const unknownInit = meanVector(
    candidates.filter((c) => initial.get(c.segmentId) === "unknown").map((c) => c.embedding),
    dim,
  );
  if (unknownInit) {
    seeds.push({ label: "unknown", vector: unknownInit });
  }

  let assignments = new Map(initial);
  for (let iter = 0; iter < KMEANS_MAX_ITERATIONS; iter++) {
    const next = new Map<string, string | "unknown">();
    for (const cand of candidates) {
      let bestLabel: string | "unknown" = seeds[0].label;
      let bestSim = -Infinity;
      for (const s of seeds) {
        if (s.vector.length !== cand.embedding.length) continue;
        const sim = cosine(s.vector, cand.embedding);
        if (sim > bestSim) {
          bestSim = sim;
          bestLabel = s.label;
        }
      }
      next.set(cand.segmentId, bestLabel);
    }

    for (const s of seeds) {
      const assigned = candidates.filter((c) => next.get(c.segmentId) === s.label);
      const mean = meanVector(
        assigned.map((c) => c.embedding),
        dim,
      );
      if (mean) s.vector = mean;
    }

    if (sameAssignments(assignments, next)) {
      assignments = next;
      break;
    }
    assignments = next;
  }

  return assignments;
}

function meanVector(vectors: Float32Array[], dim: number): Float32Array | null {
  if (vectors.length === 0) return null;
  const sum = new Float32Array(dim);
  for (const v of vectors) {
    if (v.length !== dim) continue;
    for (let i = 0; i < dim; i++) sum[i] += v[i];
  }
  for (let i = 0; i < dim; i++) sum[i] /= vectors.length;
  return l2Normalize(sum);
}

function sameAssignments<K, V>(a: Map<K, V>, b: Map<K, V>): boolean {
  if (a.size !== b.size) return false;
  for (const [k, v] of a) {
    if (b.get(k) !== v) return false;
  }
  return true;
}

async function applyTieBreaker(args: {
  conversationId: string;
  segments: TranscriptSegment[];
  finalAssign: Map<string, string | "unknown">;
  topPairs: Map<string, TopPair>;
  personIds: string[];
}): Promise<void> {
  const ambiguous: Array<{ segmentId: string; pair: TopPair; seg: TranscriptSegment }> = [];
  const segById = new Map(args.segments.map((s) => [s.id, s]));
  for (const [segmentId, pair] of args.topPairs.entries()) {
    // Only escalate segments the cosine + k-means pass left UNKNOWN. A
    // segment that finalAssign confidently placed (gap cleared ASSIGN_GAP)
    // must never be sent to the LLM — a hallucinated-but-confident reply
    // would otherwise overwrite a good assignment. The tie-breaker's job is
    // to rescue ambiguous unknowns, not to second-guess clean matches.
    if (args.finalAssign.get(segmentId) !== "unknown") continue;
    if (pair.bestSim < ACCEPT_COSINE) continue;
    const gap = pair.bestSim - pair.secondSim;
    if (gap >= TIE_BREAKER_GAP) continue;
    const seg = segById.get(segmentId);
    if (!seg) continue;
    ambiguous.push({ segmentId, pair, seg });
  }
  if (ambiguous.length === 0) return;
  ambiguous.sort((a, b) => a.pair.bestSim - a.pair.secondSim - (b.pair.bestSim - b.pair.secondSim));
  const truncated = ambiguous.slice(0, TIE_BREAKER_MAX_CANDIDATES);

  const people = await db().people.bulkGet(args.personIds);
  const personById = new Map<string, Person>();
  for (const p of people) {
    if (p) personById.set(p.id, p);
  }
  if (personById.size < 2) return;
  const rosterNames = Array.from(personById.values()).map((p) => p.name);
  const nameToId = new Map<string, string>();
  for (const p of personById.values()) nameToId.set(p.name.toLowerCase(), p.id);

  // Use the user's actual display name (or "Me" when unset) for self-segments
  // so the tie-breaker prompt isn't labelling them as the legacy "James".
  const jamesProfile = await db().jamesProfile.get("singleton");
  const selfLabel = jamesProfile?.displayName?.trim() || "Me";

  const orderedTranscript = args.segments
    .slice()
    .sort((a, b) => a.startedAt - b.startedAt)
    .map((s) => {
      const speaker =
        s.speakerKind === "self"
          ? selfLabel
          : (s.personId && personById.get(s.personId)?.name) || s.speakerLabel || "Unknown";
      return `${speaker}: ${s.text}`;
    })
    .join("\n");

  const settings = await getSettingsSnapshot();
  const ai = makeAI(settings.llmProvider);
  let result;
  try {
    result = await ai.aiRediarizeTieBreaker({
      candidates: truncated.map(({ segmentId, pair, seg }) => ({
        segmentId,
        text: seg.text,
        top1: {
          name: personById.get(pair.bestId === "unknown" ? "" : pair.bestId)?.name ?? "Unknown",
          posterior: pair.bestSim,
        },
        top2: {
          name: personById.get(pair.secondId === "unknown" ? "" : pair.secondId)?.name ?? "Unknown",
          posterior: pair.secondSim,
        },
      })),
      rosterNames,
      transcript: orderedTranscript,
    });
  } catch (err) {
    console.warn("[rediarize] tie-breaker failed; keeping cosine assignments", err);
    return;
  }

  const escalated = new Set(truncated.map((t) => t.segmentId));
  for (const decision of result.decisions) {
    // Defensive: only act on segments we actually escalated (all currently
    // "unknown"). Ignore stray ids the model might echo back, and a
    // sub-confidence or "unknown" verdict just leaves the segment unknown.
    if (!escalated.has(decision.segmentId)) continue;
    if (decision.confidence < 0.6) continue;
    if (decision.name === "unknown") continue;
    const personId = nameToId.get(decision.name.toLowerCase());
    if (!personId) continue;
    args.finalAssign.set(decision.segmentId, personId);
  }
}

async function applyAssignments(
  conversationId: string,
  segments: TranscriptSegment[],
  finalAssign: Map<string, string | "unknown">,
  embeddingBySegmentId: Map<string, Float32Array>,
): Promise<RediarizeResult> {
  let updates = 0;
  const segById = new Map(segments.map((s) => [s.id, s]));
  const now = Date.now();
  const contributions: VoiceprintContribution[] = [];

  for (const [segmentId, assignment] of finalAssign.entries()) {
    const seg = segById.get(segmentId);
    if (!seg) continue;

    if (assignment === "unknown") {
      if (seg.personId !== undefined || seg.speakerLabel !== "unknown") {
        await db().transcriptSegments.update(segmentId, {
          personId: undefined,
          speakerLabel: "unknown",
        });
        updates++;
      }
      continue;
    }

    const changed = seg.personId !== assignment;
    if (changed) {
      await db().transcriptSegments.update(segmentId, {
        personId: assignment,
        speakerLabel: assignment,
      });
      updates++;
    }

    // Always record a contribution row for the rebuild job — even when the
    // assignment didn't change, the rebuild benefits from the freshly
    // aggregated embeddings (and idempotency at the rebuild side means a
    // duplicated source utterance is harmless).
    const e = embeddingBySegmentId.get(segmentId);
    if (e) {
      contributions.push({
        id: nanoid(),
        personId: assignment,
        embedding: encodeEmbedding(e),
        conversationId,
        source: "rediarize",
        previewText: seg.text.slice(0, 80),
        rms: 0,
        durationSec: Math.max(0, (seg.endedAt - seg.startedAt) / 1000),
        createdAt: now,
      });
    }
  }

  // Idempotency: this job can re-run (retry, manual re-summarise, a second
  // Stop). Each run derives one contribution per attributed segment, so
  // without clearing the previous run's rows the rebuild job would average
  // N copies of this conversation's audio and progressively drown the
  // original enrollment samples — directly degrading speaker-ID, the #1
  // priority. Delete this conversation's prior auto-derived rows first;
  // enrollment-sourced rows (source !== "conversation") are never touched.
  const priorAuto = await db()
    .voiceprintContributions.where("conversationId")
    .equals(conversationId)
    .filter((c) => c.source === "rediarize")
    .primaryKeys();
  if (priorAuto.length > 0) {
    await db().voiceprintContributions.bulkDelete(priorAuto);
  }
  if (contributions.length > 0) {
    await db().voiceprintContributions.bulkAdd(contributions);
  }

  // Expand conv.personIds to cover any personId that ended up attributed.
  // Without this, a person whose every live segment was Unknown but whom
  // rediarize identifies offline won't be picked up by the subsequent
  // rebuildVoiceprints job (which reads conv.personIds for its scope).
  const finalPersonIds = new Set<string>();
  for (const v of finalAssign.values()) {
    if (v !== "unknown") finalPersonIds.add(v);
  }
  if (finalPersonIds.size > 0) {
    const conv = await db().conversations.get(conversationId);
    if (conv) {
      const merged = Array.from(new Set([...conv.personIds, ...finalPersonIds]));
      if (merged.length !== conv.personIds.length) {
        await db().conversations.update(conversationId, { personIds: merged });
      }
    }
  }

  return { updates };
}
