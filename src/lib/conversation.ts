import { nanoid } from "nanoid";

import {
  db,
  type Conversation,
  type JamesProfile,
  type Person,
  type SettingsRecord,
  type SuggestionCategory,
  type SuggestionLog,
  type TranscriptSegment,
  type Voiceprint,
} from "@/lib/db";
import { SileroVAD, type VADSegment } from "@/lib/audio/vad";
import { centroidsFromVoiceprints, match, type Candidate } from "@/lib/audio/matcher";
import { cosine, decodeEmbedding, encodeEmbedding, l2Normalize, rms } from "@/lib/audio/utils";
import { transcribeSegment } from "@/lib/audio/stt";
import type { SpeakerEmbedder } from "@/lib/audio/embedder";
import { setLastSegment } from "@/lib/audio/last-segment-store";
import { transcribeSegmentStreaming } from "@/lib/audio/stt-streaming";
import { TTSPlayer } from "@/lib/audio/tts-player";
import { speakText } from "@/lib/audio/speak-text";
import type { DomainAI, Mood, SuggestionDraft } from "@/lib/ai";
import { makeTTS } from "@/lib/providers";
import { enqueueJob } from "@/lib/jobs/drain";
import { buildKeyterms } from "@/lib/learning/keyterms";
import {
  getCrossSessionDeadPhrases,
  getStyleEvidence,
  type PerPersonCategoryHints,
} from "@/lib/learning/style-evidence";
import { applyDeadPhraseFilter } from "@/lib/learning/dead-phrase-filter";
import { repairNames } from "@/lib/audio/transcript-repair";
import { retrieveMemories } from "@/lib/learning/retrieval";
import type { StyleProfile, Memory } from "@/lib/db";

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
  /**
   * Fired when an existing transcript segment is mutated in place — used
   * by the tap-to-reassign repair flow. The append-only onTranscriptSegment
   * callback can't carry edits because the cockpit's transcript state is
   * keyed by segment id and won't dedupe. Callers should map over their
   * cached transcript and replace by id.
   */
  onTranscriptSegmentUpdated?: (segment: LiveTranscriptSegment) => void;
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
  /**
   * "partial" while streaming STT is still committing the text, "final"
   * once it's locked. The cockpit renders partial lines in italics. The
   * final transcript callback replaces the partial line in place via
   * onTranscriptSegmentUpdated, keyed by id.
   */
  status?: "partial" | "final";
};

