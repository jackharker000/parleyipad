/// <reference lib="webworker" />

/**
 * Web Worker host for the transformers.js speaker embedder.
 *
 * Why a worker: warming and disposing the WavLM ORT session blocks the
 * thread it runs on for 5–10 s. Running this on the main thread freezes
 * the cockpit every 12th turn while `LiveConversation.resetEmbedder()`
 * cycles the embedder. Moving processor + model + ORT session in here
 * keeps the UI responsive during those resets and during cold-start
 * warmup.
 *
 * What this does NOT fix: Safari tab eviction at 2 min in the background.
 * Workers live inside the same browsing context and get evicted with it.
 * The durable-degradation contract handles that case separately (cached
 * quick-phrase audio, type-and-speak, last-segment replay).
 *
 * Protocol (one request → one reply, keyed by monotonic id):
 *   request:  { id, type: 'warmup' | 'embed' | 'dispose', waveform? }
 *   reply ok: { id, ok: true, result?: Float32Array }
 *   reply err:{ id, ok: false, error: string }
 *
 * The reply uses Transferable Float32Array so the embedding buffer is
 * moved, not copied, back to the main thread.
 */

import { l2Normalize } from "./utils";

export type EmbedderWorkerConfig = {
  modelId?: string;
  preferWebGPU?: boolean;
};

export type EmbedderWorkerRequest =
  | { id: number; type: "warmup"; config?: EmbedderWorkerConfig }
  | { id: number; type: "embed"; waveform: Float32Array; config?: EmbedderWorkerConfig }
  | { id: number; type: "dispose" };

export type EmbedderWorkerReply =
  | { id: number; ok: true; result?: Float32Array }
  | { id: number; ok: false; error: string };

type TransformersModel = {
  (inputs: unknown): Promise<unknown>;
  dispose?: () => Promise<void>;
};

type TransformersProcessor = (
  waveform: Float32Array,
  opts: { sampling_rate: number },
) => Promise<unknown>;

type EmbedFn = (waveform: Float32Array) => Promise<Float32Array>;

// Module-scope so the model survives between message dispatches. There is
// only ever one embedder per worker.
let modelId = "Xenova/wavlm-base-plus-sv";
let preferWebGPU = true;
let extractorPromise: Promise<EmbedFn> | null = null;
let model: TransformersModel | null = null;
let processor: TransformersProcessor | null = null;

function applyConfig(config: EmbedderWorkerConfig | undefined): void {
  if (!config) return;
  if (config.modelId && config.modelId !== modelId) {
    modelId = config.modelId;
    // Different model id ⇒ invalidate any in-flight extractor so the next
    // call rebuilds with the new id. Callers shouldn't switch models on a
    // warm embedder but we guard for it anyway.
    extractorPromise = null;
    model = null;
    processor = null;
  }
  if (typeof config.preferWebGPU === "boolean") {
    preferWebGPU = config.preferWebGPU;
  }
}

async function getExtractor(): Promise<EmbedFn> {
  if (extractorPromise) return extractorPromise;
  extractorPromise = (async () => {
    const tf = await import("@huggingface/transformers");
    const { AutoModel, AutoProcessor, env } = tf;

    // Same WASM thread guard as the main-thread implementation. Workers
    // do have access to navigator.gpu in some browsers but we still avoid
    // WebGPU on Safari for the same JSEP-init breakage that bricks the
    // global ORT state inside transformers.js.
    if (env.backends.onnx.wasm) {
      env.backends.onnx.wasm.numThreads = 1;
    }
    const device = chooseDevice(preferWebGPU);

    const proc = (await AutoProcessor.from_pretrained(modelId)) as unknown as TransformersProcessor;
    const mdl = (await loadModelWithDtypeFallback(
      AutoModel,
      modelId,
      device,
    )) as unknown as TransformersModel;

    processor = proc;
    model = mdl;

    return async (waveform: Float32Array) => {
      const inputs = await proc(waveform, { sampling_rate: 16000 });
      const outputs = await mdl(inputs);
      return extractEmbedding(outputs);
    };
  })();
  return extractorPromise;
}

