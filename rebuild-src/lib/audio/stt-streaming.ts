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
    let settled = false;

    const ws = new WebSocket(url.toString());

    // Two timers guard the socket. Without them a Scribe session that connects
    // but never commits (or never opens at all) would leave James's per-turn
    // wait hanging forever — the caller in conversation.ts only falls back to
    // the batch REST path if THIS promise rejects.
    //  - connect: fire if `onopen` hasn't run, so a dead handshake fails fast.
    //  - overall: hard ceiling to the final/committed transcript.
    const CONNECT_TIMEOUT_MS = 3_000;
    const OVERALL_TIMEOUT_MS = 10_000;

    const cleanup = () => {
      signal?.removeEventListener("abort", abortHandler);
      clearTimeout(connectTimer);
      clearTimeout(overallTimer);
    };

    // Single-settle guards. Every exit path goes through these so a late event
    // (e.g. onclose after a timeout already rejected) can't double-settle the
    // promise or leave a timer armed.
    const settleResolve = (text: string) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(text);
    };
    const settleReject = (err: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    };

    const closeWs = (code: number, reason: string) => {
      try {
        ws.close(code, reason);
      } catch {
        /* socket may already be closing */
      }
    };

    const abortHandler = () => {
      aborted = true;
      closeWs(1000, "client abort");
      settleReject(new Error("aborted"));
    };

    // Arm the timers before wiring abort: a synchronous already-aborted signal
    // (below) runs abortHandler -> settleReject -> cleanup, which reads these
    // bindings. Declaring them first keeps that path out of the const TDZ.
    const connectTimer = setTimeout(() => {
      if (opened || settled) return;
      closeWs(1000, "connect timeout");
      const err = new Error(`Scribe stream connect timed out after ${CONNECT_TIMEOUT_MS}ms`);
      callbacks.onError?.(err);
      settleReject(err);
    }, CONNECT_TIMEOUT_MS);

    const overallTimer = setTimeout(() => {
      if (settled) return;
      closeWs(1000, "overall timeout");
      const err = new Error(`Scribe stream timed out after ${OVERALL_TIMEOUT_MS}ms`);
      callbacks.onError?.(err);
      settleReject(err);
    }, OVERALL_TIMEOUT_MS);

    if (signal) {
      if (signal.aborted) {
        abortHandler();
        return;
      }
      signal.addEventListener("abort", abortHandler, { once: true });
    }

    ws.onopen = () => {
      opened = true;
      clearTimeout(connectTimer);
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
          closeWs(1000, "segment done");
          settleResolve(finalText);
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
          closeWs(1000, "segment done");
          settleResolve(finalText);
          return;
        // Error-class messages — log the code so the operator sees what
        // went wrong, then reject with a useful error.
        default: {
          const errMsg = msg as { message_type: string; error?: string };
          const description = `${errMsg.message_type}: ${errMsg.error ?? "no detail"}`;
          const err = new Error(`Scribe stream ${description}`);
          callbacks.onError?.(err);
          closeWs(1011, errMsg.message_type);
          settleReject(err);
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
        settleReject(err);
      }
    };

    ws.onclose = (event) => {
      if (aborted || settled) return;
      if (event.code === 1000 || event.code === 1005) return;
      // Abnormal close before we resolved.
      const err = new Error(`Scribe stream closed (${event.code}): ${event.reason || "no reason"}`);
      callbacks.onError?.(err);
      settleReject(err);
    };
  });
}

/**
 * Persistent Scribe streaming session. Saves the per-segment WS handshake
 * (~100–200 ms: DNS + TLS + WS upgrade + server `session_started`) by
 * keeping one socket open across every utterance in a conversation.
 *
 * Protocol model: the server processes manual-commit chunks in order and
 * emits one `committed_transcript` per `commit: true` flush. We push one
 * segment at a time and wait for its committed_transcript before the next
 * push, so the client-side promise queue is trivially in-order with the
 * server. Partials arrive interleaved between the audio writes and the
 * commit reply; we forward them to the currently-active segment's
 * onPartial callback.
 *
 * Lifecycle:
 *   const stream = new ScribeStream(options);
 *   await stream.start();           // opens WS, awaits session_started
 *   const text = await stream.pushSegment(audio, { onPartial });
 *   const text2 = await stream.pushSegment(...);
 *   await stream.stop();
 *
 * Failure model: any error after `start()` closes the socket and rejects
 * every in-flight + queued segment so the caller can fall back to one-WS-
 * per-segment via `transcribeSegmentStreaming` for the rest of the
 * conversation. A new `ScribeStream` can be `start()`-ed for the next
 * conversation.
 */