export type ConversationDeps = {
  embedderRef: { current: SpeakerEmbedder | null };
  ai: DomainAI;
  settings: SettingsRecord;
  jamesName: string;
  /** Full James persona for the suggestion prompt persona block.
   * Cached at construction so the cockpit doesn't re-query per turn. */
  jamesProfile?: JamesProfile;
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
  /**
   * Closed-set roster declared at start. Null = open match against every
   * enrolled person. When populated, the matcher only scores against the
   * declared set + "Unknown".
   */
  private closedSet: string[] | null = null;
  private placePersonIds: string[] | null = null;
  private eventPersonIds: string[] | null = null;
  private placeName: string | null = null;
  private eventName: string | null = null;
  private eventKeyInfo: string | null = null;

  /**
   * Cached Scribe `keyterms` list for this conversation. Rebuilt at start()
   * and whenever the roster / closed-set changes mid-conversation. Empty
   * outside of an active session.
   */
  private keyTerms: string[] = [];

  /**
   * Tier-1 + Tier-2 state cached at start(). The style profile + dead
   * phrases + per-person category hints all read from Dexie tables that
   * only change between conversations, so we hit the DB once at start and
   * pass the cached values into every regenerateSuggestions call. The
   * dead-phrase keys are pre-normalised so the per-turn post-filter
   * doesn't redo the work.
   */
  private styleProfile: StyleProfile | null = null;
  private deadPhrases: string[] = [];
  private perPersonHints: Map<string, PerPersonCategoryHints> = new Map();

  /**
   * Top-K memories cached from the PREVIOUS turn's retrieval. Keeping them
   * here means the per-turn suggestion prompt reads a field (no await)
   * instead of blocking on an OpenAI embedding round-trip — that RTT used
   * to sit serially in front of generateSuggestions, adding ~150–400 ms to
   * every turn's latency. We refresh this in the background after kicking
   * off each turn, so memories are at most one turn stale (fine for
   * relevance) and never on the critical path.
   */
  private retrievedMemories: Memory[] = [];
  private memoryRefreshInFlight = false;

  /**
   * If true, the next incoming VAD segment should be labelled "Unknown"
   * regardless of similarity — used by the SpeakerColumn "New" button when
   * James knows the next utterance is a new person the matcher would
   * otherwise force-fit onto an existing cluster.
   */
  private forceNextSegmentNewCluster = false;

  /**
   * If set, the next incoming segment(s) up to a 20 s timeout are held
   * for manual confirmation rather than auto-assigned. Used by the
   * "Ask" button — when James asks the room "Sorry, who am I speaking
   * with?", the response should not be force-attributed to the cluster
   * that was guessed pre-introduction. Cluster-scoped (legacy used a
   * global flag, which fragile in multi-party rooms).
   */
  private awaitingIntroductionForCluster: string | null = null;
  private awaitingIntroductionUntil = 0;

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
  // Tighter than before — the previous run was still hitting the OOM eviction
  // every ~2 min, which means activations were accumulating between resets.
  // With a real model.dispose() releasing the ORT session, resetting more
  // often is cheap (model files stay in the browser cache, so re-warm is
  // ~5–10 s, not the original ~30 s).
  private static readonly EMBEDDER_RESET_AFTER_N_SEGMENTS = 12;
  private static readonly EMBEDDER_RESET_INTERVAL_MS = 90 * 1000;
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
    // Mid-conversation roster changes (e.g. someone newly enrolled while the
    // mic is live) should grow the keyterm list. Fire and forget so the
    // setter stays synchronous.
    if (this.state !== "idle" && this.state !== "stopping") {
      void this.refreshKeyterms();
    }
  }

  /**
   * Update the active place/event before start(). The cockpit's
   * pre-Record pickers re-render but don't rebuild this LiveConversation,
   * so without this we'd read stale deps that were captured at construction.
   * Safe to call mid-recording, but only the next start() actually reads
   * the values — mid-conversation place changes are out of scope.
   */
  setSession(args: { placeId?: string; eventId?: string }): void {
    this.deps = { ...this.deps, placeId: args.placeId, eventId: args.eventId };
  }

  /** Live-update the James persona block. Picked up by the next
   * regenerateSuggestions; cache-key churn is acceptable since profile
   * edits are rare and the user changing them wants the update visible. */
  setJamesProfile(profile: JamesProfile | undefined): void {
    // Patch jamesName too — it's captured once at construction from the
    // profile's displayName, so a rename in Settings would otherwise leave
    // the transcript "Me" label and every prompt's jamesName stuck on the
    // old value for the life of this instance.
    this.deps = {
      ...this.deps,
      jamesProfile: profile,
      jamesName: profile?.displayName || this.deps.jamesName,
    };
    if (this.state !== "idle" && this.state !== "stopping") {
      void this.refreshKeyterms();
    }
  }

  /**
   * Declare the closed-set roster for this conversation. Called pre-Record
   * by the cockpit. Pass null to open the match back up to everyone enrolled.
   */
  setClosedSet(personIds: string[] | null): void {
    this.closedSet = personIds && personIds.length > 0 ? [...personIds] : null;
    if (this.state !== "idle" && this.state !== "stopping") {
      void this.refreshKeyterms();
    }
  }

  /**
   * Insert a person into the active closed set without restarting the
   * conversation. Used by the mid-conversation "Add to roster" chip when
   * someone walks in late — closing the conversation to re-pick would
   * cost the embedder warmup and the running diarization state.
   */
  addToRoster(personId: string): void {
    if (this.closedSet === null) return;
    if (this.closedSet.includes(personId)) return;
    this.closedSet = [...this.closedSet, personId];
    void this.refreshKeyterms();
  }

  getClosedSet(): string[] | null {
    return this.closedSet ? [...this.closedSet] : null;
  }

  /**
   * Force the next incoming utterance to be labelled Unknown, ignoring
   * the matcher's best guess. Cleared after the next segment lands.
   */
  forceNewClusterNextSegment(): void {
    this.forceNextSegmentNewCluster = true;
  }

  /**
   * Id of the most-recent "other"-speaker transcript segment, used by the
   * SpeakerPanel's per-row Confirm / Not-them buttons. Returns null if the
   * cache is empty or the most recent segment is James himself.
   *
   * Ported from claude/tier3-engine-wins so the SpeakerPanel can re-attribute
   * the borderline-suggested top guess with a single tap.
   */
  getLastOtherSegmentId(): string | null {
    for (let i = this.transcriptCache.length - 1; i >= 0; i--) {
      const s = this.transcriptCache[i];
      if (s.speakerKind === "other") return s.id;
    }
    return null;
  }

  /**
   * Manual "Refresh" trigger for the Suggestions panel. Pretends the most
   * recent other-speaker segment just landed and re-runs the suggestion
   * pipeline against the current state of the conversation. Useful when
   * James wants a different set of cards without waiting for the next
   * turn. No-op if the conversation isn't live or no other-speaker
   * segment has been seen.
   */
  async requestNewSuggestions(): Promise<void> {
    if (this.state !== "listening" && this.state !== "speech") return;
    const segId = this.getLastOtherSegmentId();
    if (!segId) return;
    await this.regenerateSuggestions(segId);
  }

  /**
   * Speak the "Sorry, who am I speaking with?" phrase and hold subsequent
   * segments for manual confirmation. Held segments are still written to
   * the transcript so James can see the response text, but the speaker
   * attribution is left as "Unknown" until he taps reassign.
   *
   * Cluster scope: bound to the cluster that was just guessed (so a multi-
   * party "go on, Jack, tell him your name" doesn't get force-attributed to
   * Mum). 20 s timeout so a forgotten Ask doesn't permanently disable
   * matcher decisions.
   */
  async askWhoIsThis(args: { aboutCluster?: string; voiceId?: string }): Promise<void> {
    this.awaitingIntroductionForCluster = args.aboutCluster ?? "any";
    this.awaitingIntroductionUntil = Date.now() + 20_000;
    try {
      await this.tts.speak({
        text: "Sorry, who am I speaking with?",
        voiceId: args.voiceId,
      });
    } catch (err) {
      this.emitError(err);
    }
  }

  clearAwaitingIntroduction(): void {
    this.awaitingIntroductionForCluster = null;
    this.awaitingIntroductionUntil = 0;
  }

  /**
   * Re-attribute a transcript segment to a different person. Mutates the
   * Dexie row, updates the in-memory transcript cache, fires the
   * onTranscriptSegmentUpdated callback so the cockpit can repaint, and
   * folds the segment's stored embedding into the new person's centroid
   * via `enrollSample` so the matcher gets smarter over time.
   *
   * If `personId` is null the segment is reverted to Unknown.
   */
  async reassignSegment(segmentId: string, personId: string | null): Promise<void> {
    const conv = this.conversation;
    if (!conv) return;
    const row = await db().transcriptSegments.get(segmentId);
    if (!row) return;

    const person = personId ? this.people.find((p) => p.id === personId) : null;
    const updates: Partial<TranscriptSegment> = {
      personId: person?.id,
      speakerLabel: person?.id ?? "unknown",
    };
    await db().transcriptSegments.update(segmentId, updates);

    // Update the in-memory cache so subsequent suggestion-generation calls
    // see the corrected attribution.
    this.transcriptCache = this.transcriptCache.map((s) =>
      s.id === segmentId
        ? {
            ...s,
            personId: person?.id,
            personName: person?.name,
            speakerLabel: person?.id ?? "unknown",
          }
        : s,
    );

    // Refresh the speakerMap so the cockpit's display stays in sync.
    if (person) {
      conv.speakerMap = { ...conv.speakerMap, [segmentId]: person.id };
      await db().conversations.update(conv.id, { speakerMap: conv.speakerMap });
    }

    // Fold the segment's embedding into the chosen person's voiceprint so
    // the matcher learns from the correction. Soft-fail if the embedding
    // wasn't stored (Tier-2 will catch up later).
    if (person) {
      try {
        const stored = await db().segmentEmbeddings.get(segmentId);
        if (stored) {
          await this.foldEmbeddingIntoPerson(person.id, stored.embedding, segmentId);
        }
      } catch (err) {
        console.warn("[conversation] reassign fold failed", err);
      }
    }

    this.callbacks.onTranscriptSegmentUpdated?.({
      id: row.id,
      conversationId: row.conversationId,
      text: row.text,
      speakerKind: "other",
      speakerLabel: person?.id ?? "unknown",
      personId: person?.id,
      personName: person?.name,
      confidence: row.confidence,
      startedAt: row.startedAt,
      endedAt: row.endedAt,
    });
  }

  /**
   * Collapse one cluster into another. All transcript segments that
   * belong to `fromPersonId` (or carry the synthetic `unknown` label
   * matching `fromLabel`) get re-attributed to `toPersonId`. Used when
   * Silero VAD splits a single person into two clusters mid-conversation.
   */
  async mergeCluster(args: {
    fromPersonId?: string;
    fromLabel?: string;
    toPersonId: string;
  }): Promise<void> {
    const conv = this.conversation;
    if (!conv) return;
    const toPerson = this.people.find((p) => p.id === args.toPersonId);
    if (!toPerson) return;
    const candidates = await db()
      .transcriptSegments.where("conversationId")
      .equals(conv.id)
      .toArray();
    const targets = candidates.filter((s) => {
      if (args.fromPersonId && s.personId === args.fromPersonId) return true;
      if (args.fromLabel && s.speakerLabel === args.fromLabel) return true;
      return false;
    });
    for (const seg of targets) {
      await this.reassignSegment(seg.id, args.toPersonId);
    }
  }

  /** Fold a stored embedding into the given person's voiceprint. */
  private async foldEmbeddingIntoPerson(
    personId: string,
    encodedEmbedding: string,
    sourceSegmentId: string,
  ): Promise<void> {
    const embedding = decodeEmbedding(encodedEmbedding);
    const existing = await db().voiceprints.get(personId);
    if (!existing) {
      await db().voiceprints.put({
        personId,
        centroid: encodedEmbedding,
        sampleCount: 1,
        updatedAt: Date.now(),
      });
      return;
    }

    // Guard against a clearly-noisy correction: if the new sample is wildly
    // dissimilar from the existing centroid (cosine < 0.5 — same threshold
    // as the single-enrollee fallback minus a bit of slack), refuse to fold.
    // James's wrong tap shouldn't poison the centroid permanently.
    const prev = decodeEmbedding(existing.centroid);
    const sim = cosine(prev, embedding);
    if (sim < 0.5) {
      console.warn(
        `[conversation] refusing to fold low-similarity reassignment (sim=${sim.toFixed(2)}) into ${personId} from segment ${sourceSegmentId}`,
      );
      return;
    }

    const n = existing.sampleCount;
    const dim = Math.min(prev.length, embedding.length);
    const next = new Float32Array(dim);
    for (let i = 0; i < dim; i++) {
      next[i] = (prev[i] * n + embedding[i]) / (n + 1);
    }
    const normalized = l2Normalize(next);
    await db().voiceprints.put({
      personId,
      centroid: encodeEmbedding(normalized),
      sampleCount: n + 1,
      confidence: existing.confidence,
      subCentroids: existing.subCentroids,
      updatedAt: Date.now(),
    });
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
        personIds: this.closedSet ? [...this.closedSet] : [],
        speakerMap: {},
      };
      await db().conversations.add(this.conversation);

      // Resolve place/event personIds for the speaker-ID prior AND cache
      // their display names for the suggestion prompt. Both are optional;
      // missing rows leave the prior unboosted and the prompt context-free.
      this.placePersonIds = null;
      this.eventPersonIds = null;
      this.placeName = null;
      this.eventName = null;
      this.eventKeyInfo = null;
      if (this.deps.placeId) {
        try {
          const place = await db().places.get(this.deps.placeId);
          this.placePersonIds = place?.personIds ?? null;
          this.placeName = place?.name ?? null;
        } catch (err) {
          console.warn("[conversation] place lookup failed", err);
        }
      }
      if (this.deps.eventId) {
        try {
          const event = await db().events.get(this.deps.eventId);
          this.eventPersonIds = event?.personIds ?? null;
          this.eventName = event?.name ?? null;
          this.eventKeyInfo = event?.keyInfo ?? null;
        } catch (err) {
          console.warn("[conversation] event lookup failed", err);
        }
      }

      // Build the Scribe keyterm list from the active context. We do this
      // after the place/event lookup so place + event names land in the
      // tier-3 boost.
      await this.refreshKeyterms();

      // Tier-1 style + dead-phrase cache. Best-effort — if the tables are
      // empty (cold start), we just pass undefined and the model falls
      // back to its baseline persona. Failures here never block the
      // conversation start.
      await this.refreshStyleCache();

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
      const conversationId = this.conversation.id;
      const hadSegments = this.transcriptCache.length > 0;
      await db().conversations.update(conversationId, { endedAt: Date.now() });
      // Queue Tier-2 jobs durably (Dexie write completes synchronously in the
      // teardown window) so they survive a tab close before the drainer runs.
      // The drainer fires on next app mount, or immediately if the cockpit
      // route stays mounted. Skip if the conversation was empty — nothing
      // meaningful to summarise.
      if (hadSegments) {
        // Drainer runs jobs in insertion order. We want rediarize +
        // rebuildVoiceprints to land FIRST so the downstream enrich /
        // detectIntroductions / extractMemories calls all read the
        // hindsight-corrected personIds. summariseConversation can sit
        // before rediarize because the summary's value to the user
        // (showing up quickly in Recent) outweighs label correctness for
        // the summary text — the personId in the transcript itself is what
        // rediarize fixes, not the prose summary. updateLexicon runs after
        // rediarize so per-person term extraction sees the corrected
        // attribution.
        await enqueueJob({ type: "summariseConversation", conversationId });
        // The Tier-2 chain only makes sense when ≥ 1 other person
        // contributed — single-person calls have nothing to rediarize or
        // enrich. Self-only "conversations" (typing-only sessions) skip the
        // whole chain.
        const otherPersonCount = new Set(
          this.transcriptCache
            .filter((s) => s.speakerKind === "other" && s.personId)
            .map((s) => s.personId),
        ).size;
        if (otherPersonCount >= 1 && this.transcriptCache.length >= 6) {
          await enqueueJob({ type: "rediarize", conversationId });
          await enqueueJob({ type: "rebuildVoiceprints", conversationId });
        }
        if (this.people.length > 0) {
          await enqueueJob({ type: "updateLexicon", conversationId });
        }
        if (otherPersonCount >= 1 && this.transcriptCache.length >= 6) {
          await enqueueJob({ type: "enrichProfiles", conversationId });
          await enqueueJob({ type: "detectIntroductions", conversationId });
          await enqueueJob({ type: "extractMemories", conversationId });
        }
      }
      this.conversation = null;
    }
    this.transcriptCache = [];
    this.recentSpeakers = [];
    this.placePersonIds = null;
    this.eventPersonIds = null;
    this.placeName = null;
    this.eventName = null;
    this.eventKeyInfo = null;
    this.keyTerms = [];
    this.styleProfile = null;
    this.deadPhrases = [];
    this.perPersonHints = new Map();
    this.retrievedMemories = [];
    // Keep closedSet — the picker is a pre-Record control; the cockpit
    // resets it explicitly when the user reopens the picker.
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
        const trigger = args.triggeringSegmentId
          ? this.transcriptCache.find((t) => t.id === args.triggeringSegmentId)
          : undefined;
        const log: SuggestionLog = {
          id: nanoid(),
          conversationId: this.conversation.id,
          triggeringSegmentId: args.triggeringSegmentId,
          personId: trigger?.personId,
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

      // Route the actual audio through the cache-first speakText path —
      // NOT this.tts (TTSPlayer), which always pays full network + synth
      // latency and goes silent with no network. speakText plays a pre-
      // cached quick-phrase clip instantly when the text matches one of the
      // five canned phrases, so "Yes"/"No"/"Wait" are zero-latency even
      // mid-conversation. The Dexie logging above is the only thing
      // LiveConversation.speak adds over the standalone path.
      await speakText({
        text: args.text,
        voiceId: this.deps.settings.jamesVoiceId,
        ttsProvider: this.deps.settings.ttsProvider,
      });
    } catch (err) {
      this.emitError(err);
    }
  }

  // -----------------------------------------------------------------------

  private async handleSegment(segment: VADSegment): Promise<void> {
    // Always remember the most recent segment audio so James can hit the
    // "What did they say?" Replay button. This is the only place the store
    // gets updated; the in-flight throttle below would skip the dropped
    // segments otherwise.
    setLastSegment({
      audio: segment.audio,
      sampleRate: 16000,
      durationMs: segment.durationMs,
      capturedAt: Date.now(),
    });

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
        closedSet: this.closedSet ?? undefined,
        placePersonIds: this.placePersonIds ?? undefined,
        eventPersonIds: this.eventPersonIds ?? undefined,
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
    // Streaming path first: partial transcripts land ~300 ms after speech
    // start, so the cockpit can paint the transcript line in italics while
    // we wait for final. On any failure (auth, network, no streaming
    // entitlement on the account) fall back to the batch REST proxy so
    // James still gets a transcript — just a slower one.
    const transcribe = (async (): Promise<string> => {
      const keyTerms = this.keyTerms.length > 0 ? this.keyTerms : undefined;
      if (this.deps.settings.sttProvider !== "elevenlabs-scribe") {
        return transcribeSegment({
          providerId: this.deps.settings.sttProvider,
          waveform16k: segment.audio,
          keyTerms,
        }).catch((err) => {
          this.emitError(err);
          return "";
        });
      }
      try {
        return await transcribeSegmentStreaming({
          waveform16k: segment.audio,
          callbacks: {
            onPartial: (partial) => {
              this.emitPartialTranscript({
                segmentId,
                conversationId: conversation.id,
                text: partial,
                startedAt,
                endedAt,
              });
            },
          },
          options: { keyTerms },
        });
      } catch (err) {
        console.warn("[conversation] streaming STT failed, falling back to batch", err);
        return transcribeSegment({
          providerId: this.deps.settings.sttProvider,
          waveform16k: segment.audio,
          keyTerms,
        }).catch((batchErr) => {
          this.emitError(batchErr);
          return "";
        });
      }
    })();

    const [candidates, rawText] = await Promise.all([embedAndMatch, transcribe]);

    this.segmentCount++;

    if (!rawText || rawText.length === 0) return;

    // T2 client-side fuzzy name repair. T1 keyterms already bias Scribe;
    // this catches the residual misses ("Jacques" → "Jack"). Pure string
    // in/string out — no DB write yet (TranscriptSegment.text stores the
    // repaired version directly so the LLM and the suggestion log both
    // see the corrected form).
    const text = repairNames(rawText, {
      roster: this.people,
      jamesName: this.deps.jamesName,
    });

    const top = candidates?.[0];
    const accept = this.deps.settings.speakerIdAcceptThreshold;

    // Repair-flow overrides: the cockpit can ask us to ignore the matcher
    // for the next segment (the "New" button) or to suspend confirmation
    // entirely until James manually picks (the "Ask" flow). Both keep the
    // transcript line visible — just mark the speaker as Unknown so the
    // user has to repair it explicitly.
    const askInWindow =
      this.awaitingIntroductionForCluster !== null && Date.now() < this.awaitingIntroductionUntil;
    if (this.awaitingIntroductionForCluster !== null && !askInWindow) {
      // Window timed out without a tap; release the hold.
      this.clearAwaitingIntroduction();
    }
    const suppressMatch = this.forceNextSegmentNewCluster || askInWindow;
    if (this.forceNextSegmentNewCluster) {
      this.forceNextSegmentNewCluster = false;
    }

    const isConfirmed = !suppressMatch && !!top?.personId && (top.posterior ?? 0) >= accept;
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
      status: "final",
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
   * Dispose the embedder's ONNX session and warm it back up. With the
   * worker-backed embedder, dispose() calls worker.terminate() which is
   * the only reliable way to release ORT's WASM heap on iPad Safari. The
   * next embed() call lazily spins a new worker; warmup is fire-and-
   * forget so the main thread never blocks. The previous main-thread
   * implementation paused the cockpit for 5–10 s every 12 segments.
   */
  private async resetEmbedder(): Promise<void> {
    const embedder = this.deps.embedderRef.current;
    if (!embedder) return;
    try {
      await embedder.dispose?.();
      // Don't await warmup — let the worker re-instantiate lazily on the
      // next embed call. If warmup throws, surface it via emitError so the
      // operator sees it, but never block the conversation loop.
      void embedder.warmup?.().catch((err) => this.emitError(err));
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
      // Stream incrementally so the first card lands at TTFT instead of
      // after the full completion. onSuggestions(drafts, true) is called
      // each time the streaming JSON parser closes another suggestion
      // object; the final non-streaming resolve fires onSuggestions(drafts,
      // false) below.
      // Build the people-in-room list. Closed-set wins (it's the user's
      // declared intent); fall back to whoever's actually been confirmed
      // in the transcript so the prompt still has names to anchor against
      // when the user opted not to pre-pick a roster.
      const peopleNames = this.buildPeopleNamesForPrompt();
      const activePersonIds = this.buildActivePersonIds();

      // Per-person category-preference distribution. Only emit hints for
      // people in the active roster (closed-set or live-confirmed) so the
      // prompt isn't padded with irrelevant rows. Names are the key the
      // model can match against.
      const categoryHints = new Map<string, PerPersonCategoryHints>();
      for (const personId of activePersonIds) {
        const hint = this.perPersonHints.get(personId);
        const person = this.people.find((p) => p.id === personId);
        if (hint && person) categoryHints.set(person.name, hint);
      }

      // Top-K semantic memory retrieval — bias the prompt toward things
      // James has said or learned about the people in the room. Read the
      // memories cached from the PREVIOUS turn (no await — the OpenAI embed
      // RTT must never sit on the critical path) and kick off a background
      // refresh for the next turn. One-turn-stale memories are fine for
      // relevance; an empty cache on the first turn just means no memory
      // bias yet.
      const memories = this.retrievedMemories;
      void this.refreshMemories(activePersonIds);
      if (abort.signal.aborted) return;

      const drafts = await this.deps.ai.generateSuggestions(
        {
          jamesName: this.deps.jamesName,
          mood: this.mood,
          transcript: this.transcriptCache.map((t) => ({
            speaker: t.speakerKind === "self" ? this.deps.jamesName : (t.personName ?? "Other"),
            text: t.text,
          })),
          peopleNames: peopleNames.length > 0 ? peopleNames : undefined,
          placeName: this.placeName ?? undefined,
          event: this.eventName
            ? { name: this.eventName, keyInfo: this.eventKeyInfo ?? undefined }
            : undefined,
          jamesProfile: this.deps.jamesProfile,
          styleProfile: this.styleProfile ?? undefined,
          deadPhrases: this.deadPhrases.length > 0 ? this.deadPhrases : undefined,
          categoryHints: categoryHints.size > 0 ? categoryHints : undefined,
          memories: memories.length > 0 ? memories : undefined,
        },
        (partial) => {
          if (abort.signal.aborted) return;
          // Run partial drafts through the dead-phrase filter too so the
          // UI never momentarily shows a banned phrase before the final
          // pass drops it. Top-up is cheap; the user only sees a stable
          // grid.
          const filtered = applyDeadPhraseFilter({
            drafts: partial,
            deadPhrases: this.deadPhrases,
          }).drafts;
          this.callbacks.onSuggestions?.(filtered, true);
        },
      );
      if (abort.signal.aborted) return;
      // Final pass — the model occasionally still emits a dead phrase
      // despite the system-prompt hint; this is the safety net.
      const filtered = applyDeadPhraseFilter({
        drafts,
        deadPhrases: this.deadPhrases,
      }).drafts;
      this.callbacks.onSuggestions?.(filtered, false);

      // Log every SHOWN suggestion (after dead-phrase filtering) so
      // Tier-1 learns from what the cockpit actually rendered, not what
      // the model spat out before suppression.
      if (this.conversation) {
        const now = Date.now();
        // Resolve the triggering segment's personId so the per-person
        // category-preference tally has someone to attribute to. Without
        // this, every row goes into the global bucket and the per-person
        // hint loop never fires.
        const trigger = this.transcriptCache.find((t) => t.id === triggeringSegmentId);
        const triggerPersonId = trigger?.personId;
        const logs: SuggestionLog[] = filtered.map((d) => ({
          id: nanoid(),
          conversationId: this.conversation!.id,
          triggeringSegmentId,
          personId: triggerPersonId,
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

  /**
   * Surface a streaming partial transcript line to the cockpit. The route
   * dedupes by segment id, so repeated partials for the same segment
   * replace the previous in place and the final transcript replaces them
   * all when STT commits.
   */
  private emitPartialTranscript(args: {
    segmentId: string;
    conversationId: string;
    text: string;
    startedAt: number;
    endedAt: number;
  }): void {
    const partial: LiveTranscriptSegment = {
      id: args.segmentId,
      conversationId: args.conversationId,
      text: args.text,
      speakerKind: "other",
      speakerLabel: "unknown",
      startedAt: args.startedAt,
      endedAt: args.endedAt,
      // partial flag carried as a discriminator on the live segment so the
      // cockpit can render the text in italics until the final lands.
      status: "partial",
    };
    // Both callbacks present: append the partial if it's new, update in
    // place if it isn't. The route's onTranscriptSegmentUpdated handler
    // covers the second case.
    this.callbacks.onTranscriptSegment?.(partial);
    this.callbacks.onTranscriptSegmentUpdated?.(partial);
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

  /**
   * Rebuild the cached Scribe keyterm list from the current roster, James
   * profile, and active place/event. Safe to call repeatedly — short of a
   * very large lexicon table the build cost is sub-millisecond. Soft-fails
   * to an empty list so a transient Dexie hiccup never blocks transcription.
   */
  private async refreshKeyterms(): Promise<void> {
    try {
      const rosterPeople = this.closedSet
        ? this.people.filter((p) => this.closedSet!.includes(p.id))
        : this.people;
      this.keyTerms = await buildKeyterms({
        people: rosterPeople,
        jamesProfile: this.deps.jamesProfile,
        placeId: this.deps.placeId,
        eventId: this.deps.eventId,
      });
    } catch (err) {
      console.warn("[conversation] buildKeyterms failed; continuing without bias", err);
      this.keyTerms = [];
    }
  }

  /**
   * Load the Tier-1 learning artefacts for this session. Style profile +
   * per-person category preferences come from past `suggestionsLog` rows;
   * dead phrases come from things James has consistently ignored.
   * Thresholds read from settings so the user can tune them in the
   * System tab. All best-effort — empty tables / hiccups degrade to no
   * learning rather than blocking the conversation.
   */
  private async refreshStyleCache(): Promise<void> {
    try {
      const settings = this.deps.settings;
      const [profile, evidence, dead] = await Promise.all([
        db().styleProfile.get("singleton"),
        getStyleEvidence({ windowDays: 30 }),
        getCrossSessionDeadPhrases({
          shownTimes: settings.deadPhraseShownTimes,
          windowDays: settings.deadPhraseWindowDays,
        }),
      ]);
      this.styleProfile = profile ?? null;
      this.perPersonHints = evidence.perPerson;
      this.deadPhrases = dead;
    } catch (err) {
      console.warn("[conversation] style cache load failed; continuing without", err);
      this.styleProfile = null;
      this.perPersonHints = new Map();
      this.deadPhrases = [];
    }
  }

  /**
   * Background top-K memory refresh. Runs OFF the suggestion critical path:
   * the prompt reads `this.retrievedMemories` (last turn's result) while
   * this updates it for the next turn. Single-flight so overlapping turns
   * don't fire redundant embedding calls. Best-effort — a failed embed
   * proxy leaves the prior memories in place rather than clearing them.
   */
  private async refreshMemories(activePersonIds: string[]): Promise<void> {
    if (this.memoryRefreshInFlight) return;
    if (activePersonIds.length === 0 && !this.deps.placeId) {
      this.retrievedMemories = [];
      return;
    }
    this.memoryRefreshInFlight = true;
    try {
      const retrieved = await retrieveMemories({
        personIds: activePersonIds,
        placeId: this.deps.placeId,
        recentTurns: this.transcriptCache.slice(-3).map((t) => ({
          speaker: t.speakerKind === "self" ? this.deps.jamesName : (t.personName ?? "Other"),
          text: t.text,
        })),
      });
      this.retrievedMemories = retrieved.map((r) => r.memory);
    } catch (err) {
      console.warn("[conversation] memory retrieval failed; keeping prior", err);
    } finally {
      this.memoryRefreshInFlight = false;
    }
  }

  /**
   * Returns the personIds that should be treated as "active" for prompt
   * context + retrieval. Closed-set wins; otherwise gather from confirmed
   * transcript segments. Used by category hints + memory retrieval.
   */
  private buildActivePersonIds(): string[] {
    if (this.closedSet && this.closedSet.length > 0) return [...this.closedSet];
    const seen = new Set<string>();
    for (const seg of this.transcriptCache) {
      if (seg.speakerKind !== "other") continue;
      if (!seg.personId) continue;
      seen.add(seg.personId);
    }
    return Array.from(seen);
  }

  /**
   * Build the "people in the room" list for the suggestion prompt. Closed
   * set is authoritative when present (it's the user's declared intent).
   * Otherwise gather the personIds the matcher has confirmed in this
   * conversation so far — better than no names at all on an open match.
   * Dedupes against `this.people` so we never emit an id we don't have a
   * name for.
   */
  private buildPeopleNamesForPrompt(): string[] {
    const idToName = new Map(this.people.map((p) => [p.id, p.name]));
    if (this.closedSet && this.closedSet.length > 0) {
      return this.closedSet.map((id) => idToName.get(id) ?? "").filter((n) => n.length > 0);
    }
    const seen = new Set<string>();
    for (const seg of this.transcriptCache) {
      if (seg.speakerKind !== "other") continue;
      if (!seg.personId) continue;
      const name = idToName.get(seg.personId);
      if (name && !seen.has(name)) seen.add(name);
    }
    return Array.from(seen);
  }
}
