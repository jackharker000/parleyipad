import { db, type CachedPhraseAudio } from "@/lib/db";

/**
 * On-device TTS audio cache. Two roles share the `cachedPhraseAudio` table:
 *
 *  - Quick phrases (`kind: "phrase"`): the five canned replies James taps when
 *    he needs to respond immediately. Pre-synthesised in the background on
 *    cockpit mount so they play with NO network and NO LLM — the load-bearing
 *    durable-degradation surface when everything else is degraded or offline.
 *
 *  - Repeated suggestions (`kind: "suggestion"`): any other spoken line is
 *    cached opportunistically after a successful synth, so speaking the same
 *    thing twice doesn't re-synthesise. Bounded by `SUGGESTION_CACHE_LIMIT`.
 *
 * The module is deliberately free of React and of any specific server-fn
 * binding: callers inject a `synth` function (the cockpit's `useServerFn`
 * wrapper over `synthesizeSpeech`). The synth path returns a full base64 MP3,
 * which is exactly what we want to persist whole.
 */

/**
 * The five quick phrases. Mirrors the cockpit's `QUICK_PHRASES` (kept in sync
 * by hand — both are short and rarely change). These are the phrases warmed on
 * mount; taps on them play from cache.
 */
export const QUICK_PHRASES = [
  "Yes",
  "No",
  "Give me a moment",
  "Could you repeat that?",
  "Sorry, who am I speaking with?",
] as const;

export type QuickPhraseText = (typeof QUICK_PHRASES)[number];

/** Cap on cached repeated-suggestion rows (phrases are exempt). */
const SUGGESTION_CACHE_LIMIT = 60;

const cacheKey = (text: string, voiceId: string) => `${text}::${voiceId}`;

/** Synthesise full audio for one line. Returns base64 + mime, or throws. */
export type SynthFn = (args: {
  data: { text: string; voiceId: string };
}) => Promise<{ audioBase64: string; mime: string }>;

