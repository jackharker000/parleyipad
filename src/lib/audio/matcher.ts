import { cosine, decodeEmbedding, softmax } from "./utils";
import type { Person, Voiceprint } from "@/lib/db";

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
  /** personId, or null for the synthetic "unknown" candidate. */
  personId: string | null;
  name: string;
  /** Cosine similarity in [-1, 1]; undefined for the unknown candidate. */
  similarity?: number;
  /** Multiplicative prior (unnormalized) — for debugging the prior shift. */
  prior: number;
  /** Posterior probability after combining likelihood × prior. */
  posterior: number;
};

export type MatchContext = {
  /** Enrolled people (Voiceprint row present). */
  people: Person[];
  /** Centroid per enrolled person, keyed by personId. */
  centroidByPersonId: Map<string, Float32Array>;
  /**
   * If set, restrict matching to this set of person ids. Used by the
   * pre-Record roster picker: declaring "Mum and Jack are in the room"
   * collapses an open-set match against everyone James has ever enrolled
   * down to a closed-set decision between 2–4 people. This is the
   * single biggest speaker-ID accuracy win — bigger than any model
   * upgrade.
   */
  closedSet?: string[];
  /** People associated with the current place. */
  placePersonIds?: string[];
  /** People expected at the current event. */
  eventPersonIds?: string[];
  /** Recently-heard person IDs, newest first. */
  recentSpeakers?: string[];
  /**
   * Probability mass to reserve for "speaker is not enrolled" before
   * normalization. Higher = matcher errs toward asking James who it is.
   * 0.2 is a sensible default early on.
   */
  unknownReserve?: number;
  /** Softmax temperature for converting similarity → likelihood. */
  temperature?: number;
};

/**
 * Cosine-similarity threshold for the single-enrollee fallback. WavLM
 * x-vectors on in-room iPad audio typically settle in the 0.55–0.70 range
 * for genuine matches; 0.60 is conservative. TODO: validate empirically
 * once James has 3+ samples enrolled — record both match and non-match
 * segments and pick the value that minimises false accepts.
 */
const SINGLE_ENROLL_THRESHOLD = 0.6;

/**
 * Floor on the unknown candidate's likelihood. Without this, a weak top
 * similarity (say 0.95 → unknown-likelihood = 0.05) combined with a strong
 * prior on an enrolled person produces a near-certain confirmed match even
 * when the voice is clearly not theirs. 0.10 leaves enough mass for "this
 * is somebody new" to surface in the candidates list. A principled
 * calibration is a Tier-2 task.
 */
const UNKNOWN_LIKELIHOOD_FLOOR = 0.1;

export function match(embedding: Float32Array, context: MatchContext): Candidate[] {
  const closedSet = context.closedSet;
  const closedSetFilter = closedSet && closedSet.length > 0 ? new Set(closedSet) : null;

  const enrolled = context.people.filter(
    (p) =>
      context.centroidByPersonId.has(p.id) &&
      (closedSetFilter === null || closedSetFilter.has(p.id)),
  );

  if (enrolled.length === 0) {
    return [{ personId: null, name: "Unknown speaker", prior: 1, posterior: 1 }];
  }

  // Single-enrollee fallback: softmax over a single value always returns 1.0,
  // so the matcher would post a confirmed match on every utterance regardless
  // of how dissimilar the voice actually is. Bypass softmax and use a
  // calibrated cosine threshold instead.
  if (enrolled.length === 1) {
    const person = enrolled[0];
    const sim = cosine(embedding, context.centroidByPersonId.get(person.id)!);
    // Cosine ranges [-1, 1]; a negative value (or >1 from fp drift) would
    // make `posterior` negative or `1 - posterior` exceed 1, so the pair no
    // longer reads as a probability for any downstream confidence display.
    // Clamp before using sim as a posterior.
    const p = clamp(sim, 0, 1);
    const matched: Candidate = {
      personId: person.id,
      name: person.name,
      similarity: sim,
      prior: 1,
      posterior: p,
    };
    const unknown: Candidate = {
      personId: null,
      name: "Unknown speaker",
      prior: 1,
      posterior: 1 - p,
    };
    return sim >= SINGLE_ENROLL_THRESHOLD ? [matched, unknown] : [unknown, matched];
  }

  const similarities = enrolled.map((p) =>
    cosine(embedding, context.centroidByPersonId.get(p.id)!),
  );

  // Likelihood = softmax over similarities with a sharp temperature so that
  // a clearly-better match dominates. 0.07 is a reasonable starting point;
  // tune once we have real WavLM numbers from the spike.
  const likelihoods = softmax(similarities, context.temperature ?? 0.07);

  const priors = enrolled.map((p) => computePrior(p.id, context));
  const priorSum = priors.reduce((a, b) => a + b, 0) || 1;
  const normalizedPriors = priors.map((p) => p / priorSum);

  const unnormalized = enrolled.map((_, i) => likelihoods[i] * normalizedPriors[i]);

  // Carve out a slot for the unknown candidate. Floor the likelihood so a
  // strong prior on an enrolled person can't fully suppress "this is
  // somebody new" when the actual similarity is weak.
  const unknownReserve = context.unknownReserve ?? 0.2;
  const topSim = Math.max(...similarities);
  const unknownLikelihood = Math.max(UNKNOWN_LIKELIHOOD_FLOOR, 1 - clamp(topSim, 0, 1));
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
  if (context.placePersonIds?.includes(personId)) prior *= 2.0;
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
 * Build the matcher's centroid map straight from the Voiceprint rows.
 * Constant-time lookup at match time; the running mean lives in `enrollment.ts`.
 */
export function centroidsFromVoiceprints(voiceprints: Voiceprint[]): Map<string, Float32Array> {
  const out = new Map<string, Float32Array>();
  for (const vp of voiceprints) {
    out.set(vp.personId, decodeEmbedding(vp.centroid));
  }
  return out;
}
