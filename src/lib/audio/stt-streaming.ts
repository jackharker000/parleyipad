/**
 * Streaming Scribe v2 over WebSocket. Replaces the batch REST proxy when the
 * client wants partial transcripts mid-utterance — partials land ~300 ms
 * after speech start, final ~500–800 ms after speech end, vs ~2–6 s for the
 * batch path. This is the single biggest latency lever for James's per-turn
 * wait.
 *
 * Protocol (confirmed by reading the @elevenlabs/client public source —
 * src/scribe/connection.ts and src/wrapper/realtime/scribe.ts in their
 * monorepo):
 *
 * - URL: wss://api.elevenlabs.io/v1/speech-to-text/realtime?token=...&...
 * - Token via /api/stt/scribe-token (server mints a single-use one from
 *   ELEVENLABS_API_KEY). Browser can't set custom headers on `new WebSocket()`,
 *   and this is the official mechanism — no real key reaches the device.
 * - All config is in the URL query string. There is NO init message.
 * - Audio is JSON-wrapped base64 PCM16-LE mono at the configured sample rate.
 *   Message: `{ message_type: "input_audio_chunk", audio_base_64, commit, sample_rate }`.
 * - Server frames are JSON discriminated by `message_type`. The two we care
 *   about: `partial_transcript` (interim text) and `committed_transcript`
 *   (final). `committed_transcript_with_timestamps` is the same with word
 *   timings when include_timestamps=true.
 * - "Done sending" = one final input_audio_chunk with audio_base_64="" and
 *   commit=true. Wait for the matching committed_transcript, then close 1000.
 *
 * Lifetime: one WebSocket per VAD segment. Keeping it open across segments
 * would save ~50–150 ms of handshake per turn but adds reconnect/keepalive
 * complexity and risks `session_time_limit_exceeded`. Revisit if profiling
 * shows the handshake matters.
 *
 * The plan's earlier two-endpoint HMAC design (mint opaque token, exchange
 * for URL with real key) is OBSOLETE — the official single-use-token
 * endpoint already does exactly this, and the real key never leaves the
 * server.
 */

const SCRIBE_WS_BASE = "wss://api.elevenlabs.io/v1/speech-to-text/realtime";
const MODEL_ID = "scribe_v2_realtime";

export type ScribeStreamOptions = {
  /**
   * Override the language code. Defaults to "en". Pass undefined to let
   * Scribe auto-detect — but auto-detect adds latency and the cockpit is
   * for one English-speaking user, so we pin it.
   */
  languageCode?: string;
  /** Force no_verbatim on the WS (the streaming equivalent of the batch
   * tag_audio_events=false flag). Suppresses (laughs)/(pauses) filler tokens. */
  noVerbatim?: boolean;
  /** Include word-level timestamps in the final transcript message. */
  includeTimestamps?: boolean;
  /** Sample rate of the audio you'll feed. Must match what you actually
   * send. Defaults to 16000 (Parley's VAD output). */
  sampleRate?: number;
  /**
   * Pass through to Scribe's `keyterms` biasing. Improves recognition of
   * proper nouns + jargon (names, place names, project nicknames). Order
   * matters — higher-priority terms first. Scribe v2 realtime caps the
   * list at 50 terms of up to 20 chars each and sends them as repeated
   * `keyterms` query params on the WebSocket URL.
   *
   * Source: https://elevenlabs.io/docs/api-reference/speech-to-text/v-1-speech-to-text-realtime
   * (also confirmed via the May 2026 changelog announcing keyterm support).
   */
  keyTerms?: string[];
};

export type ScribeStreamCallbacks = {
  onPartial?: (text: string) => void;
  onFinal?: (text: string, words?: ScribeWord[]) => void;
  onError?: (err: Error) => void;
};

export type ScribeWord = {
  text?: string;
  start?: number;
  end?: number;
  type?: "word" | "spacing";
  speakerId?: string;
  logprob?: number;
};

