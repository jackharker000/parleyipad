/**
 * Silero VAD via @ricky0123/vad-web.
 *
 * The library bundles its own AudioWorklet + Silero ONNX. Assets are served
 * from the `vad/` public path — copy them with the postinstall step
 * documented in `public/models/README.md`. This wrapper hides the lazy
 * import so the package doesn't ship to SSR.
 */

import type { MicVAD as MicVADType, RealTimeVADOptions } from "@ricky0123/vad-web";

export type SegmentListener = (segment: VADSegment) => void;

export type VADSegment = {
  /** Mono float32 audio at 16 kHz from speech start to speech end. */
  audio: Float32Array;
  /** Elapsed time at speech end, ms since the VAD started. */
  endedAtMs: number;
  /** Segment duration in ms. */
  durationMs: number;
};

export class SileroVAD {
  private vad: MicVADType | null = null;
  private startedAt = 0;
  private listeners = new Set<SegmentListener>();
  private speechListeners = new Set<() => void>();
  private misfireListeners = new Set<() => void>();

  async start(options?: Partial<RealTimeVADOptions>): Promise<void> {
    if (this.vad) return;
    const { MicVAD } = await import("@ricky0123/vad-web");
    this.vad = await MicVAD.new({
      // Serve the worklet bundle, Silero ONNX, and ORT WASM glue from our
      // own origin — copied into public/ by scripts/copy-vad-assets.mjs.
      // The defaults load from cdn.jsdelivr.net which iPad Safari refuses
      // (cross-origin module load).
      baseAssetPath: "/",
      onnxWASMBasePath: "/",
      // Pin single-threaded WASM. Multi-threaded ORT needs COOP/COEP headers
      // we don't set, and there's no benefit on iPad Safari which lacks
      // SharedArrayBuffer in standard mode anyway.
      ortConfig: (ort) => {
        if (ort.env.wasm) ort.env.wasm.numThreads = 1;
      },
      // Silero defaults are too aggressive: short minSpeech and a small
      // redemption window mean we hand Scribe sub-1-s clips with onsets
      // clipped — which it transcribes as half-words and surrounds with
      // (laughs)/(pauses)/etc. WavLM also degrades fast on <1 s clips.
      // The legacy model uses 96-ms frames so these ms values correspond to:
      //   minSpeechMs: 1440  → 15 frames, ~1.4 s of committed speech
      //   redemptionMs: 960  → 10 frames, ~960 ms silence before ending
      //   preSpeechPadMs: 768 → 8 frames, ~768 ms of pre-pad
      // Target segments: 1.5–8 s for a healthy turn. Validate empirically on
      // James's iPad mic; these are starting values, not load-bearing.
      minSpeechMs: 1440,
      redemptionMs: 960,
      preSpeechPadMs: 768,
      onSpeechStart: () => {
        for (const fn of this.speechListeners) fn();
      },
      onSpeechEnd: (audio) => {
        const ended = performance.now() - this.startedAt;
        const segment: VADSegment = {
          audio,
          endedAtMs: ended,
          durationMs: (audio.length / 16000) * 1000,
        };
        for (const fn of this.listeners) fn(segment);
      },
      onVADMisfire: () => {
        for (const fn of this.misfireListeners) fn();
      },
      ...options,
    });
    this.startedAt = performance.now();
    this.vad.start();
  }

  onSpeechStart(fn: () => void): () => void {
    this.speechListeners.add(fn);
    return () => this.speechListeners.delete(fn);
  }

  onSegment(fn: SegmentListener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  onMisfire(fn: () => void): () => void {
    this.misfireListeners.add(fn);
    return () => this.misfireListeners.delete(fn);
  }

  pause(): void {
    this.vad?.pause();
  }

  resume(): void {
    this.vad?.start();
  }

  async destroy(): Promise<void> {
    this.vad?.destroy();
    this.vad = null;
    this.listeners.clear();
    this.speechListeners.clear();
    this.misfireListeners.clear();
  }
}
