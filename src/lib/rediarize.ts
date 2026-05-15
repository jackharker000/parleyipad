/**
 * Offline (post-conversation) re-diarization.
 *
 * Given the saved transcript + per-segment MFCC vectors + the user's confirmed
 * set of speakers (with their stored voiceprints as seeds), re-cluster the
 * non-James utterances using cosine k-means. This typically produces much
 * cleaner labels than the in-session diarizer because it can see the whole
 * conversation at once and benefits from stored, high-quality voiceprints
 * as seeds rather than drift-prone live centroids.
 *
 * Pure functions only — no Dexie / network dependencies in this module so it
 * stays trivially testable and reusable. Orchestration (DB reads/writes, LLM
 * tie-breakers) lives in `post-conversation.ts`.
 */
import { cosineSim } from "./voiceprint";

export type UtteranceVec = {
  segment_id: string;
  mfcc: number[];
  text: string;
  ts: number;
  current_label: string;
};

export type RediarizeResult = {
  /** segment_id -> final cluster label (one of seedLabels) */
  label_for_segment: Record<string, string>;
  /** label -> final centroid vector */
  cluster_centroids: Record<string, number[]>;
  /** label -> mean intra-cluster cosine similarity (0..1) */
  cluster_confidence: Record<string, number>;
  /** Utterances where best and runner-up clusters are close enough to need
   *  an LLM tie-breaker. */
  ambiguous: Array<{
    segment_id: string;
    best_label: string;
    runner_up_label: string;
    best_sim: number;
    gap: number;
  }>;
};

export type Seed = { label: string; centroid: number[] };

/** Gap below which two competing clusters are considered ambiguous and
 *  require an LLM tie-breaker. */
export const AMBIGUOUS_GAP = 0.05;

/** Maximum k-means iterations. Convergence on small N is usually <5. */
export const KMEANS_ITERATIONS = 10;

/**
 * Run cosine-distance k-means over the given utterances seeded from the
 * provided centroids. Seeds typically come from stored Voiceprints; the seed
 * label survives the run so callers can map directly to person ids.
 */
export function kmeansRediarize(utterances: UtteranceVec[], seeds: Seed[]): RediarizeResult {
  const labelForSegment: Record<string, string> = {};
  const centroids: Record<string, number[]> = {};
  const confidence: Record<string, number> = {};
  const ambiguous: RediarizeResult["ambiguous"] = [];

  if (utterances.length === 0 || seeds.length === 0) {
    for (const s of seeds) centroids[s.label] = s.centroid.slice();
    for (const s of seeds) confidence[s.label] = 0;
    return {
      label_for_segment: labelForSegment,
      cluster_centroids: centroids,
      cluster_confidence: confidence,
      ambiguous,
    };
  }

  // Initialise centroids from seeds.
  for (const s of seeds) centroids[s.label] = s.centroid.slice();

  // K-means: assign-then-update for KMEANS_ITERATIONS rounds.
  let assignments = new Map<string, string>();
  for (let iter = 0; iter < KMEANS_ITERATIONS; iter++) {
    const next = new Map<string, string>();
    for (const u of utterances) {
      let bestLabel = seeds[0].label;
      let bestSim = -Infinity;
      for (const label of Object.keys(centroids)) {
        const c = centroids[label];
        if (c.length !== u.mfcc.length) continue;
        const sim = cosineSim(u.mfcc, c);
        if (sim > bestSim) {
          bestSim = sim;
          bestLabel = label;
        }
      }
      next.set(u.segment_id, bestLabel);
    }

    // Update centroids = mean of assigned MFCCs.
    const labels = Object.keys(centroids);
    const dim = utterances[0].mfcc.length;
    const sums = new Map<string, number[]>();
    const counts = new Map<string, number>();
    for (const label of labels) {
      sums.set(label, new Array(dim).fill(0));
      counts.set(label, 0);
    }
    for (const u of utterances) {
      const label = next.get(u.segment_id)!;
      const sum = sums.get(label);
      if (!sum || u.mfcc.length !== dim) continue;
      for (let i = 0; i < dim; i++) sum[i] += u.mfcc[i];
      counts.set(label, (counts.get(label) ?? 0) + 1);
    }
    for (const label of labels) {
      const n = counts.get(label) ?? 0;
      if (n > 0) {
        const sum = sums.get(label)!;
        centroids[label] = sum.map((v) => v / n);
      }
      // else: keep seed centroid (empty cluster).
    }

    // Convergence check — identical assignments means stop.
    if (sameAssignments(assignments, next)) {
      assignments = next;
      break;
    }
    assignments = next;
  }

  for (const u of utterances) {
    labelForSegment[u.segment_id] = assignments.get(u.segment_id) ?? seeds[0].label;
  }

  // Compute ambiguous list + per-cluster confidence.
  const intraSums = new Map<string, { sum: number; count: number }>();
  for (const u of utterances) {
    let bestLabel: string | null = null;
    let bestSim = -Infinity;
    let runnerLabel: string | null = null;
    let runnerSim = -Infinity;
    for (const label of Object.keys(centroids)) {
      const c = centroids[label];
      if (c.length !== u.mfcc.length) continue;
      const sim = cosineSim(u.mfcc, c);
      if (sim > bestSim) {
        runnerLabel = bestLabel;
        runnerSim = bestSim;
        bestLabel = label;
        bestSim = sim;
      } else if (sim > runnerSim) {
        runnerLabel = label;
        runnerSim = sim;
      }
    }
    if (bestLabel) {
      const agg = intraSums.get(bestLabel) ?? { sum: 0, count: 0 };
      agg.sum += bestSim;
      agg.count += 1;
      intraSums.set(bestLabel, agg);
    }
    if (bestLabel && runnerLabel && runnerLabel !== bestLabel) {
      const gap = bestSim - runnerSim;
      if (gap < AMBIGUOUS_GAP) {
        ambiguous.push({
          segment_id: u.segment_id,
          best_label: bestLabel,
          runner_up_label: runnerLabel,
          best_sim: bestSim,
          gap,
        });
      }
    }
  }
  for (const label of Object.keys(centroids)) {
    const agg = intraSums.get(label);
    confidence[label] = agg && agg.count > 0 ? Math.max(0, Math.min(1, agg.sum / agg.count)) : 0;
  }

  return {
    label_for_segment: labelForSegment,
    cluster_centroids: centroids,
    cluster_confidence: confidence,
    ambiguous,
  };
}

function sameAssignments(a: Map<string, string>, b: Map<string, string>): boolean {
  if (a.size !== b.size) return false;
  for (const [k, v] of a) {
    if (b.get(k) !== v) return false;
  }
  return true;
}
