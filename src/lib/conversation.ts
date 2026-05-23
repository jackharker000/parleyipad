import { nanoid } from "nanoid";

import {
  db,
  type Conversation,
  type Person,
  type SettingsRecord,
  type SuggestionCategory,
  type SuggestionLog,
  type TranscriptSegment,
  type Voiceprint,
} from "@/lib/db";
import { SileroVAD, type VADSegment } from "@/lib/audio/vad";
import { centroidsFromVoiceprints, match, type Candidate } from "@/lib/audio/matcher";
import { encodeEmbedding, rms } from "@/lib/audio/utils";
import { transcribeSegment } from "@/lib/audio/stt";
import type { SpeakerEmbedder } from "@/lib/audio/embedder";
import { TTSPlayer } from "@/lib/audio/tts-player";
import type { DomainAI, Mood, SuggestionDraft } from "@/lib/ai";
import { makeTTS } from "@/lib/providers";

/**
 * Drives one live cockpit session: starts VAD, transcribes each utterance,
 * runs the speaker-ID matcher, persists transcript segments, kicks off
 * turn-triggered suggestion generation, and plays back TTS when James
 * taps a suggestion.
 *
 * The class is intentionally callback-driven (rather than React state-
 * driven) so the route component can stay thin. The route subscribes to
 * `on*` hooks and re-renders. All Dexie writes happen here.
 */

export type ConversationCallbacks = {
  onStateChange?: (state: ConversationState) => void;
  onTranscriptSegment?: (segment: LiveTranscriptSegment) => void;
  onSuggestions?: (suggestions: SuggestionDraft[], generating: boolean) => void;
  onSpeakerCandidates?: (candidates: Candidate[]) => void;
  onError?: (err: Error) => void;
};

export type ConversationState = "idle" | "starting" | "listening" | "speech" | "stopping";

export type LiveTranscriptSegment = {
  id: string;
  conversationId: string;
  text: string;
  speakerKind: "self" | "other";
  speakerLabel: string;
  personId?: string;
  personName?: string;
  confidence?: number;
  startedAt: number;
  endedAt: number;
};

export type ConversationDeps = {
  embedderRef: { current: SpeakerEmbedder | null };
  ai: DomainAI;
  settings: SettingsRecord;
  jamesName: string;
  placeId?: string;
  eventId?: string;
};

export class LiveConversation {
  private vad: SileroVAD | null = null;
  private tts: TTSPlayer;
  private state: ConversationState = "idle";
  private conversation: Conversation | null = null;
  private callbacks: ConversationCallbacks = {};
  private mood: Mood = "normal";
  private pendingSuggestionAbort: AbortController | null = null;

  private people: Person[] = [];
  private voiceprints: Voiceprint[] = [];
  private recentSpeakers: string[] = [];
  private transcriptCache: LiveTranscriptSegment[] = [];

  // Memory-pressure mitigations for iPad Safari. The tab gets OOM-killed
  // after ~60 s of continuous recording because (a) ONNX Runtime's WASM
  // heap grows monotonically per inference call and never shrinks, and
  // (b) when STT + LLM run slower than VAD segments arrive, in-flight
  // segments stack up, each holding a Float32 audio buffer.
  //
  //  - inFlight + MAX_IN_FLIGHT: only one segment processes at a time;
  //    new ones that arrive mid-flight get dropped (with a soft warning).
  //  - segmentCount + lastResetAt: every N segments or M ms, dispose the
  //    embedder and warm it back up to release the WASM heap.
  private inFlight = 0;
  private segmentCount = 0;
  private lastResetAt = 0;
  private dropped = 0;
  private static readonly MAX_IN_FLIGHT = 1;
  private static readonly EMBEDDER_RESET_AFTER_N_SEGMENTS = 25;
  private static readonly EMBEDDER_RESET_INTERVAL_MS = 3 * 60 * 1000;
  private static readonly TRANSCRIPT_CACHE_MAX = 10;

  constructor(private deps: ConversationDeps) {
    this.tts = new TTSPlayer(makeTTS(deps.settings.ttsProvider));
  }

  on(callbacks: ConversationCallbacks): void {
    this.callbacks = { ...this.callbacks, ...callbacks };
  }

  setMood(mood: Mood): void {
    this.mood = mood;
  }

  setRoster(args: { people: Person[]; voiceprints: Voiceprint[] }): void {
    this.people = args.people;
    this.voiceprints = args.voiceprints;
  }

  getState(): ConversationState {
    return this.state;
  }