type ServerMessage =
  | { message_type: "session_started"; session_id?: string; config?: unknown }
  | { message_type: "partial_transcript"; text?: string }
  | { message_type: "committed_transcript"; text?: string }
  | {
      message_type: "committed_transcript_with_timestamps";
      text?: string;
      language_code?: string;
      words?: Array<{
        text?: string;
        start?: number;
        end?: number;
        type?: "word" | "spacing";
        speaker_id?: string;
        logprob?: number;
      }>;
    }
  // Error-class messages. We forward them all as onError(message_type + error).
  | {
      message_type:
        | "error"
        | "auth_error"
        | "quota_exceeded"
        | "commit_throttled"
        | "transcriber_error"
        | "unaccepted_terms_error"
        | "rate_limited"
        | "input_error"
        | "queue_overflow"
        | "resource_exhausted"
        | "session_time_limit_exceeded"
        | "chunk_size_exceeded"
        | "insufficient_audio_activity";
      error?: string;
    };

/**
 * Fire a single Scribe streaming session for one VAD segment. Resolves with
 * the final transcript text once the server has committed it (or rejects
 * on error / timeout).
 *
 * Calls `onPartial` with each interim text as it arrives, so the cockpit
 * can paint the transcript line in italics before the final lands.
 */
export async function transcribeSegmentStreaming(args: {
  waveform16k: Float32Array;
  callbacks: ScribeStreamCallbacks;
  options?: ScribeStreamOptions;
  signal?: AbortSignal;
}): Promise<string> {
  const { waveform16k, callbacks, options = {}, signal } = args;
  const sampleRate = options.sampleRate ?? 16000;
  const includeTimestamps = options.includeTimestamps ?? true;
  const noVerbatim = options.noVerbatim ?? true;
  const languageCode = options.languageCode ?? "en";

  if (signal?.aborted) throw new Error("aborted");

  const token = await fetchScribeToken(signal);

  const url = new URL(SCRIBE_WS_BASE);
  url.searchParams.set("token", token);
  url.searchParams.set("model_id", MODEL_ID);
  url.searchParams.set("audio_format", `pcm_${sampleRate}`);
  // Manual commit because Parley already has its own VAD; we do not want
  // the server's VAD to second-guess our segmentation.
  url.searchParams.set("commit_strategy", "manual");
  if (includeTimestamps) url.searchParams.set("include_timestamps", "true");
  if (noVerbatim) url.searchParams.set("no_verbatim", "true");
  if (languageCode) url.searchParams.set("language_code", languageCode);
  // Scribe v2 realtime accepts `keyterms` as repeated URL query parameters
  // (not a single JSON array). Up to 50 entries of 20 chars each. We cap +
  // truncate defensively because the upstream errors are awkward to surface.
  if (options.keyTerms && options.keyTerms.length > 0) {
    const trimmed = options.keyTerms
      .map((t) => t.trim())
      .filter((t) => t.length > 0)
      .map((t) => (t.length > 20 ? t.slice(0, 20) : t))
      .slice(0, 50);
    for (const term of trimmed) {
      url.searchParams.append("keyterms", term);
    }
  }

  return new Promise<string>((resolve, reject) => {
    let finalText = "";
    let finalWords: ScribeWord[] | undefined;
    let opened = false;
    let aborted = false;

    const ws = new WebSocket(url.toString());

    const abortHandler = () => {
      aborted = true;
      try {
        ws.close(1000, "client abort");
      } catch {
        /* ignore */
      }
      reject(new Error("aborted"));
    };
    if (signal) {
      if (signal.aborted) {
        abortHandler();
        return;
      }
      signal.addEventListener("abort", abortHandler, { once: true });
    }

    const cleanup = () => {
      signal?.removeEventListener("abort", abortHandler);
    };

    ws.onopen = () => {
      opened = true;
      // Stream audio in ~250 ms slices so partials come back smoothly. With
      // 16 kHz that's 4096 samples per slice — matches the official client's
      // worklet buffer size.
      const sliceSamples = 4096;
      for (let off = 0; off < waveform16k.length; off += sliceSamples) {
        const slice = waveform16k.subarray(off, off + sliceSamples);
        ws.send(
          JSON.stringify({
            message_type: "input_audio_chunk",
            audio_base_64: float32ToBase64Pcm16(slice),
            commit: false,
            sample_rate: sampleRate,
          }),
        );
      }
      // Empty-with-commit flushes the manual-commit buffer and triggers
      // committed_transcript.
      ws.send(
        JSON.stringify({
          message_type: "input_audio_chunk",
          audio_base_64: "",
          commit: true,
          sample_rate: sampleRate,
        }),
      );
    };

    ws.onmessage = (event) => {
      if (aborted) return;
      let msg: ServerMessage;
      try {
        msg = JSON.parse(typeof event.data === "string" ? event.data : "") as ServerMessage;
      } catch {
        return;
      }
      switch (msg.message_type) {
        case "session_started":
          // Server acknowledged our config. Nothing to do — audio was already
          // queued during onopen.
          return;
        case "partial_transcript":
          if (msg.text) callbacks.onPartial?.(msg.text);
          return;
        case "committed_transcript":
          finalText = msg.text ?? finalText;
          callbacks.onFinal?.(finalText, finalWords);
          try {
            ws.close(1000, "segment done");
          } catch {
            /* ignore */
          }
          cleanup();
          resolve(finalText);
          return;
        case "committed_transcript_with_timestamps":
          finalText = msg.text ?? finalText;
          finalWords = msg.words?.map((w) => ({
            text: w.text,
            start: w.start,
            end: w.end,
            type: w.type,
            speakerId: w.speaker_id,
            logprob: w.logprob,
          }));
          callbacks.onFinal?.(finalText, finalWords);
          try {
            ws.close(1000, "segment done");
          } catch {
            /* ignore */
          }
          cleanup();
          resolve(finalText);
          return;
        // Error-class messages — log the code so the operator sees what
        // went wrong, then let onclose reject with a useful error.
        default: {
          const errMsg = msg as { message_type: string; error?: string };
          const description = `${errMsg.message_type}: ${errMsg.error ?? "no detail"}`;
          const err = new Error(`Scribe stream ${description}`);
          callbacks.onError?.(err);
          try {
            ws.close(1011, errMsg.message_type);
          } catch {
            /* ignore */
          }
          cleanup();
          reject(err);
        }
      }
    };

    ws.onerror = () => {
      // Browsers give us a content-less event on WS error; the close handler
      // below carries the useful code. Don't reject here so we don't double-
      // resolve.
      if (!opened) {
        const err = new Error("Scribe stream connection failed");
        callbacks.onError?.(err);
        cleanup();
        reject(err);
      }
    };

    ws.onclose = (event) => {
      if (aborted) return;
      if (event.code === 1000 || event.code === 1005) return;
      // Abnormal close before we resolved.
      const err = new Error(`Scribe stream closed (${event.code}): ${event.reason || "no reason"}`);
      callbacks.onError?.(err);
      cleanup();
      // If we already resolved or rejected, this is a no-op.
      reject(err);
    };
  });
}

async function fetchScribeToken(signal?: AbortSignal): Promise<string> {
  const res = await fetch("/api/stt/scribe-token", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
    signal,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`scribe-token proxy ${res.status}: ${text}`);
  }
  const data = (await res.json()) as { token?: string };
  if (!data.token) throw new Error("scribe-token proxy returned no token");
  return data.token;
}

/**
 * Convert Float32 [-1, 1] PCM samples into base64-encoded PCM16 little-endian
 * bytes — the wire format Scribe v2 realtime expects in each
 * input_audio_chunk message.
 */
function float32ToBase64Pcm16(samples: Float32Array): string {
  const buf = new ArrayBuffer(samples.length * 2);
  const view = new DataView(buf);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  const bytes = new Uint8Array(buf);
  // btoa needs a binary string. Chunked to avoid the apply-spread limit on
  // very large utterances (a 10 s clip at 16 kHz is 320,000 bytes; Safari's
  // applyBlock is fine but explicit-chunking is the safer pattern).
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunk)));
  }
  return btoa(binary);
}