export type ScribeStreamConfig = ScribeStreamOptions;
export type ScribeSegmentCallbacks = Pick<ScribeStreamCallbacks, "onPartial">;

export class ScribeStream {
  private ws: WebSocket | null = null;
  private startPromise: Promise<void> | null = null;
  private stopped = false;
  /**
   * Queue of segments waiting for their committed_transcript. Resolved
   * in FIFO order because Scribe processes manual commits in order.
   */
  private queue: Array<{
    resolve: (text: string) => void;
    reject: (err: Error) => void;
    onPartial?: (text: string) => void;
    finalText: string;
  }> = [];

  constructor(private config: ScribeStreamConfig = {}) {}

  isActive(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN && !this.stopped;
  }

  async start(signal?: AbortSignal): Promise<void> {
    if (this.startPromise) return this.startPromise;
    this.startPromise = this.doStart(signal);
    return this.startPromise;
  }

  private async doStart(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw new Error("aborted");

    const token = await fetchScribeToken(signal);
    const sampleRate = this.config.sampleRate ?? 16000;
    const includeTimestamps = this.config.includeTimestamps ?? false;
    const noVerbatim = this.config.noVerbatim ?? true;
    const languageCode = this.config.languageCode ?? "en";

    const url = new URL(SCRIBE_WS_BASE);
    url.searchParams.set("token", token);
    url.searchParams.set("model_id", MODEL_ID);
    url.searchParams.set("audio_format", `pcm_${sampleRate}`);
    url.searchParams.set("commit_strategy", "manual");
    if (includeTimestamps) url.searchParams.set("include_timestamps", "true");
    if (noVerbatim) url.searchParams.set("no_verbatim", "true");
    if (languageCode) url.searchParams.set("language_code", languageCode);
    if (this.config.keyTerms && this.config.keyTerms.length > 0) {
      const trimmed = this.config.keyTerms
        .map((t) => t.trim())
        .filter((t) => t.length > 0)
        .map((t) => (t.length > 20 ? t.slice(0, 20) : t))
        .slice(0, 50);
      for (const term of trimmed) {
        url.searchParams.append("keyterms", term);
      }
    }

    return new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(url.toString());
      this.ws = ws;
      const CONNECT_TIMEOUT_MS = 3_000;
      let opened = false;
      const connectTimer = setTimeout(() => {
        if (opened) return;
        try {
          ws.close(1000, "connect timeout");
        } catch {
          /* socket may already be closing */
        }
        reject(new Error(`Scribe stream connect timed out after ${CONNECT_TIMEOUT_MS}ms`));
      }, CONNECT_TIMEOUT_MS);

      ws.onopen = () => {
        opened = true;
      };
      ws.onmessage = (event) => this.handleMessage(event);
      ws.onerror = () => {
        // Browsers don't surface error detail on a WS error event — the
        // onclose handler that follows will reject queued segments with
        // the close code.
      };
      ws.onclose = (ev) => {
        clearTimeout(connectTimer);
        this.failQueue(
          new Error(
            `Scribe stream closed (code=${ev.code}${ev.reason ? `, reason=${ev.reason}` : ""})`,
          ),
        );
        this.ws = null;
        if (!opened) reject(new Error(`Scribe stream did not open (close code=${ev.code})`));
      };

      // Wait for session_started before resolving start(). We piggy-back
      // on handleMessage by enqueuing a sentinel that resolves on the
      // first session_started. Cleaner: parse it inline.
      const originalOnMessage = ws.onmessage;
      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(typeof event.data === "string" ? event.data : "") as {
            message_type?: string;
          };
          if (data.message_type === "session_started") {
            clearTimeout(connectTimer);
            // Restore the long-running message handler.
            ws.onmessage = originalOnMessage;
            resolve();
            return;
          }
        } catch {
          /* fall through */
        }
        originalOnMessage?.call(ws, event);
      };
    });
  }

  /**
   * Send one audio segment, flush it (manual commit), and wait for the
   * server's committed_transcript reply. Partial transcripts emitted by
   * Scribe between the audio writes and the commit go to onPartial.
   *
   * Segments are processed sequentially — each call waits for the prior
   * segment's promise to settle before sending its own audio. Without
   * this the partial_transcript stream from segment N+1 could leak onto
   * segment N's onPartial callback.
   */
  async pushSegment(
    waveform16k: Float32Array,
    callbacks: ScribeSegmentCallbacks = {},
  ): Promise<string> {
    if (this.stopped) throw new Error("ScribeStream stopped");
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("ScribeStream not open");
    }

    // Wait until the prior segment in the queue has its committed_transcript.
    // Without this serialization, partial_transcripts and commit replies
    // could interleave across segments since Scribe is ordered-but-async.
    while (this.queue.length > 0) {
      const prior = this.queue[0];
      await new Promise<void>((resolve, reject) => {
        const prevResolve = prior.resolve;
        const prevReject = prior.reject;
        prior.resolve = (text: string) => {
          prevResolve(text);
          resolve();
        };
        prior.reject = (err: Error) => {
          prevReject(err);
          reject(err);
        };
      }).catch(() => {});
      if (this.stopped) throw new Error("ScribeStream stopped");
    }

    const sampleRate = this.config.sampleRate ?? 16000;
    const sliceSamples = 4096;
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      throw new Error("ScribeStream not open");
    }

    return new Promise<string>((resolve, reject) => {
      this.queue.push({
        resolve,
        reject,
        onPartial: callbacks.onPartial,
        finalText: "",
      });

      for (let off = 0; off < waveform16k.length; off += sliceSamples) {
        const slice = waveform16k.subarray(off, off + sliceSamples);
        try {
          ws.send(
            JSON.stringify({
              message_type: "input_audio_chunk",
              audio_base_64: float32ToBase64Pcm16(slice),
              commit: false,
              sample_rate: sampleRate,
            }),
          );
        } catch (err) {
          reject(err instanceof Error ? err : new Error(String(err)));
          return;
        }
      }
      try {
        ws.send(
          JSON.stringify({
            message_type: "input_audio_chunk",
            audio_base_64: "",
            commit: true,
            sample_rate: sampleRate,
          }),
        );
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  private handleMessage(event: MessageEvent): void {
    let msg: ServerMessage;
    try {
      msg = JSON.parse(typeof event.data === "string" ? event.data : "") as ServerMessage;
    } catch {
      return;
    }
    const head = this.queue[0];
    switch (msg.message_type) {
      case "session_started":
        // Handled inline in start(); shouldn't reach here on the long-
        // running handler, but ignore safely if it does.
        return;
      case "partial_transcript":
        if (msg.text && head?.onPartial) head.onPartial(msg.text);
        return;
      case "committed_transcript":
      case "committed_transcript_with_timestamps": {
        if (!head) return;
        this.queue.shift();
        head.resolve(msg.text ?? head.finalText);
        return;
      }
      default: {
        const errMsg = msg as { message_type: string; error?: string };
        const err = new Error(
          `Scribe stream ${errMsg.message_type}: ${errMsg.error ?? "no detail"}`,
        );
        // Bail the whole stream — server-side error invalidates the
        // session. Caller falls back to one-shot per segment.
        this.failQueue(err);
        try {
          this.ws?.close(1011, errMsg.message_type);
        } catch {
          /* ignore */
        }
        this.ws = null;
      }
    }
  }

  private failQueue(err: Error): void {
    const pending = this.queue.splice(0);
    for (const p of pending) p.reject(err);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.failQueue(new Error("ScribeStream stopped"));
    if (this.ws) {
      try {
        this.ws.close(1000, "client stop");
      } catch {
        /* ignore */
      }
      this.ws = null;
    }
  }
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
