import { nanoid } from "nanoid";

import { db, type CachedPhraseAudio, type TTSProviderId } from "@/lib/db";
import { makeTTS } from "@/lib/providers";

/**
 * Pre-synthesised audio for the five canned quick phrases James taps when he
 * needs to respond immediately. The point of caching is durable degradation:
 * these clips MUST play with no network, no LLM, no embedder warm — they're
 * the last-resort affordance when everything else is degraded or warming up.
 *
 * On first cockpit mount, missing phrases are synthesised in the background.
 * Subsequent taps play from IndexedDB through a plain HTMLAudioElement —
 * no `LiveConversation`, no provider stream, no fetch.
 */

export const QUICK_PHRASES = [
  "Yes",
  "No",
  "Wait",
  "I'm not finished",
  "Give me a moment",
  "Could you repeat that?",
  "I need help",
  "Sorry, who am I speaking with?",
] as const;

export type QuickPhraseText = (typeof QUICK_PHRASES)[number];

const cacheKey = (phraseText: string, voiceId: string) => `${phraseText}::${voiceId}`;

/**
 * Read the cached audio for one phrase, if present. Returns null when the
 * phrase hasn't been synthesised for this voiceId yet so the caller can
 * fall through to the live TTS path.
 */
export async function getCachedPhraseAudio(
  phraseText: string,
  voiceId: string,
): Promise<CachedPhraseAudio | null> {
  const row = await db().cachedPhraseAudio.get(cacheKey(phraseText, voiceId));
  return row ?? null;
}

/**
 * Synthesise + persist any phrases that aren't already cached for the
 * current voiceId. Idempotent: running it again is a near no-op. Failures
 * are logged but never thrown — the live TTS path still works as a
 * fallback at speak time.
 *
 * Optionally clears entries that belong to an old voiceId so the table
 * doesn't grow unboundedly when the user changes James's voice.
 */
export async function warmQuickPhraseCache(args: {
  voiceId: string;
  ttsProvider: TTSProviderId;
  /** Drop rows whose voiceId differs from the current one. */
  pruneOldVoices?: boolean;
}): Promise<void> {
  if (!args.voiceId) return;

  if (args.pruneOldVoices) {
    try {
      const stale = await db()
        .cachedPhraseAudio.filter((row) => row.voiceId !== args.voiceId)
        .toArray();
      if (stale.length > 0) {
        await db().cachedPhraseAudio.bulkDelete(stale.map((r) => r.id));
      }
    } catch (err) {
      console.warn("[quick-phrase-cache] prune failed", err);
    }
  }

  const tts = makeTTS(args.ttsProvider);

  for (const phraseText of QUICK_PHRASES) {
    const existing = await getCachedPhraseAudio(phraseText, args.voiceId);
    if (existing) continue;
    try {
      const chunks: Uint8Array[] = [];
      for await (const chunk of tts.stream({ text: phraseText, voiceId: args.voiceId })) {
        chunks.push(chunk);
      }
      if (chunks.length === 0) continue;
      const blob = new Blob(chunks as BlobPart[], { type: "audio/mpeg" });
      const audioBuffer = await blob.arrayBuffer();
      const row: CachedPhraseAudio = {
        id: cacheKey(phraseText, args.voiceId),
        phraseText,
        voiceId: args.voiceId,
        mimeType: "audio/mpeg",
        audioBuffer,
        cachedAt: Date.now(),
      };
      await db().cachedPhraseAudio.put(row);
    } catch (err) {
      // Soft-fail: the live TTS path remains the fallback at speak time.
      // Most likely cause is a missing ELEVENLABS_API_KEY on the server —
      // surfaced separately as the missing-keys banner in the cockpit.
      console.warn(`[quick-phrase-cache] synth failed for "${phraseText}"`, err);
    }
  }
}

/**
 * Synthesise a single phrase on demand if it isn't already cached. Used
 * when James taps a phrase the cache hasn't warmed up yet (cold start)
 * so that subsequent taps are instant.
 */
export async function ensurePhraseCached(args: {
  phraseText: string;
  voiceId: string;
  ttsProvider: TTSProviderId;
}): Promise<CachedPhraseAudio | null> {
  const existing = await getCachedPhraseAudio(args.phraseText, args.voiceId);
  if (existing) return existing;
  try {
    const tts = makeTTS(args.ttsProvider);
    const chunks: Uint8Array[] = [];
    for await (const chunk of tts.stream({ text: args.phraseText, voiceId: args.voiceId })) {
      chunks.push(chunk);
    }
    if (chunks.length === 0) return null;
    const blob = new Blob(chunks as BlobPart[], { type: "audio/mpeg" });
    const audioBuffer = await blob.arrayBuffer();
    const row: CachedPhraseAudio = {
      id: cacheKey(args.phraseText, args.voiceId),
      phraseText: args.phraseText,
      voiceId: args.voiceId,
      mimeType: "audio/mpeg",
      audioBuffer,
      cachedAt: Date.now(),
    };
    await db().cachedPhraseAudio.put(row);
    return row;
  } catch (err) {
    console.warn(`[quick-phrase-cache] on-demand synth failed for "${args.phraseText}"`, err);
    return null;
  }
}

let activePlayback: { audio: HTMLAudioElement; url: string } | null = null;

/**
 * Play a cached phrase from IndexedDB. Stops any currently-playing cached
 * audio first so taps never stack.
 */
export async function playCachedPhrase(row: CachedPhraseAudio): Promise<void> {
  stopCachedPhrasePlayback();
  const blob = new Blob([row.audioBuffer] as BlobPart[], { type: row.mimeType });
  const url = URL.createObjectURL(blob);
  const audio = new Audio(url);
  activePlayback = { audio, url };
  audio.addEventListener("ended", () => {
    if (activePlayback?.audio === audio) stopCachedPhrasePlayback();
  });
  audio.addEventListener("error", () => {
    if (activePlayback?.audio === audio) stopCachedPhrasePlayback();
  });
  await audio.play();
}

export function stopCachedPhrasePlayback(): void {
  if (!activePlayback) return;
  try {
    activePlayback.audio.pause();
  } catch {
    /* no-op */
  }
  URL.revokeObjectURL(activePlayback.url);
  activePlayback = null;
}

// nanoid kept around for any future migration that needs to rewrite ids;
// the cache key is deterministic today so we don't actually call it.
void nanoid;
