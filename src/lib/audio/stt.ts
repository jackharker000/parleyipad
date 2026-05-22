import { makeSTT } from "@/lib/providers";
import type { STTProviderId } from "@/lib/db";

/**
 * Transcribe one VAD-segment of audio. The VAD gives us a Float32 array at
 * 16 kHz; ElevenLabs Scribe wants a WAV/webm/mp3 blob. We pack the Float32
 * array into a minimal 16-bit PCM WAV header and POST it through the proxy.
 *
 * Returns the full transcript text (Scribe returns word-level timestamps;
 * the cockpit v1 treats the whole segment as one transcript line).
 */
export async function transcribeSegment(args: {
  providerId: STTProviderId;
  waveform16k: Float32Array;
  signal?: AbortSignal;
}): Promise<string> {
  const wav = float32ToWav(args.waveform16k, 16000);
  const stt = makeSTT(args.providerId);
  const { segments } = await stt.transcribe({
    audio: new Blob([wav as BlobPart], { type: "audio/wav" }),
    sampleRate: 16000,
    signal: args.signal,
  });
  return segments
    .map((s) => s.text)
    .filter((t) => t && t.length > 0)
    .join(" ")
    .trim();
}

/**
 * Pack a Float32 PCM array into a 16-bit little-endian WAV blob. Used to
 * hand VAD segments off to the STT proxy in a format Scribe accepts.
 */
function float32ToWav(samples: Float32Array, sampleRate: number): Uint8Array {
  const numChannels = 1;
  const bitsPerSample = 16;
  const byteRate = (sampleRate * numChannels * bitsPerSample) / 8;
  const blockAlign = (numChannels * bitsPerSample) / 8;
  const dataSize = samples.length * 2;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  // RIFF chunk
  writeAscii(view, 0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeAscii(view, 8, "WAVE");

  // fmt chunk
  writeAscii(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);

  // data chunk
  writeAscii(view, 36, "data");
  view.setUint32(40, dataSize, true);

  let offset = 44;
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    offset += 2;
  }
  return new Uint8Array(buffer);
}

function writeAscii(view: DataView, offset: number, s: string): void {
  for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i));
}
