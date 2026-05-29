import type { TTSProviderId } from "@/lib/db";
import { makeTTS } from "@/lib/providers";

import {
  ensurePhraseCached,
  getCachedPhraseAudio,
  playCachedPhrase,
  QUICK_PHRASES,
  stopCachedPhrasePlayback,
} from "./quick-phrase-cache";

/**
 * Stand-alone "make a sound" function that James can invoke from anywhere
 * in the cockpit, regardless of whether a LiveConversation is started.
 * This is the load-bearing durable-degradation surface — quick phrases,
 * type-and-speak, and Replay all flow through here (replay uses its own
 * path because the audio is raw PCM, not synthesised speech).
 *
 * Order of operations:
 *   1. If the text matches a known quick phrase and we have a cached blob
 *      for the current voiceId, play it directly from IndexedDB (zero
 *      network).
 *   2. If it's a quick phrase but not yet cached, kick off a one-shot
 *      synth + persist, then play.
 *   3. Otherwise stream from the live TTS provider straight to an
 *      HTMLAudioElement. Same buffering pattern as TTSPlayer; subsequent
 *      calls cancel the prior playback.
 *
 * No LiveConversation calls, no Dexie writes to suggestionsLog or
 * transcriptSegments. Those side effects live in `LiveConversation.speak`
 * and are invoked only when there's an active conversation.
 */

let activeStreamAbort: AbortController | null = null;
let activeStreamAudio: { audio: HTMLAudioElement; url: string } | null = null;

export type SpeakTextArgs = {
  text: string;
  voiceId?: string;
  ttsProvider: TTSProviderId;
};

export async function speakText(args: SpeakTextArgs): Promise<void> {
  stopAllPlayback();

  const trimmed = args.text.trim();
  if (!trimmed) return;

  const isQuickPhrase = (QUICK_PHRASES as readonly string[]).includes(trimmed);

  if (isQuickPhrase && args.voiceId) {
    const cached = await getCachedPhraseAudio(trimmed, args.voiceId);
    if (cached) {
      await playCachedPhrase(cached);
      return;
    }
    // On-demand cache fill: synth this phrase, persist, then play. The
    // user still pays the network cost on the first tap, but subsequent
    // taps are instant.
    const justCached = await ensurePhraseCached({
      phraseText: trimmed,
      voiceId: args.voiceId,
      ttsProvider: args.ttsProvider,
    });
    if (justCached) {
      await playCachedPhrase(justCached);
      return;
    }
    // Cache fill failed (no key, network down). Fall through to live stream;
    // if that fails too the caller surfaces the error.
  }

  await streamFromProvider(args);
}

async function streamFromProvider(args: SpeakTextArgs): Promise<void> {
  const tts = makeTTS(args.ttsProvider);
  const abort = new AbortController();
  activeStreamAbort = abort;

  const chunks: Uint8Array[] = [];
  for await (const chunk of tts.stream({
    text: args.text,
    voiceId: args.voiceId ?? "",
    signal: abort.signal,
  })) {
    if (abort.signal.aborted) return;
    chunks.push(chunk);
  }
  if (abort.signal.aborted) return;

  const blob = new Blob(chunks as BlobPart[], { type: "audio/mpeg" });
  const url = URL.createObjectURL(blob);
  const audio = new Audio(url);
  activeStreamAudio = { audio, url };
  audio.addEventListener("ended", () => cleanupStream(audio));
  audio.addEventListener("error", () => cleanupStream(audio));
  await audio.play();
}

function cleanupStream(audio: HTMLAudioElement) {
  if (activeStreamAudio?.audio !== audio) return;
  URL.revokeObjectURL(activeStreamAudio.url);
  activeStreamAudio = null;
}

export function stopAllPlayback(): void {
  activeStreamAbort?.abort();
  activeStreamAbort = null;
  if (activeStreamAudio) {
    try {
      activeStreamAudio.audio.pause();
    } catch {
      /* ignore */
    }
    URL.revokeObjectURL(activeStreamAudio.url);
    activeStreamAudio = null;
  }
  stopCachedPhrasePlayback();
}
