/**
 * Direct mic capture for enrollment (fixed-length sample, no VAD).
 * AudioWorklet-based — ScriptProcessorNode is deprecated and stutters under
 * load, which is exactly the worst case for the enrollment UX.
 *
 * Live conversation capture goes through `SileroVAD` instead — the VAD
 * library wraps its own worklet, so we don't run both at once.
 *
 * Sample-rate handling: we request 16 kHz, but iPad Safari often hands
 * back 44.1/48 kHz regardless. We always resample to 16 kHz on stop().
 *
 * Worklet delivery: the processor source is embedded as a string and
 * loaded via a blob: URL. The previous `new URL("./worklets/...", import.meta.url)`
 * approach trips Safari's AudioWorklet CORS check on Vercel-built assets
 * ("Cross-origin script load denied by Cross-Origin Resource Sharing policy"),
 * even though the file is same-origin. Blob URLs are always same-origin.
 */

const TARGET_RATE = 16000;

const CAPTURE_PROCESSOR_SOURCE = `
class ParleyCaptureProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (channel && channel.length > 0) {
      // Slice (copy) — the input buffer is reused by the audio thread for
      // the next render quantum, so transferring would invalidate it.
      this.port.postMessage(channel.slice());
    }
    return true;
  }
}
registerProcessor("parley-capture", ParleyCaptureProcessor);
`;

let captureProcessorUrl: string | null = null;
function getCaptureProcessorUrl(): string {
  if (captureProcessorUrl) return captureProcessorUrl;
  const blob = new Blob([CAPTURE_PROCESSOR_SOURCE], { type: "application/javascript" });
  captureProcessorUrl = URL.createObjectURL(blob);
  return captureProcessorUrl;
}

export type Capture = {
  /** Stop recording and return the audio resampled to 16 kHz mono. */
  stop: () => Promise<Float32Array>;
  /** Stop recording and discard the audio. */
  cancel: () => Promise<void>;
  getElapsedSec: () => number;
};

export async function startCapture(): Promise<Capture> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      channelCount: 1,
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
    },
  });

  const audioContext = new AudioContext({ sampleRate: TARGET_RATE });
  if (audioContext.state === "suspended") await audioContext.resume();

  try {
    await audioContext.audioWorklet.addModule(getCaptureProcessorUrl());
  } catch (err) {
    stream.getTracks().forEach((t) => t.stop());
    await audioContext.close();
    throw err;
  }

  const source = audioContext.createMediaStreamSource(stream);
  const node = new AudioWorkletNode(audioContext, "parley-capture");

  const chunks: Float32Array[] = [];
  let totalSamples = 0;
  const startedAt = performance.now();
  const actualRate = audioContext.sampleRate;

  node.port.onmessage = (event) => {
    const chunk = event.data as Float32Array;
    chunks.push(chunk);
    totalSamples += chunk.length;
  };

  source.connect(node);
  // Don't route capture node to destination — that would echo the mic
  // back through the speakers. AudioWorklet still processes frames.
  // Some browsers stop scheduling when the node is disconnected from
  // destination; if we hit that, route via a muted GainNode.
  const sink = audioContext.createGain();
  sink.gain.value = 0;
  node.connect(sink).connect(audioContext.destination);

  let finalized = false;

  async function teardown(): Promise<Float32Array> {
    if (finalized) return new Float32Array();
    finalized = true;
    node.port.onmessage = null;
    source.disconnect();
    node.disconnect();
    sink.disconnect();
    stream.getTracks().forEach((t) => t.stop());
    await audioContext.close();

    const raw = new Float32Array(totalSamples);
    let off = 0;
    for (const c of chunks) {
      raw.set(c, off);
      off += c.length;
    }
    return resampleLinear(raw, actualRate, TARGET_RATE);
  }

  return {
    stop: () => teardown(),
    cancel: async () => {
      await teardown();
    },
    getElapsedSec: () => (performance.now() - startedAt) / 1000,
  };
}

/**
 * Linear-interpolation resample. Plenty for the spike — once we wire into
 * Live we'll either route through a properly designed FIR low-pass or use
 * OfflineAudioContext, which does sinc resampling for free.
 */
function resampleLinear(input: Float32Array, fromRate: number, toRate: number): Float32Array {
  if (fromRate === toRate || input.length === 0) return input;
  const ratio = fromRate / toRate;
  const outLen = Math.floor(input.length / ratio);
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const src = i * ratio;
    const i0 = Math.floor(src);
    const i1 = Math.min(i0 + 1, input.length - 1);
    const frac = src - i0;
    out[i] = input[i0] * (1 - frac) + input[i1] * frac;
  }
  return out;
}
