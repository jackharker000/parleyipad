/**
 * Captures mono float32 audio at the AudioContext sample rate and posts
 * raw frames back to the main thread. Resampling/concat happens on the
 * main thread in `capture.ts` — keeping the worklet dumb makes it easier
 * to swap for MediaStreamTrackProcessor later if we want zero-copy.
 *
 * Loaded via `new URL("./worklets/capture-processor.ts", import.meta.url)`
 * so Vite bundles it as a standalone ES module the AudioWorklet can fetch.
 *
 * AudioWorklet globals are declared inline because TypeScript's default
 * libs don't include them and we don't want to drag in @types/audioworklet
 * just for this one file.
 */

declare const registerProcessor: (
  name: string,
  processor: new () => {
    process(
      inputs: Float32Array[][],
      outputs: Float32Array[][],
      params: Record<string, Float32Array>,
    ): boolean;
  },
) => void;

declare class AudioWorkletProcessor {
  readonly port: MessagePort;
  constructor();
}

class ParleyCaptureProcessor extends AudioWorkletProcessor {
  process(inputs: Float32Array[][]): boolean {
    const channel = inputs[0]?.[0];
    if (channel && channel.length > 0) {
      // postMessage copies the buffer; we deliberately don't transfer it
      // because the input array is reused by the audio thread for the next
      // render quantum.
      this.port.postMessage(channel.slice());
    }
    return true;
  }
}

registerProcessor("parley-capture", ParleyCaptureProcessor);
