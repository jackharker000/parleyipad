import { WorkerSpeakerEmbedder } from "./embedder-worker-client";
import { l2Normalize } from "./utils";
import Meyda from "meyda";

/**
 * Speaker embedder interface. Implementations take a mono 16kHz Float32
 * waveform and return an L2-normalized embedding vector.
 */
export interface SpeakerEmbedder {
  readonly id: string;
  readonly dim: number;
  embed(waveform16k: Float32Array): Promise<Float32Array>;
  warmup?(): Promise<void>;
  dispose?(): Promise<void>;
}

export type EmbedderConfig = {
  /** Public path to the ONNX model file. */
  modelPath?: string;
  /** HuggingFace model id, e.g. "Xenova/wavlm-base-plus-sv". */
  modelId?: string;
  /** Try WebGPU first, fall back to WASM. */
  preferWebGPU?: boolean;
  /** Expected output embedding dimension. */
  dim?: number;
};

/**
 * Neural speaker embedder using @huggingface/transformers (which runs on
 * onnxruntime-web underneath). The model is downloaded from HuggingFace on
 * first use and cached in the browser — no manual ONNX file management.
 *
 * Default model is a WavLM-based speaker-verification head that takes raw
 * 16kHz audio and returns an x-vector embedding. The model id is
 * overrideable via `EmbedderConfig.modelId`.
 */
export class TransformersSpeakerEmbedder implements SpeakerEmbedder {
  readonly id = "transformers";
  readonly dim: number;
  private modelId: string;
  private preferWebGPU: boolean;
  private extractorPromise: Promise<EmbedFn> | null = null;
  // Hold references to the underlying transformers.js model + processor so
  // dispose() can actually release the ORT session. Without these the WASM
  // heap stays pinned for the life of the tab and the iPad evicts after a
  // few minutes of continuous recording.
  private model: TransformersModel | null = null;
  private processor: TransformersProcessor | null = null;

  constructor(config: EmbedderConfig = {}) {
    this.modelId = config.modelId ?? "Xenova/wavlm-base-plus-sv";
    this.preferWebGPU = config.preferWebGPU ?? true;
    // WavLM-base+SV emits 512-dim x-vectors. Used as a hint; the actual dim
    // is whatever the model returns.
    this.dim = config.dim ?? 512;
  }

  private async getExtractor(): Promise<EmbedFn> {
    if (this.extractorPromise) return this.extractorPromise;
    this.extractorPromise = (async () => {
      const tf = await import("@huggingface/transformers");
      const { AutoModel, AutoProcessor, env } = tf;

      // iPad Safari exposes navigator.gpu but the JSEP WebGPU binding inside
      // transformers.js' bundled onnxruntime-web throws "webgpuInit is not a
      // function" — and once a WebGPU session creation has failed, the global
      // ORT state stays broken for the rest of the page. Safest path is to
      // never try WebGPU on Safari and stick to single-threaded WASM
      // everywhere. Multi-threaded WASM needs COOP/COEP headers we don't
      // set yet.
      if (env.backends.onnx.wasm) {
        env.backends.onnx.wasm.numThreads = 1;
      }
      const device = chooseDevice(this.preferWebGPU);

      const processor = (await AutoProcessor.from_pretrained(
        this.modelId,
      )) as unknown as TransformersProcessor;
      const model = (await loadModelWithDtypeFallback(
        AutoModel,
        this.modelId,
        device,
      )) as unknown as TransformersModel;

      this.processor = processor;
      this.model = model;

      return async (waveform: Float32Array) => {
        // Pass the raw Float32 array; the processor's Wav2Vec2FeatureExtractor
        // does its own mel-spectrogram step internally. Wrapping in RawAudio
        // would route through the file-loader path and reject the array.
        const inputs = await processor(waveform, { sampling_rate: 16000 });
        const outputs = await model(inputs);
        return extractEmbedding(outputs);
      };
    })();
    return this.extractorPromise;
  }

  async warmup(): Promise<void> {
    const extract = await this.getExtractor();
    // 1 s of silence — enough to validate the graph compiles and to download
    // the model. Don't care about the output.
    await extract(new Float32Array(16000));
  }

  async embed(waveform16k: Float32Array): Promise<Float32Array> {
    const extract = await this.getExtractor();
    const raw = await extract(waveform16k);
    return l2Normalize(raw);
  }

