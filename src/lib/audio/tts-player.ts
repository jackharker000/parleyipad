/**
 * Streaming Flash v2.5 TTS over a WebSocket.
 *
 * Adapted from `rebuild-src/lib/audio/tts-player.ts`, but this app has no
 * `TTSProvider` abstraction — it talks to the ElevenLabs streaming-input
 * endpoint directly. The server mints an authenticated WS URL
 * (`createTtsStreamUrl`, key in the query string) since a browser WebSocket
 * can't set headers; we open it, push the text, and collect the streamed
 * base64 MP3 chunks.
 *
 * Why buffer-then-play rather than decode-as-bytes-arrive:
 *   - `decodeAudioData` can't decode MP3 *chunks* incrementally — the MP3 bit
 *     reservoir spans frames, so a per-chunk Web Audio decode corrupts.
 *   - MediaSource for short clips is unreliable on iPad Safari (the device this
 *     ships on). It only reliably arrived in Safari 13 and still misbehaves for
 *     sub-second audio.
 * So we accumulate chunks and play the assembled Blob through a single
 * `HTMLAudioElement`. The latency win over the old full-HTTP `synthesizeSpeech`
 * path is real anyway: Flash v2.5's ~75 ms model latency starts producing
 * audio the moment the socket opens, while the HTTP path waits for the whole
 * synth to complete server-side before a single byte reaches the client.
 *
 * The call resolves once playback STARTS (audio.play()), not when it ends, so
 * callers can run their post-speak persistence promptly. Any failure (no URL,
 * socket error, server error frame, timeout, empty audio) throws so the caller
 * can fall back to the full-synth path.
 */

export type StreamTTSArgs = {
  text: string;
  /** Authenticated wss:// URL from the `createTtsStreamUrl` server fn. */
  url: string;
  voiceSettings?: {
    stability?: number;
    similarity_boost?: number;
    speed?: number;
  };
  /** Abort streaming + playback (e.g. a newer utterance superseded this one). */
  signal?: AbortSignal;
  /**
   * Max ms to wait for the FIRST audio chunk before giving up and letting the
   * caller fall back. Keeps James from staring at a dead socket.
   */
  firstChunkTimeoutMs?: number;
  /** Optional hook: receives the assembled audio so the caller can cache it. */
  onAudioReady?: (blob: Blob, mimeType: string) => void;
};

const DEFAULT_VOICE_SETTINGS = {
  stability: 0.5,
  similarity_boost: 0.75,
  speed: 1.0,
} as const;

const MIME = "audio/mpeg";

/** Tracks the single in-flight streaming playback so a new speak() cancels it. */
let activeAbort: AbortController | null = null;
let activeAudio: { audio: HTMLAudioElement; url: string } | null = null;