  async start(): Promise<void> {
    if (this.state !== "idle") return;
    this.setState("starting");
    try {
      this.conversation = {
        id: nanoid(),
        startedAt: Date.now(),
        placeId: this.deps.placeId,
        eventId: this.deps.eventId,
        personIds: [],
        speakerMap: {},
      };
      await db().conversations.add(this.conversation);

      this.segmentCount = 0;
      this.lastResetAt = Date.now();
      this.dropped = 0;

      const vad = new SileroVAD();
      await vad.start();
      vad.onSpeechStart(() => this.setState("speech"));
      vad.onSegment((segment) => {
        this.handleSegment(segment).catch((err) => this.emitError(err));
      });
      vad.onMisfire(() => this.setState("listening"));
      this.vad = vad;

      this.setState("listening");
    } catch (err) {
      this.emitError(err);
      this.setState("idle");
    }
  }

  async stop(): Promise<void> {
    if (this.state === "idle") return;
    this.setState("stopping");
    this.pendingSuggestionAbort?.abort();
    this.pendingSuggestionAbort = null;
    this.tts.stop();
    await this.vad?.destroy();
    this.vad = null;
    if (this.conversation) {
      await db().conversations.update(this.conversation.id, { endedAt: Date.now() });
      this.conversation = null;
    }
    this.transcriptCache = [];
    this.recentSpeakers = [];
    this.setState("idle");
  }

  /**
   * Tap-to-speak. Plays TTS in James's voice and logs the suggestion as
   * "selected" so the Tier-1 style loop later sees what got chosen.
   */
  async speak(args: {
    text: string;
    category?: SuggestionCategory;
    why?: string;
    triggeringSegmentId?: string;
  }): Promise<void> {
    try {
      if (this.conversation) {
        const log: SuggestionLog = {
          id: nanoid(),
          conversationId: this.conversation.id,
          triggeringSegmentId: args.triggeringSegmentId,
          text: args.text,
          category: args.category ?? "answer",
          why: args.why,
          selected: true,
          ignored: false,
          createdAt: Date.now(),
        };
        await db().suggestionsLog.add(log);
      }
      // Self-turn appears in the transcript as "Me".
      if (this.conversation) {
        const now = Date.now();
        const segment: TranscriptSegment = {
          id: nanoid(),
          conversationId: this.conversation.id,
          speakerLabel: "self",
          speakerKind: "self",
          text: args.text,
          startedAt: now,
          endedAt: now,
          status: "final",
        };
        await db().transcriptSegments.add(segment);
        this.callbacks.onTranscriptSegment?.({
          id: segment.id,
          conversationId: this.conversation.id,
          text: args.text,
          speakerKind: "self",
          speakerLabel: "self",
          startedAt: now,
          endedAt: now,
        });
      }

      await this.tts.speak({ text: args.text, voiceId: this.deps.settings.jamesVoiceId });
    } catch (err) {
      this.emitError(err);
    }
  }

  // -----------------------------------------------------------------------

  private async handleSegment(segment: VADSegment): Promise<void> {
    // Throttle: skip if a previous segment is still being processed. The
    // user-perceived loss is small (Silero VAD's segments are full
    // utterances, and the embedder + STT round-trip is ~2 s) and it stops
    // the WASM heap from spiralling into an iPad-Safari OOM kill.
    if (this.inFlight >= LiveConversation.MAX_IN_FLIGHT) {
      this.dropped++;
      return;
    }
    this.inFlight++;
    try {
      await this.processSegment(segment);
    } finally {
      this.inFlight--;
    }

    // After processing, recycle the embedder periodically to release the
    // ORT WASM heap. We don't do this mid-segment so we never collide with
    // the throttle above.
    if (this.shouldResetEmbedder()) {
      await this.resetEmbedder();
    }
  }

