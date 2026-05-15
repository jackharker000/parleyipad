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

const FRAME = 512;
const RMS_GATE = 0.012; // skip near-silent frames

// Meyda is configured globally; set defaults once.
(Meyda as any).bufferSize = FRAME;
(Meyda as any).numberOfMFCCCoefficients = MFCC_COEFFS;

export class VoiceCapture {
  private ctx: AudioContext | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private processor: ScriptProcessorNode | null = null;
  private stream: MediaStream | null = null;
  /** Mono PCM samples captured since start(). */
  private buffer: Float32Array[] = [];
  private bufferLen = 0;
  startTimeMs = 0;
  sampleRate = 16000;
  private maxSamples = 0;

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
    // ScriptProcessorNode is deprecated but works on iOS Safari & is reliable.
    this.processor = ctx.createScriptProcessor(4096, 1, 1);
    this.startTimeMs = Date.now();
    this.processor.onaudioprocess = (e) => {
      const input = e.inputBuffer.getChannelData(0);
      // copy — input buffer is reused
      const copy = new Float32Array(input.length);
      copy.set(input);
      this.buffer.push(copy);
      this.bufferLen += copy.length;
      // Trim oldest chunks if over cap
      while (this.bufferLen > this.maxSamples && this.buffer.length > 1) {
        const dropped = this.buffer.shift()!;
        this.bufferLen -= dropped.length;
        this.startTimeMs += (dropped.length / this.sampleRate) * 1000;
      }
    };
    this.source.connect(this.processor);
    // Required for ScriptProcessor to fire; route through gain at zero so we don't echo.
    const sink = ctx.createGain();
    sink.gain.value = 0;
    this.processor.connect(sink);
    sink.connect(ctx.destination);
    // iOS Safari (and Chrome under autoplay policies) starts the AudioContext
    // in "suspended" state. Without resuming, ScriptProcessor.onaudioprocess
    // never fires, the buffer stays empty, and no voiceprints are ever
    // captured. This is the #1 reason fingerprints don't appear.
    if (ctx.state === "suspended") {
      try {
        await ctx.resume();
      } catch (e) {
        console.warn("[voiceprint] AudioContext.resume failed", e);
      }
    }
    console.debug("[voiceprint] capture ready", {
      sampleRate: this.sampleRate,
      ctxState: ctx.state,
    });
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

  stop() {
    try {
      this.processor?.disconnect();
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
    this.processor = null;
    this.stream = null;
    this.buffer = [];
    this.bufferLen = 0;
  }
}

/** Compute mean MFCC vector across a PCM signal. Returns null if too quiet/short. */
export function computeMfccMean(
  signal: Float32Array,
  sampleRate: number,
): number[] | null {
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
  return sum.map((v) => v / frames);
}

export function cosineSim(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;
  let dot = 0,
    na = 0,
    nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
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
  const merged = mergeIntoCentroid(
    existing?.centroid,
    existing?.sample_count ?? 0,
    vector,
  );
  const vp: Voiceprint = {
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

/** Find best matching person from a candidate set, or null. */
export function bestMatch(
  vector: number[],
  prints: Voiceprint[],
  threshold = 0.86,
  excludedPersonIds?: ReadonlySet<string>,
): { print: Voiceprint; sim: number } | null {
  let best: { print: Voiceprint; sim: number } | null = null;
  for (const p of prints) {
    if (p.centroid.length !== vector.length) continue;
    if (excludedPersonIds?.has(p.person_id)) continue;
    const sim = cosineSim(vector, p.centroid);
    if (!best || sim > best.sim) best = { print: p, sim };
  }
  if (best && best.sim >= threshold) return best;
  return null;
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
  // mergeThreshold is the baseline; actual threshold per cluster adapts to its spread.
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
      const sim = cosineSim(mfcc, cluster.centroid);
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
    this.mergeUtterance(label, mfcc);
    return { label, sim: bestSim, isNew };
  }

  /** Preview which cluster an MFCC would be assigned to, without mutating state. */
  peek(mfcc: number[]): { label: string | null; sim: number; wouldMerge: boolean } {
    let bestLabel: string | null = null;
    let bestSim = -1;
    for (const [label, cluster] of this.clustersMap.entries()) {
      const sim = cosineSim(mfcc, cluster.centroid);
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
   *  - With <3 samples we use the conservative baseline (0.82 by default) —
   *    spread isn't meaningful yet, so don't relax.
   *  - With ≥3 samples we relax for tight clusters and tighten for broad ones,
   *    but always stay within [0.78, 0.88]. */
  private thresholdFor(label: string): number {
    const c = this.clustersMap.get(label);
    if (!c || c.count < 3) return this.mergeThreshold;
    const adjusted = this.mergeThreshold + (c.spread - 0.08) * 0.6;
    return Math.min(0.88, Math.max(0.78, adjusted));
  }

  private mergeUtterance(label: string, mfcc: number[]) {
    const prev = this.clustersMap.get(label);
    const merged = mergeIntoCentroid(prev?.centroid, prev?.count ?? 0, mfcc);
    const simToCentroid = prev ? cosineSim(mfcc, prev.centroid) : 1.0;
    const prevCount = prev?.count ?? 0;
    const newSpread = prevCount > 0
      ? ((prev!.spread * prevCount) + (1 - simToCentroid)) / (prevCount + 1)
      : 0;
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
    const merged = to.centroid.map((v, i) =>
      (v * to.count + from.centroid[i] * from.count) / totalCount,
    );
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
