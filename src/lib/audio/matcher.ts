import { cosine, decodeEmbedding, softmax } from "./utils";
import type { Person, VoiceSample } from "@/lib/db";

/**
 * Bayesian-ish speaker matcher.
 *
 *   posterior(person | audio, context)
 *     ∝ likelihood(audio | person) × prior(person | context)
 *
 * - Likelihood comes from cosine similarity between the candidate's voice
 *   embedding and each enrolled person's centroid, pushed through a softmax
 *   with a sharp temperature to turn similarities into a probability mass.
 * - Prior is multiplicative over independent signals:
 *     - location bias (was this person heard at this place?)
 *     - event bias (are they expected at this event?)
 *     - recency bias (have they just spoken?)
 *     - unknown-speaker reserve (mass kept for "someone we haven't enrolled")
 *
 * Output is a ranked list with posteriors that sum to 1, including a
 * synthetic "unknown" candidate so the UI can ask James who's speaking
 * when no enrolled person clears the threshold.
 */

export type Candidate = {
  personId: string | null; // null = "unknown" candidate
  name: string;
  /** Cosine similarity in [-1, 1]; undefined for the unknown candidate. */
  similarity?: number;
  /** Multiplicative prior (unnormalized). */
  prior: number;
  /** Posterior probability after combining likelihood × prior. */
  posterior: number;
};

export type MatchContext = {
  /** People with at least one enrolled voice sample. */
  people: Person[];
  /** Centroid per enrolled person (computed by `centroidsFromSamples`). */
  centroidByPersonId: Map<string, Float32Array>;
  /** People associated with the current location. */
  locationPersonIds?: string[];
  /** People expected at the current event. */
  eventPersonIds?: string[];
  /** Recently-heard person IDs, newest first. */
  recentSpeakers?: string[];
  /**
   * Probability mass to reserve for "speaker is not enrolled" before
   * normalization. Higher = matcher errs toward asking James who it is.
   * 0.0 disables; 0.2 is a sensible default early on.
   */
  unknownReserve?: number;
  /** Softmax temperature for converting similarity → likelihood. */
  temperature?: number;
};

export function match(embedding: Float32Array, context: MatchContext): Candidate[] {
  const enrolled = context.people.filter((p) => context.centroidByPersonId.has(p.id));

  if (enrolled.length === 0) {
    return [{ personId: null, name: "Unknown speaker", prior: 1, posterior: 1 }];
  }

  const similarities = enrolled.map((p) =>
    cosine(embedding, context.centroidByPersonId.get(p.id)!),
  );

  // Likelihood = softmax over similarities with a sharp temperature so that
  // a clearly-better match dominates. Use temp 0.07 by default.
  const likelihoods = softmax(similarities, context.temperature ?? 0.07);

  const priors = enrolled.map((p) => computePrior(p.id, context));
  const priorSum = priors.reduce((a, b) => a + b, 0) || 1;
  const normalizedPriors = priors.map((p) => p / priorSum);

  // Unnormalized posteriors over enrolled people.
  const unnormalized = enrolled.map((_, i) => likelihoods[i] * normalizedPriors[i]);

  // Carve out a slot for the unknown candidate. Its prior is `unknownReserve`
  // and its likelihood is the average similarity-induced "leftover" mass —
  // i.e. how flat the distribution is. A flat distribution (no clear match)
  // should boost the unknown candidate.
  const unknownReserve = context.unknownReserve ?? 0.2;
  const topSim = Math.max(...similarities);
  const unknownLikelihood = 1 - clamp(topSim, 0, 1);
  const unknownUnnorm = unknownLikelihood * unknownReserve;

  const total = unnormalized.reduce((a, b) => a + b, 0) + unknownUnnorm;
  const norm = total > 0 ? total : 1;

  const candidates: Candidate[] = enrolled.map((p, i) => ({
    personId: p.id,
    name: p.name,
    similarity: similarities[i],
    prior: priors[i],
    posterior: unnormalized[i] / norm,
  }));

  candidates.push({
    personId: null,
    name: "Unknown speaker",
    prior: unknownReserve,
    posterior: unknownUnnorm / norm,
  });

  candidates.sort((a, b) => b.posterior - a.posterior);
  return candidates;
}

function computePrior(personId: string, context: MatchContext): number {
  let prior = 1;
  if (context.locationPersonIds?.includes(personId)) prior *= 2.0;
  if (context.eventPersonIds?.includes(personId)) prior *= 2.5;

  // Recency bias: decay with rank. Most-recent gets 1.6×, second 1.3×, third 1.15×.
  if (context.recentSpeakers) {
    const idx = context.recentSpeakers.indexOf(personId);
    if (idx >= 0) {
      const boost = 1 + 0.6 / Math.pow(2, idx);
      prior *= boost;
    }
  }
  return prior;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

/**
 * Compute one centroid per person from the persisted voice samples. Each
 * stored sample is already L2-normalized; the centroid is the mean of the
 * samples (NOT renormalized — we let the magnitude carry confidence info).
 */
export function centroidsFromSamples(samples: VoiceSample[]): Map<string, Float32Array> {
  const grouped = new Map<string, Float32Array[]>();
  for (const s of samples) {
    const arr = grouped.get(s.personId) ?? [];
    arr.push(decodeEmbedding(s.embedding));
    grouped.set(s.personId, arr);
  }
  const out = new Map<string, Float32Array>();
  for (const [personId, vecs] of grouped) {
    const dim = vecs[0].length;
    const centroid = new Float32Array(dim);
    for (const v of vecs) {
      if (v.length !== dim) continue;
      for (let i = 0; i < dim; i++) centroid[i] += v[i];
    }
    for (let i = 0; i < dim; i++) centroid[i] /= vecs.length;
    out.set(personId, centroid);
  }
  return out;
}
