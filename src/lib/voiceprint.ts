/**
 * On-device voice fingerprinting using MFCC features (via Meyda).
 *
 * Captures microphone audio in parallel with ElevenLabs Scribe, slices PCM
 * around each committed transcript segment, computes a mean MFCC vector,
 * and stores per-person centroids in IndexedDB so that familiar voices
 * (Mum, carers, friends) can be auto-recognised across sessions.
 *
 * Free, private, runs entirely in the browser. Best for distinguishing a
 * small set of known speakers in reasonably quiet conditions.
 */
import Meyda from "meyda";
import { db, MFCC_COEFFS, type Voiceprint } from "./db";
export type { Voiceprint };

const FRAME = 512;

/** Only update a cluster's running centroid when the utterance MFCC is at
 *  least this similar to the existing centroid. Keeps outlier utterances from
 *  drifting the centroid away from a confirmed speaker's true voice. */
export const CENTROID_UPDATE_THRESHOLD = 0.76;
const RMS_GATE = 0.012; // skip near-silent frames

/**
 * AudioWorklet processor source for off-main-thread mic capture. It just
 * forwards each render quantum's mono samples to the main thread; all MFCC
 * work still happens on demand in `recentSlice`/`computeMfccMean`, but the
 * raw PCM copy now runs on the audio thread instead of jankeing the UI the way
 * the deprecated ScriptProcessorNode did.
 *
 * Delivered via a blob: URL rather than `new URL(..., import.meta.url)` —
 * the latter trips Safari's AudioWorklet CORS check on bundler-built assets
 * ("Cross-origin script load denied"), even same-origin. Blob URLs are always
 * same-origin, so this loads identically in dev and in the production build.
 */
const CAPTURE_PROCESSOR_SOURCE = `
class ParleyVoiceCaptureProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (channel && channel.length > 0) {
      // Slice (copy) — the input buffer is reused by the audio thread for the
      // next render quantum, so posting it without copying would corrupt it.
      this.port.postMessage(channel.slice());
    }
    return true;
  }
}
registerProcessor("parley-voice-capture", ParleyVoiceCaptureProcessor);
`;

let captureProcessorUrl: string | null = null;
function getCaptureProcessorUrl(): string {
  if (captureProcessorUrl) return captureProcessorUrl;
  const blob = new Blob([CAPTURE_PROCESSOR_SOURCE], {
    type: "application/javascript",
  });
  captureProcessorUrl = URL.createObjectURL(blob);
  return captureProcessorUrl;
}

// Meyda is configured globally; set defaults once.
(Meyda as any).bufferSize = FRAME;
(Meyda as any).numberOfMFCCCoefficients = MFCC_COEFFS;

export class VoiceCapture {
  private ctx: AudioContext | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  /** AudioWorkletNode (preferred) or ScriptProcessorNode (fallback). Both feed
   *  the same PCM ring buffer; the rest of the class is node-agnostic. */
  private worklet: AudioWorkletNode | null = null;
  private processor: ScriptProcessorNode | null = null;
  /** A muted GainNode keeps the graph pulling without echoing the mic. */
  private sink: GainNode | null = null;
  /** Which capture path actually started — for debug/telemetry. */
  captureMode: "worklet" | "scriptprocessor" | null = null;
  private stream: MediaStream | null = null;
  /** Mono PCM samples captured since start(). */
  private buffer: Float32Array[] = [];
  private bufferLen = 0;
  startTimeMs = 0;
  sampleRate = 16000;
  private maxSamples = 0;
  private shiftTimer: ReturnType<typeof setInterval> | null = null;
  private shiftPrevMfcc: number[] | null = null;
  /** Fires shortly after start() to catch an AudioWorklet that attached but
   *  never delivered frames (iOS Safari can starve a muted-sink worklet). */
  private watchdogTimer: ReturnType<typeof setTimeout> | null = null;

  /** Periodically computes MFCC on the last ~500ms of audio. When the
   *  cosine similarity to the previous window drops below `threshold`,
   *  fires `onShift(Date.now())` — a likely speaker change point. Used
   *  to split Scribe commits that span multiple speakers without a pause. */
  startShiftMonitor(
    onShift: (timestampMs: number) => void,
    options: { intervalMs?: number; windowSec?: number; threshold?: number } = {},
  ) {
    const intervalMs = options.intervalMs ?? 200;
    const windowSec = options.windowSec ?? 0.5;
    const threshold = options.threshold ?? 0.68;
    this.stopShiftMonitor();
    this.shiftPrevMfcc = null;
    this.shiftTimer = setInterval(() => {
      if (!this.ctx || this.bufferLen < this.sampleRate * windowSec) return;
      try {
        const pcm = this.recentSlice(windowSec, 0);
        const mfcc = computeMfccMean(pcm, this.sampleRate);
        if (!mfcc) return;
        if (this.shiftPrevMfcc) {
          const sim = cosineSim(mfcc, this.shiftPrevMfcc);
          if (sim < threshold) {
            try { onShift(Date.now()); } catch {}
          }
        }
        this.shiftPrevMfcc = mfcc;
      } catch {}
    }, intervalMs);
  }

  stopShiftMonitor() {
    if (this.shiftTimer) {
      clearInterval(this.shiftTimer);
      this.shiftTimer = null;
    }
    this.shiftPrevMfcc = null;
  }

