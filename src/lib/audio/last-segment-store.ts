/**
 * Tiny in-memory store for the last VAD segment of room audio. The cockpit's
 * Replay button reads from here to play back what the person James was just
 * listening to said — clinically essential for AAC because James cannot ask
 * someone to repeat themselves without breaking the social rhythm. Local
 * playback only; no network, no STT, no re-transcription.
 *
 * Module-level singleton because (a) there is only one mic capture at a
 * time and (b) replaying a stale segment that's been wiped during route
 * change is harmless — the Replay button just no-ops.
 */

export type LastSegment = {
  audio: Float32Array;
  /** 16000 in current Silero VAD path; kept here in case we resample later. */
  sampleRate: number;
  durationMs: number;
  capturedAt: number;
};

let lastSegment: LastSegment | null = null;
let activePlayback: { source: AudioBufferSourceNode; ctx: AudioContext } | null = null;

export function setLastSegment(segment: LastSegment): void {
  lastSegment = segment;
}

export function getLastSegment(): LastSegment | null {
  return lastSegment;
}

export function clearLastSegment(): void {
  lastSegment = null;
}

/**
 * Play back the last captured segment via Web Audio. Stops any in-flight
 * replay first. Resolves when playback ends or is interrupted; rejects only
 * on AudioContext creation failure.
 */
export async function playLastSegment(): Promise<boolean> {
  const seg = lastSegment;
  if (!seg) return false;

  stopLastSegmentPlayback();

  const Ctor =
    typeof window !== "undefined"
      ? (window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext)
      : undefined;
  if (!Ctor) return false;

  const ctx = new Ctor();
  const buffer = ctx.createBuffer(1, seg.audio.length, seg.sampleRate);
  // Copy via a fresh ArrayBuffer-backed Float32Array. The VAD segment audio
  // may be backed by a SharedArrayBuffer in some configurations, which
  // copyToChannel's typing refuses.
  const channelData = buffer.getChannelData(0);
  channelData.set(seg.audio);
  const source = ctx.createBufferSource();
  source.buffer = buffer;
  source.connect(ctx.destination);

  activePlayback = { source, ctx };

  return new Promise<boolean>((resolve) => {
    source.onended = () => {
      if (activePlayback?.source === source) {
        try {
          void ctx.close();
        } catch {
          /* ignore */
        }
        activePlayback = null;
      }
      resolve(true);
    };
    source.start();
  });
}

export function stopLastSegmentPlayback(): void {
  if (!activePlayback) return;
  try {
    activePlayback.source.stop();
  } catch {
    /* ignore — already stopped */
  }
  try {
    void activePlayback.ctx.close();
  } catch {
    /* ignore */
  }
  activePlayback = null;
}