  /**
   * Actually release the ORT session. transformers.js's PreTrainedModel has
   * a dispose() that walks its internal `sessions` map and calls
   * `release()` on each onnxruntime-web InferenceSession — that's the only
   * thing that lets the ORT WASM tensors be reclaimed. Without this dispose
   * is a no-op and the WASM heap grows until Safari OOM-kills the tab.
   */
  async dispose(): Promise<void> {
    const model = this.model;
    this.model = null;
    this.processor = null;
    this.extractorPromise = null;
    if (model && typeof model.dispose === "function") {
      try {
        await model.dispose();
      } catch {
        /* ignore — best-effort release */
      }
    }
  }
}

/** Minimal structural type for the transformers.js model surface we use. */
type TransformersModel = {
  (inputs: unknown): Promise<unknown>;
  dispose?: () => Promise<void>;
};

/** Minimal structural type for the transformers.js processor. */
type TransformersProcessor = (
  waveform: Float32Array,
  opts: { sampling_rate: number },
) => Promise<unknown>;

type EmbedFn = (waveform: Float32Array) => Promise<Float32Array>;

/**
 * Try int8-quantized weights first (~2–3× faster than fp32 on WASM, smaller
 * download). If the model's HF repo doesn't ship a quantized variant, fall
 * back to fp32. Quantization is the cheapest latency win on iPad Safari
 * where WebGPU is unavailable.
 */
async function loadModelWithDtypeFallback(
  AutoModel: { from_pretrained: (id: string, opts: Record<string, unknown>) => Promise<unknown> },
  modelId: string,
  device: "webgpu" | "wasm",
): Promise<(inputs: unknown) => Promise<unknown>> {
  try {
    return (await AutoModel.from_pretrained(modelId, {
      device,
      dtype: "q8",
    })) as (inputs: unknown) => Promise<unknown>;
  } catch (err) {
    console.warn("[embedder] q8 weights unavailable, falling back to fp32:", err);
    return (await AutoModel.from_pretrained(modelId, {
      device,
      dtype: "fp32",
    })) as (inputs: unknown) => Promise<unknown>;
  }
}

/**
 * Pick a transformers.js device. WebGPU is only used when both the user has
 * opted in AND the page is NOT running in Safari (iPad or desktop) — Safari's
 * WebGPU support is too flaky for transformers.js right now and the JSEP init
 * failure corrupts the ORT state for the rest of the page.
 */
function chooseDevice(preferWebGPU: boolean): "webgpu" | "wasm" {
  if (!preferWebGPU) return "wasm";
  if (!hasWebGPU()) return "wasm";
  if (isSafari()) return "wasm";
  return "webgpu";
}

function isSafari(): boolean {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent;
  // Safari includes "Safari" but not "Chrome"/"Chromium"/"CriOS"/"FxiOS"
  return /Safari\//i.test(ua) && !/Chrome|Chromium|CriOS|FxiOS|Edg\//i.test(ua);
}

function extractEmbedding(outputs: unknown): Float32Array {
  // transformers.js models return a struct keyed by output name. Speaker
  // verification heads usually expose `embeddings`; sentence/feature
  // extractors expose `last_hidden_state` (pool over time). Cover both.
  const o = outputs as Record<string, { data?: Float32Array; dims?: number[] }>;
  if (o.embeddings?.data) {
    return new Float32Array(o.embeddings.data);
  }
  if (o.last_hidden_state?.data && o.last_hidden_state.dims) {
    return meanPool(o.last_hidden_state.data, o.last_hidden_state.dims);
  }
  // Fall back: take the first tensor in the output.
  for (const v of Object.values(o)) {
    if (v?.data && v.dims) {
      return v.dims.length >= 3 ? meanPool(v.data, v.dims) : new Float32Array(v.data);
    }
  }
  throw new Error("TransformersSpeakerEmbedder: model returned no recognizable embedding tensor");
}

function meanPool(data: Float32Array, dims: number[]): Float32Array {
  // Expecting [1, time, dim]. Mean over the time dim.
  if (dims.length !== 3) return new Float32Array(data);
  const [, time, dim] = dims;
  const out = new Float32Array(dim);
  for (let t = 0; t < time; t++) {
    const off = t * dim;
    for (let i = 0; i < dim; i++) out[i] += data[off + i];
  }
  for (let i = 0; i < dim; i++) out[i] /= Math.max(1, time);
  return out;
}