  async start() {
    if (this.ctx) return;
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        channelCount: 1,
      },
    });
    this.stream = stream;
    // Try 16 kHz; iOS Safari may ignore and use device default — that's fine.
    const Ctor: typeof AudioContext =
      (window as any).AudioContext ?? (window as any).webkitAudioContext;
    let ctx: AudioContext;
    try {
      ctx = new Ctor({ sampleRate: 16000 } as any);
    } catch {
      ctx = new Ctor();
    }
    this.ctx = ctx;
    this.sampleRate = ctx.sampleRate;
    this.maxSamples = this.sampleRate * 60 * 5; // keep last 5 minutes
    this.source = ctx.createMediaStreamSource(stream);
    this.startTimeMs = Date.now();

    // iOS Safari (and Chrome under autoplay policies) starts the AudioContext
    // in "suspended" state. Without resuming, neither the worklet nor a
    // ScriptProcessor fires, the buffer stays empty, and no voiceprints are
    // ever captured. This is the #1 reason fingerprints don't appear. Resume
    // BEFORE attaching nodes so the first frames aren't dropped.
    if (ctx.state === "suspended") {
      try {
        await ctx.resume();
      } catch (e) {
        console.warn("[voiceprint] AudioContext.resume failed", e);
      }
    }

    // Prefer an AudioWorklet (off the main thread → no UI jank). Fall back to
    // the deprecated-but-reliable ScriptProcessorNode if the worklet can't be
    // loaded (older Safari, blocked module, etc.).
    let usedWorklet = false;
    if (ctx.audioWorklet) {
      try {
        await ctx.audioWorklet.addModule(getCaptureProcessorUrl());
        const node = new AudioWorkletNode(ctx, "parley-voice-capture", {
          numberOfInputs: 1,
          numberOfOutputs: 1,
          channelCount: 1,
        });
        node.port.onmessage = (e) => this.pushFrame(e.data as Float32Array);
        // If the processor throws on the audio thread, fall back at once.
        node.onprocessorerror = () => {
          console.warn(
            "[voiceprint] AudioWorklet processor error — falling back to ScriptProcessor",
          );
          this.fallbackToScriptProcessor();
        };
        this.source.connect(node);
        // Some browsers stop scheduling a node that isn't routed to the
        // destination; route through a muted gain so we pull frames without
        // echoing the mic back through the speakers.
        const sink = ctx.createGain();
        sink.gain.value = 0;
        node.connect(sink);
        sink.connect(ctx.destination);
        this.worklet = node;
        this.sink = sink;
        this.captureMode = "worklet";
        usedWorklet = true;
      } catch (err) {
        console.warn("[voiceprint] AudioWorklet unavailable, falling back to ScriptProcessor", err);
        this.worklet = null;
      }
    }

    if (!usedWorklet) {
      this.attachScriptProcessor();
    } else {
      // Watchdog: some iOS Safari builds attach a worklet cleanly but never
      // deliver input frames (a node routed only into a muted sink can be
      // starved). Speaker-ID is the #1 priority, so if no audio has arrived
      // shortly after start, switch to the historically-reliable
      // ScriptProcessor rather than silently capturing nothing.
      this.watchdogTimer = setTimeout(() => {
        this.watchdogTimer = null;
        if (this.captureMode === "worklet" && !this.hasAudio) {
          console.warn(
            "[voiceprint] AudioWorklet produced no audio in 1.2s — falling back to ScriptProcessor",
          );
          this.fallbackToScriptProcessor();
        }
      }, 1200);
    }

    if (import.meta.env.DEV) console.debug("[voiceprint] capture ready", {
      sampleRate: this.sampleRate,
      ctxState: ctx.state,
      captureMode: this.captureMode,
    });
  }

  /** Attach a ScriptProcessorNode capture path — deprecated but reliable on
   *  iOS Safari. Used as the initial fallback and by `fallbackToScriptProcessor`. */
  private attachScriptProcessor() {
    const ctx = this.ctx;
    const source = this.source;
    if (!ctx || !source) return;
    const processor = ctx.createScriptProcessor(4096, 1, 1);
    processor.onaudioprocess = (e) => {
      this.pushFrame(e.inputBuffer.getChannelData(0));
    };
    source.connect(processor);
    // Required for ScriptProcessor to fire; route through gain at zero so we
    // don't echo.
    const sink = ctx.createGain();
    sink.gain.value = 0;
    processor.connect(sink);
    sink.connect(ctx.destination);
    this.processor = processor;
    this.sink = sink;
    this.captureMode = "scriptprocessor";
  }

  /** Idempotently tear down a starved/erroring worklet and switch to the
   *  ScriptProcessor path. Safe to call from the watchdog or onprocessorerror. */
  private fallbackToScriptProcessor() {
    if (this.captureMode === "scriptprocessor") return;
    if (this.watchdogTimer) {
      clearTimeout(this.watchdogTimer);
      this.watchdogTimer = null;
    }
    try {
      if (this.worklet) this.worklet.port.onmessage = null;
      this.worklet?.disconnect();
    } catch {}
    this.worklet = null;
    try {
      this.sink?.disconnect();
    } catch {}
    this.sink = null;
    this.attachScriptProcessor();
  }

  /** Append one render quantum of mono PCM to the rolling buffer and trim to
   *  the 5-minute cap. Shared by the worklet and ScriptProcessor paths. The
   *  worklet already hands us a fresh copy; the ScriptProcessor reuses its
   *  input buffer, so we always copy here to be safe. */
  private pushFrame(input: Float32Array) {
    const copy = new Float32Array(input.length);
    copy.set(input);
    this.buffer.push(copy);
    this.bufferLen += copy.length;
    while (this.bufferLen > this.maxSamples && this.buffer.length > 1) {
      const dropped = this.buffer.shift()!;
      this.bufferLen -= dropped.length;
      this.startTimeMs += (dropped.length / this.sampleRate) * 1000;
    }
  }

  /** True if the capture has accumulated any audio samples. */
  get hasAudio(): boolean {
    return this.bufferLen > 0;
  }

  /** Concatenated mono PCM of everything currently buffered. */
  private concat(): Float32Array {
    const out = new Float32Array(this.bufferLen);
    let offset = 0;
    for (const chunk of this.buffer) {
      out.set(chunk, offset);
      offset += chunk.length;
    }
    return out;
  }

  /** Slice the most recent `durationSec` seconds (with small leading pad). */
  recentSlice(durationSec: number, padSec = 0.25): Float32Array {
    const total = this.concat();
    const want = Math.floor((durationSec + padSec) * this.sampleRate);
    if (total.length <= want) return total;
    return total.subarray(total.length - want);
  }

  /**
   * Tier 3.3 — coarse prosody summary over the last `durationSec` of audio.
   * Returns mean RMS, RMS variance and mean spectral centroid across frames
   * loud enough to be voiced. Returns `null` when there isn't enough audio
   * yet. Used to give the mood predictor a hint about how the conversation
   * partner sounds (energetic, flat, agitated, ...).
   */
  recentProsody(
    durationSec: number,
  ): { meanRms: number; rmsVariance: number; spectralCentroid: number; frames: number } | null {
    if (this.bufferLen < this.sampleRate * 0.5) return null;
    const pcm = this.recentSlice(durationSec, 0);
    if (pcm.length < FRAME * 4) return null;
    (Meyda as any).sampleRate = this.sampleRate;

    const rmsValues: number[] = [];
    const centroidValues: number[] = [];
    for (let i = 0; i + FRAME <= pcm.length; i += FRAME) {
      const slice = pcm.subarray(i, i + FRAME);
      let sumSq = 0;
      for (let j = 0; j < slice.length; j++) sumSq += slice[j] * slice[j];
      const rms = Math.sqrt(sumSq / slice.length);
      if (rms < RMS_GATE) continue;
      rmsValues.push(rms);
      try {
        const feats = (Meyda as any).extract(["spectralCentroid"], slice) as {
          spectralCentroid?: number;
        } | null;
        if (feats && typeof feats.spectralCentroid === "number") {
          centroidValues.push(feats.spectralCentroid);
        }
      } catch {
        // Meyda can throw on edge buffers — skip and continue.
      }
    }
    if (rmsValues.length < 4) return null;
    const meanRms = rmsValues.reduce((a, b) => a + b, 0) / rmsValues.length;
    const rmsVariance =
      rmsValues.reduce((sum, v) => sum + (v - meanRms) ** 2, 0) / rmsValues.length;
    const spectralCentroid = centroidValues.length
      ? centroidValues.reduce((a, b) => a + b, 0) / centroidValues.length
      : 0;
    return {
      meanRms,
      rmsVariance,
      spectralCentroid,
      frames: rmsValues.length,
    };
  }

  stop() {
    this.stopShiftMonitor();
    if (this.watchdogTimer) {
      clearTimeout(this.watchdogTimer);
      this.watchdogTimer = null;
    }
    try {
      if (this.worklet) this.worklet.port.onmessage = null;
    } catch {}
    try {
      this.worklet?.disconnect();
    } catch {}
    try {
      this.processor?.disconnect();
    } catch {}
    try {
      this.sink?.disconnect();
    } catch {}
    try {
      this.source?.disconnect();
    } catch {}
    try {
      this.stream?.getTracks().forEach((t) => t.stop());
    } catch {}
    try {
      this.ctx?.close();
    } catch {}
    this.ctx = null;
    this.source = null;
    this.worklet = null;
    this.processor = null;
    this.sink = null;
    this.captureMode = null;
    this.stream = null;
    this.buffer = [];
    this.bufferLen = 0;
  }
}