function base64ToUint8(b64: string): Uint8Array {
  const binary = atob(b64);
  const len = binary.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function cleanupActiveAudio(audio: HTMLAudioElement) {
  if (activeAudio?.audio !== audio) return;
  try {
    URL.revokeObjectURL(activeAudio.url);
  } catch {
    /* ignore */
  }
  activeAudio = null;
}

/**
 * Stop any in-flight streaming playback. Called before starting a new utterance
 * and by the cockpit's stop handler. Aborting the controller closes the socket
 * (via the abort listener below) so an interrupted utterance releases the keyed
 * connection rather than leaking it.
 */
export function stopStreamingPlayback(): void {
  activeAbort?.abort();
  activeAbort = null;
  if (activeAudio) {
    try {
      activeAudio.audio.pause();
      activeAudio.audio.src = "";
    } catch {
      /* ignore */
    }
    try {
      URL.revokeObjectURL(activeAudio.url);
    } catch {
      /* ignore */
    }
    activeAudio = null;
  }
}

/**
 * Open the streaming WS, synthesise `text`, and start playing the result.
 * Resolves once playback has STARTED. Rejects on any failure so the caller
 * falls back to the full-synth path.
 */
export async function streamSpeak(args: StreamTTSArgs): Promise<void> {
  const text = args.text.trim();
  if (!text) return;
  if (typeof WebSocket === "undefined") {
    throw new Error("WebSocket unavailable");
  }

  // Supersede any prior streaming playback.
  stopStreamingPlayback();

  const abort = args.signal ? null : new AbortController();
  const signal = args.signal ?? abort!.signal;
  if (abort) activeAbort = abort;

  // Short so a connected-but-stalled socket falls back to full-synth fast —
  // James (latency-critical) shouldn't sit in dead air waiting on a bad WS.
  const firstChunkTimeoutMs = args.firstChunkTimeoutMs ?? 1500;

  const chunks: Uint8Array[] = [];

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    let firstChunkTimer: ReturnType<typeof setTimeout> | null = null;
    const ws = new WebSocket(args.url);

    const finish = (err?: Error) => {
      if (settled) return;
      settled = true;
      if (firstChunkTimer) clearTimeout(firstChunkTimer);
      signal.removeEventListener("abort", onAbort);
      try {
        if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
          ws.close();
        }
      } catch {
        /* ignore */
      }
      if (err) reject(err);
      else resolve();
    };

    const onAbort = () => finish(new Error("aborted"));
    if (signal.aborted) {
      finish(new Error("aborted"));
      return;
    }
    signal.addEventListener("abort", onAbort);

    ws.onopen = () => {
      // ElevenLabs stream-input handshake:
      //   1. BOS frame: a single space initialises the stream and carries
      //      voice_settings. The key already rode in on the URL query string,
      //      so no xi_api_key field is needed here.
      //   2. The actual text.
      //   3. An empty-string frame flushes the buffer and signals EOS.
      try {
        ws.send(
          JSON.stringify({
            text: " ",
            voice_settings: { ...DEFAULT_VOICE_SETTINGS, ...args.voiceSettings },
          }),
        );
        ws.send(JSON.stringify({ text }));
        ws.send(JSON.stringify({ text: "" }));
      } catch (e) {
        finish(e instanceof Error ? e : new Error("ws send failed"));
        return;
      }
      // Guard against a socket that opens but never produces audio.
      firstChunkTimer = setTimeout(() => {
        if (chunks.length === 0) finish(new Error("TTS stream timed out"));
      }, firstChunkTimeoutMs);
    };

    ws.onmessage = (ev) => {
      let msg: {
        audio?: string | null;
        isFinal?: boolean | null;
        error?: string;
        message?: string;
      };
      try {
        msg = JSON.parse(typeof ev.data === "string" ? ev.data : "");
      } catch {
        return; // ignore non-JSON frames
      }
      if (msg.error || (msg.message && !msg.audio && msg.isFinal == null)) {
        finish(new Error(msg.error || msg.message || "TTS stream error"));
        return;
      }
      if (msg.audio) {
        if (firstChunkTimer) {
          clearTimeout(firstChunkTimer);
          firstChunkTimer = null;
        }
        chunks.push(base64ToUint8(msg.audio));
      }
      if (msg.isFinal) finish();
    };

    ws.onerror = () => finish(new Error("TTS stream socket error"));
    ws.onclose = () => finish(); // server may close instead of sending isFinal
  });

  if (signal.aborted) throw new Error("aborted");
  if (chunks.length === 0) throw new Error("TTS stream produced no audio");

  const blob = new Blob(chunks as BlobPart[], { type: MIME });
  args.onAudioReady?.(blob, MIME);

  const objUrl = URL.createObjectURL(blob);
  const audio = new Audio(objUrl);
  activeAudio = { audio, url: objUrl };
  audio.addEventListener("ended", () => cleanupActiveAudio(audio));
  audio.addEventListener("error", () => cleanupActiveAudio(audio));

  try {
    await audio.play();
  } catch (err) {
    cleanupActiveAudio(audio);
    throw err instanceof Error ? err : new Error("audio playback failed");
  }
}
