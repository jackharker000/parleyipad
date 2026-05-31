import type { TTSProvider } from "@/lib/providers";

/**
 * TTS playback. Buffers the streamed MP3 chunks into a single audio blob
 * and plays it through an HTMLAudioElement. Not ideal — true streaming
 * playback (decode as bytes arrive) would land the first word a beat
 * earlier — but it's reliable on iPad Safari which dislikes
 * MediaSource for short clips. The first byte still gets requested while
 * the LLM is finishing, so end-to-end latency is dominated by the LLM,
 * not the TTS.
 *
 * Multiple `speak()` calls cancel any prior playback so suggestions
 * never overlap.
 */
export class TTSPlayer {
  private audio: HTMLAudioElement | null = null;
  private currentAbort: AbortController | null = null;
  private currentUrl: string | null = null;

  constructor(private provider: TTSProvider) {}

  setProvider(provider: TTSProvider): void {
    this.provider = provider;
  }

  async speak(args: { text: string; voiceId?: string }): Promise<void> {
    this.stop();
    const abort = new AbortController();
    this.currentAbort = abort;

    const chunks: Uint8Array[] = [];
    // Returning/breaking out of this `for await` (the abort checks below) calls
    // the provider iterator's `return()`, which runs the generator's `finally`
    // and cancels its upstream reader — so an interrupted utterance releases the
    // keyed TTS connection rather than leaking it. `abort.signal` is also wired
    // into the provider fetch, so a mid-`read()` interrupt aborts the body too.
    for await (const chunk of this.provider.stream({
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
    this.currentUrl = url;

    const audio = new Audio(url);
    this.audio = audio;
    audio.addEventListener("ended", () => this.cleanup());
    audio.addEventListener("error", () => this.cleanup());

    try {
      await audio.play();
    } catch (err) {
      this.cleanup();
      throw err;
    }
  }

  stop(): void {
    this.currentAbort?.abort();
    this.currentAbort = null;
    if (this.audio) {
      this.audio.pause();
      this.audio.src = "";
    }
    this.cleanup();
  }

  private cleanup() {
    if (this.currentUrl) {
      URL.revokeObjectURL(this.currentUrl);
      this.currentUrl = null;
    }
    this.audio = null;
  }
}