function base64ToArrayBuffer(b64: string): ArrayBuffer {
  const binary = atob(b64);
  const len = binary.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

/**
 * Read cached audio for `text` in `voiceId`, if present. Returns null when it
 * hasn't been synthesised for this voice yet so the caller falls through to a
 * live path.
 */
export async function getCachedAudio(
  text: string,
  voiceId: string,
): Promise<CachedPhraseAudio | null> {
  const trimmed = text.trim();
  if (!trimmed || !voiceId) return null;
  const row = await db.cachedPhraseAudio.get(cacheKey(trimmed, voiceId));
  return row ?? null;
}

/** True if `text` is one of the canned quick phrases. */
export function isQuickPhrase(text: string): boolean {
  return (QUICK_PHRASES as readonly string[]).includes(text.trim());
}

async function synthAndStore(args: {
  text: string;
  voiceId: string;
  kind: "phrase" | "suggestion";
  synth: SynthFn;
}): Promise<CachedPhraseAudio | null> {
  const text = args.text.trim();
  if (!text || !args.voiceId) return null;
  const res = await args.synth({ data: { text, voiceId: args.voiceId } });
  if (!res?.audioBase64) return null;
  const row: CachedPhraseAudio = {
    id: cacheKey(text, args.voiceId),
    kind: args.kind,
    text,
    voiceId: args.voiceId,
    mimeType: res.mime || "audio/mpeg",
    audioBuffer: base64ToArrayBuffer(res.audioBase64),
    cachedAt: Date.now(),
  };
  await db.cachedPhraseAudio.put(row);
  return row;
}

/**
 * Synthesise + persist any quick phrases not already cached for `voiceId`.
 * Idempotent. Failures are logged, never thrown — the live/stream TTS path is
 * still the fallback at speak time (most likely cause of failure is a missing
 * ELEVENLABS_API_KEY, already surfaced elsewhere).
 *
 * Pass `pruneOldVoices` to drop phrase rows belonging to a previous voiceId so
 * the cache doesn't grow unbounded when James's voice changes.
 */
export async function warmQuickPhraseCache(args: {
  voiceId: string;
  synth: SynthFn;
  pruneOldVoices?: boolean;
}): Promise<void> {
  if (!args.voiceId) return;

  if (args.pruneOldVoices) {
    try {
      const stale = await db.cachedPhraseAudio
        .where("kind")
        .equals("phrase")
        .and((r) => r.voiceId !== args.voiceId)
        .toArray();
      if (stale.length > 0) {
        await db.cachedPhraseAudio.bulkDelete(stale.map((r) => r.id));
      }
    } catch (err) {
      console.warn("[quick-phrase-cache] prune failed", err);
    }
  }

  for (const phrase of QUICK_PHRASES) {
    try {
      const existing = await getCachedAudio(phrase, args.voiceId);
      if (existing) continue;
      await synthAndStore({
        text: phrase,
        voiceId: args.voiceId,
        kind: "phrase",
        synth: args.synth,
      });
    } catch (err) {
      console.warn(`[quick-phrase-cache] synth failed for "${phrase}"`, err);
    }
  }
}

/**
 * Synthesise a single quick phrase on demand if it isn't cached yet (cold-tap
 * before the background warm finished). Returns the row, or null on failure.
 */
export async function ensurePhraseCached(args: {
  text: string;
  voiceId: string;
  synth: SynthFn;
}): Promise<CachedPhraseAudio | null> {
  const existing = await getCachedAudio(args.text, args.voiceId);
  if (existing) return existing;
  try {
    return await synthAndStore({
      text: args.text,
      voiceId: args.voiceId,
      kind: "phrase",
      synth: args.synth,
    });
  } catch (err) {
    console.warn(`[quick-phrase-cache] on-demand synth failed for "${args.text}"`, err);
    return null;
  }
}

/**
 * Persist already-synthesised audio for a repeated suggestion. Fire-and-forget
 * after a successful stream/full-synth: a later repeat of the same line plays
 * from cache. Quick phrases are skipped (they're cached as `kind: "phrase"`).
 * Bounded — oldest suggestion rows are evicted past the limit.
 */
export async function cacheSuggestionAudio(args: {
  text: string;
  voiceId: string;
  blob: Blob;
}): Promise<void> {
  const text = args.text.trim();
  if (!text || !args.voiceId || isQuickPhrase(text)) return;
  try {
    const existing = await db.cachedPhraseAudio.get(cacheKey(text, args.voiceId));
    if (existing) return;
    const audioBuffer = await args.blob.arrayBuffer();
    if (audioBuffer.byteLength === 0) return;
    await db.cachedPhraseAudio.put({
      id: cacheKey(text, args.voiceId),
      kind: "suggestion",
      text,
      voiceId: args.voiceId,
      mimeType: args.blob.type || "audio/mpeg",
      audioBuffer,
      cachedAt: Date.now(),
    });
    await evictExcessSuggestions();
  } catch (err) {
    console.warn("[quick-phrase-cache] cacheSuggestionAudio failed", err);
  }
}

async function evictExcessSuggestions(): Promise<void> {
  try {
    const count = await db.cachedPhraseAudio.where("kind").equals("suggestion").count();
    if (count <= SUGGESTION_CACHE_LIMIT) return;
    const all = await db.cachedPhraseAudio.where("kind").equals("suggestion").sortBy("cachedAt");
    const toRemove = all.slice(0, count - SUGGESTION_CACHE_LIMIT);
    await db.cachedPhraseAudio.bulkDelete(toRemove.map((r) => r.id));
  } catch (err) {
    console.warn("[quick-phrase-cache] eviction failed", err);
  }
}

let activePlayback: { audio: HTMLAudioElement; url: string } | null = null;

/**
 * Play a cached audio row through a plain HTMLAudioElement — no network, no
 * provider, no fetch. Stops any currently-playing cached audio first so taps
 * never stack. Resolves once playback starts.
 */
export async function playCachedAudio(row: CachedPhraseAudio): Promise<void> {
  stopCachedPlayback();
  const blob = new Blob([row.audioBuffer] as BlobPart[], { type: row.mimeType });
  const url = URL.createObjectURL(blob);
  const audio = new Audio(url);
  activePlayback = { audio, url };
  audio.addEventListener("ended", () => {
    if (activePlayback?.audio === audio) stopCachedPlayback();
  });
  audio.addEventListener("error", () => {
    if (activePlayback?.audio === audio) stopCachedPlayback();
  });
  try {
    await audio.play();
  } catch (err) {
    stopCachedPlayback();
    throw err instanceof Error ? err : new Error("cached audio playback failed");
  }
}

export function stopCachedPlayback(): void {
  if (!activePlayback) return;
  try {
    activePlayback.audio.pause();
  } catch {
    /* ignore */
  }
  try {
    URL.revokeObjectURL(activePlayback.url);
  } catch {
    /* ignore */
  }
  activePlayback = null;
}