/** Compute mean MFCC vector across a PCM signal. Returns null if too quiet/short. */
export function computeMfccMean(signal: Float32Array, sampleRate: number): number[] | null {
  if (signal.length < FRAME * 4) return null;
  (Meyda as any).sampleRate = sampleRate;
  const sum = new Array(MFCC_COEFFS).fill(0);
  let frames = 0;
  for (let i = 0; i + FRAME <= signal.length; i += FRAME) {
    const slice = signal.subarray(i, i + FRAME);
    let sumSq = 0;
    for (let j = 0; j < slice.length; j++) sumSq += slice[j] * slice[j];
    const rms = Math.sqrt(sumSq / slice.length);
    if (rms < RMS_GATE) continue;
    let mfcc: number[] | null = null;
    try {
      mfcc = (Meyda as any).extract("mfcc", slice) as number[] | null;
    } catch {
      return null;
    }
    if (!mfcc || mfcc.length !== MFCC_COEFFS) continue;
    for (let k = 0; k < MFCC_COEFFS; k++) sum[k] += mfcc[k];
    frames++;
  }
  if (frames < 4) return null;
  // Sanitize: replace any NaN/Infinity with 0 so downstream cosine similarity
  // never produces NaN from a divide-by-zero on a degenerate frame.
  return sum.map((v) => {
    const val = v / frames;
    return Number.isFinite(val) ? val : 0;
  });
}

