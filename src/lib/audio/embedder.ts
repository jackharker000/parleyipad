import { l2Normalize } from "./utils";

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
      const { AutoModel, AutoProcessor } = await import("@huggingface/transformers");
      const device = this.preferWebGPU && hasWebGPU() ? "webgpu" : "wasm";

      const [processor, model] = await Promise.all([
        AutoProcessor.from_pretrained(this.modelId),
        AutoModel.from_pretrained(this.modelId, {
          device,
          dtype: "fp32",
        }),
      ]);

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

  async dispose(): Promise<void> {
    this.extractorPromise = null;
  }
}

type EmbedFn = (waveform: Float32Array) => Promise<Float32Array>;

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

export type EmbedderKind = "transformers" | "onnx-ecapa" | "mock";

export function makeEmbedder(kind: EmbedderKind, config?: EmbedderConfig): SpeakerEmbedder {
  switch (kind) {
    case "transformers":
      return new TransformersSpeakerEmbedder(config);
    case "onnx-ecapa":
      return new OnnxEcapaEmbedder(config);
    case "mock":
      return new MockSpectralEmbedder();
  }
}