  private async processSegment(segment: VADSegment): Promise<void> {
    this.setState("listening");
    const conversation = this.conversation;
    if (!conversation) return;

    const segmentId = nanoid();
    const startedAt = Date.now() - Math.round(segment.durationMs);
    const endedAt = Date.now();

    // 1. Embed + match (fast on-device path runs in parallel with STT).
    const embedder = this.deps.embedderRef.current;
    const embedAndMatch = (async () => {
      if (!embedder) return undefined;
      const embedding = await embedder.embed(segment.audio);
      const candidates = match(embedding, {
        people: this.people,
        centroidByPersonId: centroidsFromVoiceprints(this.voiceprints),
        recentSpeakers: this.recentSpeakers,
      });
      this.callbacks.onSpeakerCandidates?.(candidates);

      // Persist the segment's embedding so the Tier-2 re-cluster pipeline
      // (later) can rebuild centroids without re-recording.
      await db().segmentEmbeddings.put({
        segmentId,
        conversationId: conversation.id,
        embedding: encodeEmbedding(embedding),
        rms: rms(segment.audio),
      });

      return candidates;
    })();

    // 2. STT (remote network call, dominates latency).
    const transcribe = transcribeSegment({
      providerId: this.deps.settings.sttProvider,
      waveform16k: segment.audio,
    }).catch((err) => {
      this.emitError(err);
      return "";
    });

    const [candidates, text] = await Promise.all([embedAndMatch, transcribe]);

    this.segmentCount++;

    if (!text || text.length === 0) return;

    const top = candidates?.[0];
    const accept = this.deps.settings.speakerIdAcceptThreshold;
    const isConfirmed = !!top?.personId && (top.posterior ?? 0) >= accept;
    const personId = isConfirmed ? top!.personId! : undefined;
    const personName = isConfirmed ? this.people.find((p) => p.id === personId)?.name : undefined;

    const liveSegment: LiveTranscriptSegment = {
      id: segmentId,
      conversationId: conversation.id,
      text,
      speakerKind: "other",
      speakerLabel: personId ?? "unknown",
      personId,
      personName,
      confidence: top?.posterior,
      startedAt,
      endedAt,
    };

    const persisted: TranscriptSegment = {
      id: segmentId,
      conversationId: conversation.id,
      speakerLabel: liveSegment.speakerLabel,
      personId,
      speakerKind: "other",
      text,
      startedAt,
      endedAt,
      confidence: top?.posterior,
      status: "final",
    };
    await db().transcriptSegments.add(persisted);

    this.transcriptCache.push(liveSegment);
    if (this.transcriptCache.length > LiveConversation.TRANSCRIPT_CACHE_MAX) {
      this.transcriptCache.shift();
    }
    this.callbacks.onTranscriptSegment?.(liveSegment);

    if (isConfirmed && personId) {
      this.recentSpeakers = [
        personId,
        ...this.recentSpeakers.filter((id) => id !== personId),
      ].slice(0, 5);
    }

    void this.regenerateSuggestions(segmentId);
  }

  private shouldResetEmbedder(): boolean {
    if (this.state === "idle" || this.state === "stopping") return false;
    if (this.inFlight > 0) return false;
    const elapsed = Date.now() - this.lastResetAt;
    return (
      this.segmentCount >= LiveConversation.EMBEDDER_RESET_AFTER_N_SEGMENTS ||
      elapsed >= LiveConversation.EMBEDDER_RESET_INTERVAL_MS
    );
  }

  /**
   * Dispose the embedder's ONNX session and warm it back up. This is the
   * only reliable way to release ORT's WASM heap on iPad Safari before it
   * gets large enough for Safari to OOM-kill the tab. The user feels a
   * one-time ~30 s pause but the conversation keeps going.
   */
  private async resetEmbedder(): Promise<void> {
    const embedder = this.deps.embedderRef.current;
    if (!embedder) return;
    try {
      await embedder.dispose?.();
      await embedder.warmup?.();
    } catch (err) {
      this.emitError(err);
    } finally {
      this.segmentCount = 0;
      this.lastResetAt = Date.now();
    }
  }

  private async regenerateSuggestions(triggeringSegmentId: string): Promise<void> {
    this.pendingSuggestionAbort?.abort();
    const abort = new AbortController();
    this.pendingSuggestionAbort = abort;

    this.callbacks.onSuggestions?.([], true);

    try {
      const drafts = await this.deps.ai.generateSuggestions({
        jamesName: this.deps.jamesName,
        mood: this.mood,
        transcript: this.transcriptCache.map((t) => ({
          speaker: t.speakerKind === "self" ? this.deps.jamesName : (t.personName ?? "Other"),
          text: t.text,
        })),
      });
      if (abort.signal.aborted) return;
      this.callbacks.onSuggestions?.(drafts, false);

      // Log every shown suggestion so Tier-1 (later) can learn from which
      // ones get tapped vs ignored.
      if (this.conversation) {
        const now = Date.now();
        const logs: SuggestionLog[] = drafts.map((d) => ({
          id: nanoid(),
          conversationId: this.conversation!.id,
          triggeringSegmentId,
          text: d.text,
          category: d.category,
          why: d.why,
          selected: false,
          ignored: false,
          createdAt: now,
        }));
        await db().suggestionsLog.bulkAdd(logs);
      }
    } catch (err) {
      if (!abort.signal.aborted) {
        this.callbacks.onSuggestions?.([], false);
        this.emitError(err);
      }
    }
  }

  private setState(state: ConversationState): void {
    if (this.state === state) return;
    this.state = state;
    this.callbacks.onStateChange?.(state);
  }

  private emitError(err: unknown): void {
    const e = err instanceof Error ? err : new Error(String(err));
    this.callbacks.onError?.(e);
  }
}