export function cosineSim(a: number[], b: number[]): number {
  if (a.length !== b.length) return NaN;
  let dot = 0,
    na = 0,
    nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return NaN;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** Speaker-discriminative cosine similarity — excludes MFCC coefficient 0.
 *
 *  Coefficient 0 reflects energy/loudness and is dominated by mic distance,
 *  room gain, and AGC — all shared when two speakers use the same iPad. On a
 *  shared device, including c0 pushes inter-speaker cosine similarity to
 *  0.88–0.96, well above any practical merge threshold and collapsing all
 *  speakers into one cluster. Dropping c0 reduces inter-speaker similarity to
 *  the expected 0.55–0.80 range while keeping intra-speaker similarity at
 *  0.85–0.97, restoring clean speaker separation. */
export function discriminativeSim(a: number[], b: number[]): number {
  if (a.length < 2 || b.length < 2 || a.length !== b.length) return NaN;
  return cosineSim(a.slice(1), b.slice(1));
}

/** Merge a new MFCC observation into an existing centroid (running mean). */
export function mergeIntoCentroid(
  prev: number[] | undefined,
  prevCount: number,
  next: number[],
  nextWeight = 1,
): { centroid: number[]; count: number } {
  if (!prev || prevCount === 0) {
    return { centroid: next.slice(), count: nextWeight };
  }
  // Dimension mismatch — start fresh rather than producing a garbled centroid.
  if (prev.length !== next.length) {
    return { centroid: next.slice(), count: nextWeight };
  }
  const total = prevCount + nextWeight;
  const out = new Array(prev.length);
  for (let i = 0; i < prev.length; i++) {
    out[i] = (prev[i] * prevCount + next[i] * nextWeight) / total;
  }
  return { centroid: out, count: total };
}

/** Persist (or update) the voiceprint for a person. */
export async function recordVoiceprint(personId: string, vector: number[]) {
  const existing = await db.voiceprints.get(personId);
  const merged = mergeIntoCentroid(existing?.centroid, existing?.sample_count ?? 0, vector);
  const vp: Voiceprint = {
    // Preserve the offline-rebuild enrichment (sub_centroids / confidence /
    // last_rebuilt_at). Without the spread, every live "Confirm speaker" or
    // reassignment silently wiped the multi-modal voice profile and cohesion
    // score, degrading future speaker-ID — the opposite of learning.
    ...existing,
    id: personId,
    person_id: personId,
    centroid: merged.centroid,
    sample_count: merged.count,
    updated_at: Date.now(),
  };
  await db.voiceprints.put(vp);
  return vp;
}

export async function deleteVoiceprint(personId: string) {
  await db.voiceprints.delete(personId);
}

/** Add a voiceprint contribution, capping stored entries at `maxPerPerson`.
 *
 *  FIFO: when the cap is exceeded the oldest entries (by `ts`) are removed
 *  first. This prevents centroid drift from accumulating too many samples that
 *  average out to a generic voice profile and start matching everyone. */
export async function addContributionWithCap(
  contribution: import("@/lib/db").VoiceprintContribution,
  maxPerPerson = 3,
): Promise<void> {
  const existing = await db.voiceprint_contributions
    .where("person_id")
    .equals(contribution.person_id)
    .sortBy("ts");
  const toDelete = existing.length >= maxPerPerson
    ? existing.slice(0, existing.length - maxPerPerson + 1).map((c) => c.id)
    : [];
  if (toDelete.length > 0) {
    await db.voiceprint_contributions.bulkDelete(toDelete);
  }
  await db.voiceprint_contributions.add(contribution);
}

/** Find best matching person from a candidate set, or null.
 *
 *  When a Voiceprint has `sub_centroids` (multi-modal voice — e.g. calm vs
 *  animated, in-person vs phone), the effective similarity to that person is
 *  the maximum across its centroid and every sub-centroid. */
export function bestMatch(
  vector: number[],
  prints: Voiceprint[],
  threshold = 0.86,
  excludedPersonIds?: ReadonlySet<string>,
): { print: Voiceprint; sim: number } | null {
  let best: { print: Voiceprint; sim: number } | null = null;
  for (const p of prints) {
    if (excludedPersonIds?.has(p.person_id)) continue;
    const sim = printSimilarity(vector, p);
    if (sim === null) continue;
    if (!best || sim > best.sim) best = { print: p, sim };
  }
  if (best && best.sim >= threshold) return best;
  return null;
}

/** Effective discriminative cosine similarity between `vector` and a stored
 *  voiceprint, taking the max over its centroid and any sub-centroids. Returns
 *  null when the print can't be compared (dimension mismatch / degenerate). */
function printSimilarity(vector: number[], p: Voiceprint): number | null {
  if (p.centroid.length !== vector.length) return null;
  // Use discriminativeSim (drops c0) to match the same metric used for
  // in-session clustering — prevents stored voiceprints from over-matching
  // due to shared-mic energy characteristics.
  let sim = discriminativeSim(vector, p.centroid);
  if (!Number.isFinite(sim)) return null;
  if (p.sub_centroids?.length) {
    for (const sub of p.sub_centroids) {
      if (sub.centroid.length !== vector.length) continue;
      const subSim = discriminativeSim(vector, sub.centroid);
      if (Number.isFinite(subSim) && subSim > sim) sim = subSim;
    }
  }
  return sim;
}

/** Numerically-stable softmax over a list of scores at a given temperature. */
function softmax(scores: number[], temperature: number): number[] {
  if (scores.length === 0) return [];
  const t = temperature > 0 ? temperature : 1;
  const scaled = scores.map((s) => s / t);
  const max = Math.max(...scaled);
  const exps = scaled.map((s) => Math.exp(s - max));
  const sum = exps.reduce((a, b) => a + b, 0) || 1;
  return exps.map((e) => e / sum);
}

/** Conservative context-prior multipliers. Match the PR #5 plan's feel: a
 *  modest place tilt, a stronger event tilt, and a small (halved) recency
 *  boost. These only re-rank candidates; they never manufacture a match the
 *  voice doesn't already support (the cosine `threshold` gate still applies). */
export const PRIOR_PLACE_BOOST = 1.5;
export const PRIOR_EVENT_BOOST = 2.0;
export const PRIOR_RECENCY_BASE = 0.3;
/** Probability mass reserved for "speaker is not enrolled" before normalising.
 *  Keeps a genuine stranger from being force-matched onto an expected person. */
export const PRIOR_UNKNOWN_RESERVE = 0.2;
/** Floor on the unknown candidate's likelihood so a strong prior can't fully
 *  suppress "this is somebody new" when the actual similarity is weak. */
const PRIOR_UNKNOWN_LIKELIHOOD_FLOOR = 0.1;
/** Softmax temperature for similarity → likelihood. 0.1 keeps a clearly-better
 *  match dominant while leaving borderline cases visibly uncertain. */
const PRIOR_SOFTMAX_TEMPERATURE = 0.1;

export type PriorContext = {
  /** Skip these people entirely (already-confirmed speakers). */
  excludedPersonIds?: ReadonlySet<string>;
  /** People associated with the active place. */
  placePersonIds?: readonly string[];
  /** People expected at the active event. */
  eventPersonIds?: readonly string[];
  /** Recently-heard person IDs, newest first. */
  recentSpeakers?: readonly string[];
};

/**
 * Bayesian-ish context-prior speaker match.
 *
 *   posterior(person | voice, context) ∝ likelihood(voice | person) × prior(person | context)
 *
 * Likelihood is a sharp-temperature softmax over the candidates' discriminative
 * cosine similarities. The prior multiplies in place/event/recency boosts, and
 * an explicit "unknown speaker" candidate always retains some mass so a genuine
 * stranger isn't force-matched onto an expected person.
 *
 * Contract matches {@link bestMatch}: returns the winning enrolled person with
 * its raw cosine `sim` when (a) it tops the posterior including the unknown slot
 * AND (b) its cosine clears `threshold`; otherwise null. With no place/event/
 * recency context the priors are uniform, so the posterior order equals the
 * similarity order and the gate is the same cosine `threshold` — i.e. this
 * degrades exactly to today's pure-cosine `bestMatch`.
 *
 * Never throws: any unexpected failure falls back to a plain `bestMatch`.
 */
export function bestMatchWithPrior(
  vector: number[],
  prints: Voiceprint[],
  threshold = 0.86,
  ctx: PriorContext = {},
): { print: Voiceprint; sim: number } | null {
  try {
    const candidates: Array<{ print: Voiceprint; sim: number }> = [];
    for (const p of prints) {
      if (ctx.excludedPersonIds?.has(p.person_id)) continue;
      const sim = printSimilarity(vector, p);
      if (sim === null) continue;
      candidates.push({ print: p, sim });
    }
    if (candidates.length === 0) return null;

    // No context signal → identical ranking + gate to pure-cosine bestMatch.
    const hasPriorSignal =
      (ctx.placePersonIds && ctx.placePersonIds.length > 0) ||
      (ctx.eventPersonIds && ctx.eventPersonIds.length > 0) ||
      (ctx.recentSpeakers && ctx.recentSpeakers.length > 0);
    if (!hasPriorSignal) {
      let best = candidates[0];
      for (const c of candidates) if (c.sim > best.sim) best = c;
      return best.sim >= threshold ? best : null;
    }

    const sims = candidates.map((c) => c.sim);
    const likelihoods = softmax(sims, PRIOR_SOFTMAX_TEMPERATURE);

    const rawPriors = candidates.map((c) => computePrior(c.print.person_id, ctx));
    const priorSum = rawPriors.reduce((a, b) => a + b, 0) || 1;
    const normPriors = rawPriors.map((p) => p / priorSum);

    const unnorm = candidates.map((_, i) => likelihoods[i] * normPriors[i]);

    // Reserve mass for an unenrolled speaker, floored so a strong prior can't
    // bury it when the actual voice match is weak.
    const topSim = Math.max(...sims);
    const unknownLikelihood = Math.max(
      PRIOR_UNKNOWN_LIKELIHOOD_FLOOR,
      1 - Math.max(0, Math.min(1, topSim)),
    );
    const unknownUnnorm = unknownLikelihood * PRIOR_UNKNOWN_RESERVE;

    const total = unnorm.reduce((a, b) => a + b, 0) + unknownUnnorm;
    const norm = total > 0 ? total : 1;
    const unknownPosterior = unknownUnnorm / norm;

    let bestIdx = -1;
    let bestPosterior = -1;
    for (let i = 0; i < candidates.length; i++) {
      const posterior = unnorm[i] / norm;
      if (posterior > bestPosterior) {
        bestPosterior = posterior;
        bestIdx = i;
      }
    }

    if (bestIdx < 0) return null;
    // The unknown slot winning means the prior wasn't enough to pick anyone —
    // surface "no confident match" rather than force the top enrolled person.
    if (bestPosterior < unknownPosterior) return null;

    const winner = candidates[bestIdx];
    // Voice gate: never report a match the raw similarity doesn't support.
    if (winner.sim < threshold) return null;
    return winner;
  } catch {
    // Any failure → safe fall back to the unbiased matcher. Speaker-ID must
    // never throw into the live loop.
    return bestMatch(vector, prints, threshold, ctx.excludedPersonIds);
  }
}

/** Multiplicative prior for one person from the active context. */
function computePrior(personId: string, ctx: PriorContext): number {
  let prior = 1;
  if (ctx.placePersonIds?.includes(personId)) prior *= PRIOR_PLACE_BOOST;
  if (ctx.eventPersonIds?.includes(personId)) prior *= PRIOR_EVENT_BOOST;
  if (ctx.recentSpeakers) {
    const idx = ctx.recentSpeakers.indexOf(personId);
    if (idx >= 0) prior *= 1 + PRIOR_RECENCY_BASE / Math.pow(2, idx);
  }
  return prior;
}

/* --------------------- Offline (post-conversation) rebuild ---------------- */

export type RebuildOutcome = {
  personId: string;
  newCentroid: number[];
  newSampleCount: number;
  subCentroids: Array<{ label: string; centroid: number[]; count: number }>;
  confidence: number;
  /** True when the new centroid drifted significantly from the existing one;
   *  we ABORT the write to avoid corrupting the print. */
  changedSignificantly: boolean;
  /** True when no rewrite happened (skipped or aborted). */
  aborted: boolean;
};

const MIN_CONTRIBUTIONS_TO_REBUILD = 2;
const MIN_CONTRIBUTIONS_TO_SPLIT = 8;
const SAFETY_GUARD_THRESHOLD = 0.7;
const SUB_CENTROID_SPLIT_GAIN = 0.05;

/**
 * Recompute a person's stored voiceprint from the durable contribution log.
 * Optionally splits into a primary/secondary sub-centroid when 2-means
 * detects meaningfully tighter modes than a single mean.
 *
 * Safety guard: if the new mean centroid drifted below cosine sim 0.7 vs
 * the current stored centroid we abort — this typically means we've absorbed
 * mislabelled contributions and overwriting would make things worse.
 */
export async function rebuildVoiceprintFromContributions(
  personId: string,
): Promise<RebuildOutcome> {
  const contributions = await db.voiceprint_contributions
    .where("person_id")
    .equals(personId)
    .toArray();
  const valid = contributions.filter((c) => Array.isArray(c.mfcc) && c.mfcc.length === MFCC_COEFFS);
  const existing = await db.voiceprints.get(personId);

  const aborted = (): RebuildOutcome => ({
    personId,
    newCentroid: existing?.centroid ?? [],
    newSampleCount: existing?.sample_count ?? 0,
    subCentroids: existing?.sub_centroids ?? [],
    confidence: existing?.confidence ?? 0,
    changedSignificantly: false,
    aborted: true,
  });

  if (valid.length < MIN_CONTRIBUTIONS_TO_REBUILD) {
    return aborted();
  }

  // Compute new centroid as mean of all MFCCs.
  const dim = MFCC_COEFFS;
  const sum = new Array(dim).fill(0);
  for (const c of valid) {
    for (let i = 0; i < dim; i++) sum[i] += c.mfcc[i];
  }
  const newCentroid = sum.map((v) => v / valid.length);

  // Intra-cluster mean cosine sim → confidence (floor 0.5, ceiling 1.0).
  let totalSim = 0;
  for (const c of valid) totalSim += cosineSim(c.mfcc, newCentroid);
  const rawConfidence = totalSim / valid.length;
  const confidence = Math.max(0.5, Math.min(1, rawConfidence));

  // Safety guard: if new centroid drifts too far from the existing one we
  // refuse to overwrite. Rebuilds should refine, not flip, a known print.
  if (existing && existing.centroid.length === dim) {
    const driftSim = cosineSim(existing.centroid, newCentroid);
    if (driftSim < SAFETY_GUARD_THRESHOLD) {
      console.warn(
        `[voiceprint] rebuild aborted for ${personId}: new centroid drifted to cosine ${driftSim.toFixed(
          3,
        )} (< ${SAFETY_GUARD_THRESHOLD}).`,
      );
      return {
        ...aborted(),
        newCentroid,
        confidence,
        changedSignificantly: true,
      };
    }
  }

  // 2-means split (cosine k-means, k=2, 5 iterations) — only when we have
  // enough contributions to draw a meaningful conclusion.
  const subCentroids: Array<{
    label: string;
    centroid: number[];
    count: number;
  }> = [];
  if (valid.length >= MIN_CONTRIBUTIONS_TO_SPLIT) {
    // Farthest-pair init: take the first sample and the one most distant from it.
    const a = valid[0].mfcc.slice();
    let bIdx = 0;
    let worstSim = 1;
    for (let i = 1; i < valid.length; i++) {
      const s = cosineSim(a, valid[i].mfcc);
      if (s < worstSim) {
        worstSim = s;
        bIdx = i;
      }
    }
    let c0 = a;
    let c1 = valid[bIdx].mfcc.slice();
    const assign = new Array<number>(valid.length).fill(0);
    for (let iter = 0; iter < 5; iter++) {
      for (let i = 0; i < valid.length; i++) {
        const s0 = cosineSim(valid[i].mfcc, c0);
        const s1 = cosineSim(valid[i].mfcc, c1);
        assign[i] = s0 >= s1 ? 0 : 1;
      }
      const sum0 = new Array(dim).fill(0);
      const sum1 = new Array(dim).fill(0);
      let n0 = 0;
      let n1 = 0;
      for (let i = 0; i < valid.length; i++) {
        if (assign[i] === 0) {
          for (let j = 0; j < dim; j++) sum0[j] += valid[i].mfcc[j];
          n0++;
        } else {
          for (let j = 0; j < dim; j++) sum1[j] += valid[i].mfcc[j];
          n1++;
        }
      }
      if (n0 > 0) c0 = sum0.map((v) => v / n0);
      if (n1 > 0) c1 = sum1.map((v) => v / n1);
    }
    let n0 = 0,
      n1 = 0;
    let intra0 = 0,
      intra1 = 0;
    for (let i = 0; i < valid.length; i++) {
      if (assign[i] === 0) {
        intra0 += cosineSim(valid[i].mfcc, c0);
        n0++;
      } else {
        intra1 += cosineSim(valid[i].mfcc, c1);
        n1++;
      }
    }
    const mean0 = n0 > 0 ? intra0 / n0 : 0;
    const mean1 = n1 > 0 ? intra1 / n1 : 0;
    const overall = rawConfidence;
    const primaryIsZero = n0 >= n1;
    const primaryMean = primaryIsZero ? mean0 : mean1;
    const primaryCentroid = primaryIsZero ? c0 : c1;
    const primaryCount = primaryIsZero ? n0 : n1;
    const secondaryMean = primaryIsZero ? mean1 : mean0;
    const secondaryCentroid = primaryIsZero ? c1 : c0;
    const secondaryCount = primaryIsZero ? n1 : n0;
    if (
      primaryMean - overall >= SUB_CENTROID_SPLIT_GAIN &&
      secondaryCount > 0 &&
      secondaryMean > 0
    ) {
      subCentroids.push({
        label: "primary",
        centroid: primaryCentroid,
        count: primaryCount,
      });
      subCentroids.push({
        label: "secondary",
        centroid: secondaryCentroid,
        count: secondaryCount,
      });
    } else {
      subCentroids.push({
        label: "primary",
        centroid: newCentroid,
        count: valid.length,
      });
    }
  } else {
    subCentroids.push({
      label: "primary",
      centroid: newCentroid,
      count: valid.length,
    });
  }

  const updated: Voiceprint = {
    id: personId,
    person_id: personId,
    centroid: newCentroid,
    sample_count: valid.length,
    updated_at: Date.now(),
    sub_centroids: subCentroids,
    confidence,
    last_rebuilt_at: Date.now(),
  };
  await db.voiceprints.put(updated);

  // Propagate the cohesion score to the Person record so it's queryable.
  try {
    const person = await db.people.get(personId);
    if (person) {
      await db.people.update(personId, { voiceprint_confidence: confidence });
    }
  } catch {
    // Person row may have been deleted concurrently; centroid update still useful.
  }

  return {
    personId,
    newCentroid,
    newSampleCount: valid.length,
    subCentroids,
    confidence,
    changedSignificantly: false,
    aborted: false,
  };
}

/**
 * Tiny on-device diarizer.
 *
 * Owns the live MFCC clusters for the current session. For each new utterance
 * the caller computes a mean MFCC vector and asks `assign(mfcc)`; the diarizer
 * either merges it into the nearest existing cluster (cosine sim ≥
 * `mergeThreshold`) or opens a fresh "Speaker N" cluster. There is exactly one
 * source of truth for "who's talking now" — no Scribe-vs-MFCC tie-breaking.
 */
export type Cluster = { label: string; centroid: number[]; count: number };

type ClusterEntry = { centroid: number[]; count: number; spread: number };

export class Diarizer {
  private clustersMap = new Map<string, ClusterEntry>();
  private counter = 0;
  private _forceNewOnNext = false;
  // Similarity is computed with discriminativeSim (MFCC[1..], no energy coeff).
  // With c0 removed, same-speaker sim is ~0.85–0.97, different-speaker is ~0.55–0.80.
  // 0.82 sits cleanly between those ranges — merges the same speaker across
  // mic distances/emotions while reliably splitting different speakers.
  constructor(public mergeThreshold = 0.82) {}

  reset() {
    this.clustersMap.clear();
    this.counter = 0;
  }

  /** Assign an MFCC mean to a cluster (existing or new). Returns the label. */
  assign(mfcc: number[]): { label: string; sim: number; isNew: boolean } {
    if (this._forceNewOnNext) {
      this._forceNewOnNext = false;
      return this.assignNew(mfcc);
    }
    let bestLabel: string | null = null;
    let bestSim = -1;
    for (const [label, cluster] of this.clustersMap.entries()) {
      const sim = discriminativeSim(mfcc, cluster.centroid);
      if (!Number.isFinite(sim)) continue;
      if (sim > bestSim) {
        bestSim = sim;
        bestLabel = label;
      }
    }
    let label: string;
    let isNew = false;
    if (bestLabel) {
      const threshold = this.thresholdFor(bestLabel);
      if (bestSim >= threshold) {
        label = bestLabel;
      } else {
        this.counter += 1;
        label = `Speaker ${this.counter}`;
        isNew = true;
      }
    } else {
      this.counter += 1;
      label = `Speaker ${this.counter}`;
      isNew = true;
    }
    if (isNew) {
      this.clustersMap.set(label, { centroid: mfcc.slice(), count: 1, spread: 0 });
    } else {
      const cluster = this.clustersMap.get(label);
      if (cluster) {
        const preMergeSim = discriminativeSim(mfcc, cluster.centroid);
        if (Number.isFinite(preMergeSim) && preMergeSim >= CENTROID_UPDATE_THRESHOLD) {
          this.mergeUtterance(label, mfcc);
        }
      }
    }
    return { label, sim: bestSim, isNew };
  }

  /** Preview which cluster an MFCC would be assigned to, without mutating state. */
  peek(mfcc: number[]): { label: string | null; sim: number; wouldMerge: boolean } {
    let bestLabel: string | null = null;
    let bestSim = -1;
    for (const [label, cluster] of this.clustersMap.entries()) {
      const sim = discriminativeSim(mfcc, cluster.centroid);
      if (!Number.isFinite(sim)) continue;
      if (sim > bestSim) {
        bestSim = sim;
        bestLabel = label;
      }
    }
    if (!bestLabel) return { label: null, sim: -1, wouldMerge: false };
    const threshold = this.thresholdFor(bestLabel);
    return { label: bestLabel, sim: bestSim, wouldMerge: bestSim >= threshold };
  }

  /** Force-create a new cluster seeded by this MFCC. Use when textual evidence
   *  (e.g. self-introduction) strongly suggests a different speaker even if
   *  the MFCC superficially resembles an existing cluster. */
  assignNew(mfcc: number[]): { label: string; sim: number; isNew: true } {
    this.counter += 1;
    const label = `Speaker ${this.counter}`;
    this.clustersMap.set(label, { centroid: mfcc.slice(), count: 1, spread: 0 });
    return { label, sim: 1, isNew: true };
  }

  /** Compute the adaptive merge threshold for a given cluster.
   *  - With <3 samples we use the conservative baseline (0.87 by default) —
   *    spread isn't meaningful yet, so don't relax.
   *  - With ≥3 samples we relax for tight clusters and tighten for broad ones,
   *    but always stay within [0.83, 0.93]. */
  private thresholdFor(label: string): number {
    const c = this.clustersMap.get(label);
    if (!c || c.count < 3) return this.mergeThreshold;
    const adjusted = this.mergeThreshold + (c.spread - 0.08) * 0.6;
    return Math.min(0.90, Math.max(0.78, adjusted));
  }

  /** Force-assign an MFCC to a specific cluster label. If the cluster doesn't
   *  exist, create it seeded with this MFCC. Otherwise update its centroid
   *  with the new sample (subject to the centroid update guard).
   *
   *  Use this when external evidence (e.g. a participant's stored voiceprint)
   *  determines the cluster identity more reliably than in-session MFCC
   *  similarity. Returns the resolved label and the cluster's prior similarity
   *  for caller bookkeeping. */
  forceAssign(label: string, mfcc: number[]): { label: string; sim: number; isNew: boolean } {
    const existing = this.clustersMap.get(label);
    if (!existing) {
      this.clustersMap.set(label, { centroid: mfcc.slice(), count: 1, spread: 0 });
      return { label, sim: 1, isNew: true };
    }
    const preMergeSim = discriminativeSim(mfcc, existing.centroid);
    if (Number.isFinite(preMergeSim) && preMergeSim >= CENTROID_UPDATE_THRESHOLD) {
      this.mergeUtterance(label, mfcc);
    }
    return { label, sim: preMergeSim, isNew: false };
  }

  private mergeUtterance(label: string, mfcc: number[]) {
    const prev = this.clustersMap.get(label);
    const merged = mergeIntoCentroid(prev?.centroid, prev?.count ?? 0, mfcc);
    const simToCentroid = prev ? discriminativeSim(mfcc, prev.centroid) : 1.0;
    const prevCount = prev?.count ?? 0;
    const rawSpread = prevCount > 0
      ? ((prev!.spread * prevCount) + (1 - (Number.isFinite(simToCentroid) ? simToCentroid : 0))) / (prevCount + 1)
      : 0;
    // Clamp spread to [0, 0.15] to prevent threshold blow-out when a single
    // noisy utterance produces an anomalously low similarity to the centroid.
    // Without the clamp, spread can reach 0.4+ which pushes thresholdFor() to
    // its 0.93 max, making subsequent utterances from the same speaker always
    // create new clusters.
    const newSpread = Math.min(0.15, Math.max(0, rawSpread));
    this.clustersMap.set(label, { centroid: merged.centroid, count: merged.count, spread: newSpread });
  }

  /** Mark that the next `assign()` call should create a new cluster
   *  regardless of cosine similarity (e.g. James signals a new speaker
   *  is about to talk). */
  forceNextNew() {
    this._forceNewOnNext = true;
  }

  /** Merge cluster `fromLabel` into `toLabel` (weighted centroid blend).
   *  Returns false if either label doesn't exist. After merging, all
   *  utterances previously labelled `fromLabel` should be relabelled
   *  `toLabel` by the caller. */
  mergeClusters(fromLabel: string, toLabel: string): boolean {
    const from = this.clustersMap.get(fromLabel);
    const to = this.clustersMap.get(toLabel);
    if (!from || !to) return false;
    const totalCount = from.count + to.count;
    // Dimension mismatch: keep the 'to' centroid unchanged rather than
    // producing a garbled vector.
    const merged = from.centroid.length === to.centroid.length
      ? to.centroid.map((v, i) => (v * to.count + from.centroid[i] * from.count) / totalCount)
      : to.centroid.slice();
    const newSpread =
      (to.spread * to.count + from.spread * from.count) / totalCount;
    this.clustersMap.set(toLabel, {
      centroid: merged,
      count: totalCount,
      spread: newSpread,
    });
    this.clustersMap.delete(fromLabel);
    return true;
  }

  /** Snapshot of all live clusters. */
  clusters(): Cluster[] {
    return [...this.clustersMap.entries()].map(([label, c]) => ({
      label,
      centroid: c.centroid,
      count: c.count,
    }));
  }

  get(label: string): Cluster | undefined {
    const c = this.clustersMap.get(label);
    return c ? { label, centroid: c.centroid, count: c.count } : undefined;
  }
}