async function warmup(): Promise<void> {
  const extract = await getExtractor();
  await extract(new Float32Array(16000));
}

async function embed(waveform: Float32Array): Promise<Float32Array> {
  const extract = await getExtractor();
  const raw = await extract(waveform);
  return l2Normalize(raw);
}

/**
 * Best-effort in-place release. The reliable cleanup path is for the
 * client to terminate the worker entirely (worker.terminate()), which is
 * how the WASM heap actually gets reclaimed on iPad Safari. This method
 * exists for completeness so a single embedder instance can be reused if
 * a caller chooses to.
 */
async function dispose(): Promise<void> {
  const previousModel = model;
  model = null;
  processor = null;
  extractorPromise = null;
  if (previousModel && typeof previousModel.dispose === "function") {
    try {
      await previousModel.dispose();
    } catch {
      /* best-effort release */
    }
  }
}

const ctx = self as unknown as DedicatedWorkerGlobalScope;

ctx.addEventListener("message", (event: MessageEvent<EmbedderWorkerRequest>) => {
  const req = event.data;
  void handle(req);
});

async function handle(req: EmbedderWorkerRequest): Promise<void> {
  try {
    switch (req.type) {
      case "warmup": {
        applyConfig(req.config);
        await warmup();
        reply({ id: req.id, ok: true });
        return;
      }
      case "embed": {
        applyConfig(req.config);
        const embedding = await embed(req.waveform);
        reply({ id: req.id, ok: true, result: embedding }, [embedding.buffer]);
        return;
      }
      case "dispose": {
        await dispose();
        reply({ id: req.id, ok: true });
        return;
      }
    }
  } catch (err) {
    reply({
      id: req.id,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

function reply(message: EmbedderWorkerReply, transfer?: Transferable[]): void {
  // The DedicatedWorkerGlobalScope postMessage overloads accept a transfer
  // list as the second positional arg.
  ctx.postMessage(message, transfer ?? []);
}

async function loadModelWithDtypeFallback(
  AutoModel: { from_pretrained: (id: string, opts: Record<string, unknown>) => Promise<unknown> },
  id: string,
  device: "webgpu" | "wasm",
): Promise<(inputs: unknown) => Promise<unknown>> {
  try {
    return (await AutoModel.from_pretrained(id, {
      device,
      dtype: "q8",
    })) as (inputs: unknown) => Promise<unknown>;
  } catch (err) {
    console.warn("[embedder-worker] q8 weights unavailable, falling back to fp32:", err);
    return (await AutoModel.from_pretrained(id, {
      device,
      dtype: "fp32",
    })) as (inputs: unknown) => Promise<unknown>;
  }
}

function chooseDevice(prefer: boolean): "webgpu" | "wasm" {
  if (!prefer) return "wasm";
  if (!hasWebGPU()) return "wasm";
  if (isSafari()) return "wasm";
  return "webgpu";
}

function isSafari(): boolean {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent;
  return /Safari\//i.test(ua) && !/Chrome|Chromium|CriOS|FxiOS|Edg\//i.test(ua);
}

function hasWebGPU(): boolean {
  return (
    typeof navigator !== "undefined" &&
    "gpu" in navigator &&
    !!(navigator as unknown as { gpu: unknown }).gpu
  );
}

function extractEmbedding(outputs: unknown): Float32Array {
  const o = outputs as Record<string, { data?: Float32Array; dims?: number[] }>;
  if (o.embeddings?.data) {
    return new Float32Array(o.embeddings.data);
  }
  if (o.last_hidden_state?.data && o.last_hidden_state.dims) {
    return meanPool(o.last_hidden_state.data, o.last_hidden_state.dims);
  }
  for (const v of Object.values(o)) {
    if (v?.data && v.dims) {
      return v.dims.length >= 3 ? meanPool(v.data, v.dims) : new Float32Array(v.data);
    }
  }
  throw new Error("embedder-worker: model returned no recognizable embedding tensor");
}

function meanPool(data: Float32Array, dims: number[]): Float32Array {
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