/**
 * ECAPA-TDNN embedder backed by onnxruntime-web directly. Kept as an
 * escape hatch for users who want to drop in their own ONNX file at
 * `public/models/ecapa-tdnn.onnx` (raw 16kHz audio input, fixed-dim
 * embedding output). The Transformers embedder above is the default.
 */
export class OnnxEcapaEmbedder implements SpeakerEmbedder {
  readonly id = "ecapa-tdnn-onnx";
  readonly dim: number;
  private modelPath: string;
  private preferWebGPU: boolean;
  private sessionPromise: Promise<import("onnxruntime-web").InferenceSession> | null = null;

  constructor(config: EmbedderConfig = {}) {
    this.modelPath = config.modelPath ?? "/models/ecapa-tdnn.onnx";
    this.preferWebGPU = config.preferWebGPU ?? true;
    this.dim = config.dim ?? 192;
  }

  private async getSession() {
    if (this.sessionPromise) return this.sessionPromise;
    const ort = await import("onnxruntime-web");
    const providers: string[] = [];
    if (this.preferWebGPU && hasWebGPU()) providers.push("webgpu");
    providers.push("wasm");

    this.sessionPromise = ort.InferenceSession.create(this.modelPath, {
      executionProviders: providers,
    });
    return this.sessionPromise;
  }

  async warmup(): Promise<void> {
    const session = await this.getSession();
    const silence = new Float32Array(16000);
    await this.runSession(session, silence);
  }

  async embed(waveform16k: Float32Array): Promise<Float32Array> {
    const session = await this.getSession();
    const raw = await this.runSession(session, waveform16k);
    return l2Normalize(raw);
  }

  private async runSession(
    session: import("onnxruntime-web").InferenceSession,
    waveform: Float32Array,
  ): Promise<Float32Array> {
    const ort = await import("onnxruntime-web");
    const inputName = session.inputNames[0];
    const outputName = session.outputNames[0];
    const tensor = new ort.Tensor("float32", waveform, [1, waveform.length]);
    const result = await session.run({ [inputName]: tensor });
    const output = result[outputName];
    if (!output) {
      throw new Error(`Embedder output "${outputName}" missing from session result`);
    }
    return output.data as Float32Array;
  }

  async dispose(): Promise<void> {
    if (this.sessionPromise) {
      const session = await this.sessionPromise;
      await session.release();
      this.sessionPromise = null;
    }
  }
}

/**
 * Deterministic mock embedder. Stable per audio input so the matcher and
 * UI can be exercised without any model download. Do NOT ship; speaker
 * separation quality is a fraction of the real model.
 */
export class MockSpectralEmbedder implements SpeakerEmbedder {
  readonly id = "mock-spectral";
  readonly dim = 64;

  async embed(waveform16k: Float32Array): Promise<Float32Array> {
    const out = new Float32Array(this.dim);
    const bins = this.dim;
    const fftSize = 1024;
    const hops = Math.max(1, Math.floor(waveform16k.length / fftSize));

    for (let h = 0; h < hops; h++) {
      const start = h * fftSize;
      const frame = waveform16k.subarray(start, start + fftSize);
      const spectrum = naiveSpectrum(frame, bins);
      for (let i = 0; i < bins; i++) out[i] += spectrum[i];
    }
    for (let i = 0; i < bins; i++) {
      out[i] = Math.log1p(out[i] / Math.max(1, hops));
    }
    return l2Normalize(out);
  }
}

function naiveSpectrum(frame: Float32Array, bins: number): Float32Array {
  const out = new Float32Array(bins);
  const bandSize = Math.max(1, Math.floor(frame.length / bins));
  for (let b = 0; b < bins; b++) {
    let sum = 0;
    const start = b * bandSize;
    const end = Math.min(frame.length, start + bandSize);
    for (let i = start; i < end; i++) sum += frame[i] * frame[i];
    out[b] = Math.sqrt(sum / Math.max(1, end - start));
  }
  return out;
}

function hasWebGPU(): boolean {
  return (
    typeof navigator !== "undefined" &&
    "gpu" in navigator &&
    !!(navigator as unknown as { gpu: unknown }).gpu
  );
}

