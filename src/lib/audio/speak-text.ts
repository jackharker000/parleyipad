import {
  cacheSuggestionAudio,
  ensurePhraseCached,
  getCachedAudio,
  isQuickPhrase,
  playCachedAudio,
  stopCachedPlayback,
  type SynthFn,
} from "./quick-phrase-cache";
import { stopStreamingPlayback, streamSpeak } from "./tts-player";

/**
 * Single audio-production path for everything James speaks: quick phrases,
 * tapped suggestions, expanded/typed replies, predictions. The cockpit's
 * `speak()` calls this to PRODUCE the sound; it keeps owning the post-speak
 * persistence (transcript segment, suggestion-log update, recordSelectionChoice).
 *
 * Latency- and reliability-ordered:
 *   1. Cached audio (quick phrase OR previously-spoken suggestion) → instant,
 *      zero network, works offline.
 *   2. Cold quick phrase → synth + persist, then play (first tap pays the
 *      network cost; later taps are instant).
 *   3. Streaming Flash v2.5 over WebSocket → first audio in ~75 ms, plays as
 *      the assembled blob is ready. Caches the result for repeats.
 *   4. Full-synth fallback (`synthesizeSpeech`) → the reliable HTTP path if the
 *      socket fails/errs/times out. Also cached for repeats.
 *
 * If every path fails it throws, so the cockpit's existing "Speech failed"
 * toast fires. Quick phrases still play from cache when the network is down
 * (path 1) — James is never left silent as long as the cache is warm.
 */

/** Resolves the authenticated streaming WS URL (server fn caller). */
export type StreamUrlFn = (args: {
  data: { voiceId: string; outputFormat?: "mp3_22050_32" | "mp3_44100_64" | "mp3_44100_128" };
}) => Promise<{ url: string }>;

export type SpeakArgs = {
  text: string;
  voiceId: string;
  /** Server-fn caller for the streaming WS URL (e.g. useServerFn(createTtsStreamUrl)). */
  streamUrlFn: StreamUrlFn;
  /** Server-fn caller for the full-synth fallback (e.g. useServerFn(synthesizeSpeech)). */
  synthFn: SynthFn;
  /** When false, skip the WS path entirely (e.g. a settings kill-switch). Defaults true. */
  streaming?: boolean;
};

/** Stop all playback paths (streaming, cached). Used by the cockpit stop handler. */
export function stopSpeaking(): void {
  stopStreamingPlayback();
  stopCachedPlayback();
}

/** Play already-synthesised base64 audio through a plain HTMLAudioElement. */
async function playBase64(audioBase64: string, mime: string): Promise<Blob> {
  const binary = atob(audioBase64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  const blob = new Blob([bytes] as BlobPart[], { type: mime || "audio/mpeg" });
  const url = URL.createObjectURL(blob);
  const audio = new Audio(url);
  audio.addEventListener("ended", () => URL.revokeObjectURL(url));
  audio.addEventListener("error", () => URL.revokeObjectURL(url));
  try {
    await audio.play();
  } catch (err) {
    URL.revokeObjectURL(url);
    throw err instanceof Error ? err : new Error("audio playback failed");
  }
  return blob;
}

async function fullSynthAndPlay(args: SpeakArgs): Promise<void> {
  const res = await args.synthFn({ data: { text: args.text, voiceId: args.voiceId } });
  const blob = await playBase64(res.audioBase64, res.mime);
  // Cache repeats (no-op for quick phrases / already-cached lines).
  void cacheSuggestionAudio({ text: args.text, voiceId: args.voiceId, blob });
}

export async function speakText(args: SpeakArgs): Promise<void> {
  const text = args.text.trim();
  if (!text) return;

  // Supersede any in-flight speech so utterances never overlap.
  stopSpeaking();

  // 1. Cached audio (quick phrase or repeated suggestion) — instant, offline.
  if (args.voiceId) {
    try {
      const cached = await getCachedAudio(text, args.voiceId);
      if (cached) {
        await playCachedAudio(cached);
        return;
      }
    } catch (err) {
      console.warn("[speak-text] cache lookup failed", err);
    }
  }

  // 2. Cold quick phrase — synth + persist, then play from cache.
  if (args.voiceId && isQuickPhrase(text)) {
    try {
      const row = await ensurePhraseCached({
        text,
        voiceId: args.voiceId,
        synth: args.synthFn,
      });
      if (row) {
        await playCachedAudio(row);
        return;
      }
    } catch (err) {
      console.warn("[speak-text] cold quick-phrase synth failed", err);
      // fall through to streaming / full-synth
    }
  }

  // 3. Streaming Flash v2.5 over WebSocket — lowest live latency.
  const useStreaming = args.streaming !== false && args.voiceId;
  if (useStreaming) {
    try {
      const { url } = await args.streamUrlFn({ data: { voiceId: args.voiceId } });
      await streamSpeak({
        text,
        url,
        onAudioReady: (blob) => {
          void cacheSuggestionAudio({ text, voiceId: args.voiceId, blob });
        },
      });
      return;
    } catch (err) {
      // Never go silent: drop to the reliable full-synth path.
      console.warn("[speak-text] streaming TTS failed, falling back to full synth", err);
    }
  }

  // 4. Full-synth fallback (HTTP). Throws on failure → caller's toast fires.
  await fullSynthAndPlay(args);
}
