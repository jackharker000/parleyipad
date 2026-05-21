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
