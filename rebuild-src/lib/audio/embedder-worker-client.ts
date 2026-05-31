import type { EmbedderConfig, SpeakerEmbedder } from "./embedder";
import type {
  EmbedderWorkerConfig,
  EmbedderWorkerReply,
  EmbedderWorkerRequest,
} from "./embedder-worker";

/**
 * Main-thread proxy for the transformers.js embedder running inside
 * embedder-worker.ts. Implements the same `SpeakerEmbedder` interface as
 * `TransformersSpeakerEmbedder` so callers can swap implementations
 * without code changes.
 *
 * Dispose strategy: TERMINATE the worker and lazily recreate a fresh one
 * on the next call. transformers.js's PreTrainedModel.dispose() only
 * releases the JS-side references — onnxruntime-web's WASM heap is
 * reclaimed by the worker's own teardown, which only fully runs when the
 * worker is terminated. On iPad Safari this is the only reliable path
 * to free the ORT tensors before they grow large enough to OOM-kill the
 * tab. Recreating the worker is cheap (~10–50 ms); the model itself
 * downloads from the browser cache on warmup.
 */
export class WorkerSpeakerEmbedder implements SpeakerEmbedder {
  readonly id = "transformers-worker";
  readonly dim: number;

  private worker: Worker | null = null;
  private nextId = 1;
  private pending = new Map<
    number,
    { resolve: (reply: EmbedderWorkerReply) => void; reject: (err: Error) => void }
  >();
  private readonly workerConfig: EmbedderWorkerConfig;

  constructor(config: EmbedderConfig = {}) {
    this.dim = config.dim ?? 512;
    this.workerConfig = {
      modelId: config.modelId,
      preferWebGPU: config.preferWebGPU,
    };
  }

  async warmup(): Promise<void> {
    const worker = this.ensureWorker();
    await this.send(worker, { id: this.nextId++, type: "warmup", config: this.workerConfig });
  }

  async embed(waveform16k: Float32Array): Promise<Float32Array> {
    const worker = this.ensureWorker();
    // Copy the input into a fresh ArrayBuffer so the transfer doesn't
    // detach a buffer the caller still owns (e.g. a slice of the VAD
    // ring buffer). The cost is ~0.5–1 ms per turn; the freedom from
    // caller-side ownership bugs is worth it.
    const transferable = new Float32Array(waveform16k);
    const reply = await this.send(
      worker,
      { id: this.nextId++, type: "embed", waveform: transferable, config: this.workerConfig },
      [transferable.buffer],
    );
    if (!reply.ok) throw new Error(reply.error);
    if (!reply.result) throw new Error("embedder-worker: missing result");
    return reply.result;
  }

  /**
   * Terminate the worker. The next call to embed/warmup will spin up a
   * fresh one — this is how the ORT WASM heap is actually reclaimed on
   * iPad Safari. Trading ~10–50 ms of worker-spawn time for a guaranteed
   * heap release is the entire reason this class exists.
   *
   * Any in-flight request is rejected; callers expecting that should
   * await embed() before dispose().
   */
  async dispose(): Promise<void> {
    this.terminate("disposed");
  }

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;
    const worker = new Worker(new URL("./embedder-worker.ts", import.meta.url), {
      type: "module",
    });
    worker.addEventListener("message", (event: MessageEvent<EmbedderWorkerReply>) => {
      const reply = event.data;
      const slot = this.pending.get(reply.id);
      if (!slot) return;
      this.pending.delete(reply.id);
      slot.resolve(reply);
    });
    worker.addEventListener("error", (event) => {
      // A fatal worker error invalidates all in-flight calls. Reject
      // them, drop the worker reference, and let the next call recreate.
      const message = event.message || "worker crashed";
      this.terminate(message);
    });
    worker.addEventListener("messageerror", () => {
      this.terminate("worker messageerror");
    });
    this.worker = worker;
    return worker;
  }

  private send(
    worker: Worker,
    request: EmbedderWorkerRequest,
    transfer?: Transferable[],
  ): Promise<EmbedderWorkerReply> {
    return new Promise((resolve, reject) => {
      this.pending.set(request.id, { resolve, reject });
      try {
        worker.postMessage(request, transfer ?? []);
      } catch (err) {
        this.pending.delete(request.id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  private terminate(reason: string): void {
    const worker = this.worker;
    this.worker = null;
    if (worker) {
      try {
        worker.terminate();
      } catch {
        /* ignore */
      }
    }
    if (this.pending.size > 0) {
      const err = new Error(`embedder worker terminated: ${reason}`);
      for (const slot of this.pending.values()) {
        slot.reject(err);
      }
      this.pending.clear();
    }
  }
}
