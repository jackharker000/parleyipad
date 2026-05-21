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
  /** Try WebGPU first, fall back to WASM. */
  preferWebGPU?: boolean;
  /** Expected output embedding dimension. */
  dim?: number;
};

/**
 * ECAPA-TDNN embedder backed by onnxruntime-web. The model is expected to
 * accept raw audio at 16kHz as a [1, N] Float32 tensor named "wav" and
 * return a [1, dim] Float32 tensor named "embedding".
 *
 * If the model uses different input/output names or expects log-Mel
 * features instead of raw audio, swap them in `embed()` below. See
 * `public/models/README.md` for the expected export.
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
    const silence = new Float32Array(16000); // 1s of silence
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
 * Deterministic mock embedder. Useful for testing the matcher and the UI
 * without the ONNX model — it derives a stable pseudo-embedding from the
 * waveform's spectral shape. Same audio in, same embedding out.
 *
 * Do NOT ship this in production speaker-ID — accuracy is a fraction of
 * the real model. It exists so the spike loop works end-to-end on day one.
 */
export class MockSpectralEmbedder implements SpeakerEmbedder {
  readonly id = "mock-spectral";
  readonly dim = 64;

  async embed(waveform16k: Float32Array): Promise<Float32Array> {
    // Simple log-magnitude spectrum bucketed into `dim` bins.
    // Stable per speaker because spectral envelope tracks voice timbre,
    // but trivially fooled by background noise / shared environments.
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
  // Crude band-energy estimator: split the frame into `bins` time bands and
  // take RMS of each. Not a real FFT, but it tracks the energy envelope and
  // is plenty for distinguishing two speakers in the mock path.
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

export type EmbedderKind = "onnx-ecapa" | "mock";

export function makeEmbedder(kind: EmbedderKind, config?: EmbedderConfig): SpeakerEmbedder {
  return kind === "onnx-ecapa" ? new OnnxEcapaEmbedder(config) : new MockSpectralEmbedder();
}