/**
 * Mean-MFCC speaker embedder, restored from the legacy Lovable build.
 *
 * The WavLM-base-plus-sv embedder is more accurate on paper, but in
 * practice on James's iPad it gets stuck on the warmup screen — the
 * ~95 MB ONNX download + single-threaded WASM init either times out or
 * blows Safari's per-tab memory cap, leaving the cockpit unusable.
 * MFCC has no model download, runs ~2–5 ms per segment on the main
 * thread, and was what the legacy used end-to-end. Less discriminative,
 * but a working app beats a broken one.
 *
 * Implementation mirrors `legacy-src/lib/voiceprint.ts:computeMfccMean`:
 * iterate FRAME-sized slices, drop frames below RMS_GATE (silence /
 * breath), average the MFCC vectors across the segment, sanitise
 * NaN/Inf, then L2-normalise so the downstream cosine matcher works
 * unchanged. Dim is 13 (Meyda default + legacy `MFCC_COEFFS`).
 */
const MFCC_FRAME = 512;
const MFCC_COEFFS = 13;
const MFCC_RMS_GATE = 0.012;

export class MfccSpeakerEmbedder implements SpeakerEmbedder {
  readonly id = "mfcc-meyda";
  readonly dim = MFCC_COEFFS;
  private configured = false;

  async warmup(): Promise<void> {
    if (this.configured) return;
    // Meyda's globals are mutable; configure once. Safe to call repeatedly.
    (Meyda as unknown as { bufferSize: number }).bufferSize = MFCC_FRAME;
    (Meyda as unknown as { numberOfMFCCCoefficients: number }).numberOfMFCCCoefficients =
      MFCC_COEFFS;
    this.configured = true;
  }

  async embed(waveform16k: Float32Array): Promise<Float32Array> {
    await this.warmup();
    (Meyda as unknown as { sampleRate: number }).sampleRate = 16000;

    const sum = new Float32Array(MFCC_COEFFS);
    let frames = 0;

    for (let i = 0; i + MFCC_FRAME <= waveform16k.length; i += MFCC_FRAME) {
      const slice = waveform16k.subarray(i, i + MFCC_FRAME);
      let sumSq = 0;
      for (let j = 0; j < slice.length; j++) sumSq += slice[j] * slice[j];
      const rms = Math.sqrt(sumSq / slice.length);
      if (rms < MFCC_RMS_GATE) continue;
      let mfcc: number[] | null = null;
      try {
        mfcc = (
          Meyda as unknown as { extract: (f: string, s: Float32Array) => number[] | null }
        ).extract("mfcc", slice);
      } catch {
        continue;
      }
      if (!mfcc || mfcc.length !== MFCC_COEFFS) continue;
      for (let k = 0; k < MFCC_COEFFS; k++) sum[k] += mfcc[k];
      frames++;
    }

    if (frames < 4) {
      // Too quiet / too short — return a zero vector. The matcher's
      // single-enrollee fallback and the unknown-likelihood floor still
      // produce a sensible Unknown verdict on this case.
      return new Float32Array(MFCC_COEFFS);
    }

    for (let k = 0; k < MFCC_COEFFS; k++) {
      const v = sum[k] / frames;
      sum[k] = Number.isFinite(v) ? v : 0;
    }
    return l2Normalize(sum);
  }

  async dispose(): Promise<void> {
    // Nothing to release — Meyda has no per-instance state we own.
  }
}

export type EmbedderKind = "transformers" | "onnx-ecapa" | "mfcc" | "mock";

export function makeEmbedder(kind: EmbedderKind, config?: EmbedderConfig): SpeakerEmbedder {
  switch (kind) {
    case "transformers":
      return new TransformersSpeakerEmbedder(config);
    case "onnx-ecapa":
      return new OnnxEcapaEmbedder(config);
    case "mfcc":
      return new MfccSpeakerEmbedder();
    case "mock":
      return new MockSpectralEmbedder();
  }
}

/**
 * Construct the worker-backed transformers.js embedder. This is the
 * preferred path in the browser — it moves processor + model + ORT
 * session off the main thread so the per-12-turn embedder reset no
 * longer freezes the cockpit. Falling back to `TransformersSpeakerEmbedder`
 * is the caller's responsibility (environments without
 * `new Worker(new URL(...))` support — e.g. some test runners — should
 * call `makeEmbedder("transformers", config)` instead).
 */
export function makeWorkerEmbedder(config?: EmbedderConfig): SpeakerEmbedder {
  return new WorkerSpeakerEmbedder(config);
}
