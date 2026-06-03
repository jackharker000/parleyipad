import Dexie, { type EntityTable } from "dexie";

/**
 * Parley local-first database. Single user, single iPad, single schema version.
 * Every record is owned by James. No tenant column, no soft-delete graveyard,
 * no migration sprawl. The full v1 shape is laid down here in one go — adapted
 * from the prototype's db.ts (Parley_Design_Brief.pdf §7.6) but with the
 * Tier-2 MFCC slots replaced by ECAPA embedding slots.
 *
 * To change the schema during the rebuild: nuke the IndexedDB and re-seed.
 * Cheap because we're single-user. We'll graduate to real migrations once v1
 * ships.
 */

// --------------------------------------------------------------------------
// Provider settings
// --------------------------------------------------------------------------

export type LLMProviderId = "anthropic" | "openai";
export type STTProviderId = "elevenlabs-scribe";
export type TTSProviderId = "elevenlabs-flash" | "cartesia-sonic";

export type SuggestionCategory =
  | "answer"
  | "question"
  | "followup"
  | "planned"
  | "humor"
  | "clarify"
  | "give-me-a-moment";

export const SUGGESTION_CATEGORIES: readonly SuggestionCategory[] = [
  "answer",
  "question",
  "followup",
  "planned",
  "humor",
  "clarify",
  "give-me-a-moment",
] as const;

// --------------------------------------------------------------------------
// People + voiceprints
// --------------------------------------------------------------------------

export type Person = {
  id: string;
  name: string;
  relationship?: string;
  interests?: string[];
  notes?: string;
  styleNotes?: string;
  topicsLoved?: string[];
  topicsAvoided?: string[];
  /** "active" = curated by James; "auto" = AI-proposed, awaiting confirmation. */
  status: "active" | "auto" | "archived";
  /** Auto-enriched freeform notes about the James↔person dynamic. */
  relationshipDynamics?: string;
  /** Constrained tags like "teases", "interrupts". */
  dynamicTags?: string[];
  createdAt: number;
  updatedAt: number;
};

/**
 * One row per enrolled person, holding the centroid the matcher reads at
 * runtime. Updated incrementally as new contributions land via
 * `recordVoiceprintContribution`.
 */
export type Voiceprint = {
  /** Same as Person.id — one voiceprint per person. */
  personId: string;
  /** L2-normalized ECAPA-TDNN centroid, base64-encoded float32. */
  centroid: string;
  /** Total contributions folded into the centroid. */
  sampleCount: number;
  /** Confidence score 0..1 from post-conversation re-clustering. */
  confidence?: number;
  /** Optional sub-centroids when k-means finds 2 modes (e.g. neutral vs animated). */
  subCentroids?: string[];
  updatedAt: number;
};

/**
 * One row per individual enrollment / live capture that fed into a centroid.
 * Kept so we can re-cluster from raw embeddings without re-recording.
 */
export type VoiceprintContribution = {
  id: string;
  personId: string;
  /** L2-normalized ECAPA-TDNN embedding, base64-encoded float32. */
  embedding: string;
  conversationId?: string;
  /** "enrollment" = clean in-room sample; "conversation" = live-attributed or
   * intro-seed utterance; "rediarize" = derived by the Tier-2 re-diarize pass
   * (kept distinct so a re-diarize re-run can clear only its own rows). */
  source: "enrollment" | "conversation" | "rediarize";
  /** Source-utterance preview text, when known. */
  previewText?: string;
  rms: number;
  durationSec: number;
  createdAt: number;
};

// --------------------------------------------------------------------------
// Places + events
// --------------------------------------------------------------------------

export type Place = {
  id: string;
  name: string;
  lat?: number;
  lng?: number;
  /** GPS snap radius in metres. */
  radiusM?: number;
  notes?: string;
  /** People commonly present here. Multiplies the speaker-ID prior 2× for
   * each enrolled person on this list when the place is active. */
  personIds?: string[];
  createdAt: number;
  updatedAt: number;
};

export type EventRecord = {
  id: string;
  name: string;
  /** Freeform date string ("Sat 24 May, 7pm") + machine-readable when known. */
  when: string;
  start?: number;
  end?: number;
  placeId?: string;
  /** Freeform venue when no Place is selected. */
  locationFreeform?: string;
  /** Expected attendees. Biases the speaker-ID prior during the event window. */
  personIds: string[];
  /** Purpose / agenda / anything the AI should know. */
  keyInfo?: string;
  /** AI-generated talking points, selectable. */
  keyPoints?: string[];
  /** AI-generated questions, selectable. */
  keyQuestions?: string[];
  /** User-supplied steering for the prep call. */
  prepPrompt?: string;
  notes?: string;
  createdAt: number;
  updatedAt: number;
};

// --------------------------------------------------------------------------
// Conversations + transcript
// --------------------------------------------------------------------------

export type Conversation = {
  id: string;
  startedAt: number;
  endedAt?: number;
  placeId?: string;
  eventId?: string;
  /** Confirmed participants (excluding James). */
  personIds: string[];
  /** speaker_label (e.g. "S1") → personId mapping resolved during/after the call. */
  speakerMap: Record<string, string>;
  /** Post-call AI summary. */
  summary?: string;
  /** Post-call bullet highlights. */
  highlights?: string[];
};

export type TranscriptSegment = {
  id: string;
  conversationId: string;
  /** Internal cluster label assigned by the diarizer ("S1"). */
  speakerLabel: string;
  /** Resolved person; absent until matched. */
  personId?: string;
  /** "self" = James (typed or expanded). */
  speakerKind: "self" | "other";
  text: string;
  /** Wall-clock timestamps within the conversation. */
  startedAt: number;
  endedAt: number;
  /** Posterior probability the speaker is `personId`. */
  confidence?: number;
  /** "partial" while Scribe is still committing; "final" once committed. */
  status: "partial" | "final";
};

/**
 * Per-segment ECAPA embedding. Stored separately from the transcript so the
 * Tier-2 re-diarize pipeline can rebuild centroids without scanning text rows.
 */
export type SegmentEmbedding = {
  segmentId: string;
  conversationId: string;
  embedding: string;
  rms: number;
};

// --------------------------------------------------------------------------
// Suggestions
// --------------------------------------------------------------------------

export type SuggestionLog = {
  id: string;
  conversationId: string;
  /** Segment that triggered this suggestion. */
  triggeringSegmentId?: string;
  /** Speaker addressed by the suggestion. */
  personId?: string;
  text: string;
  category: SuggestionCategory;
  /** Optional rationale from the model. */
  why?: string;
  /** Did James tap it. */
  selected: boolean;
  /** If selected, did James edit before speaking. */
  editedTo?: string;
  /** Was the suggestion replaced by a refresh before being read. */
  displacedAt?: number;
  /** Did James see it but tap something else. */
  ignored: boolean;
  createdAt: number;
};

// --------------------------------------------------------------------------
// Memory / retrieval
// --------------------------------------------------------------------------

export type Memory = {
  id: string;
  personId?: string;
  placeId?: string;
  conversationId?: string;
  text: string;
  /** Free-text kind ("preference", "recent event", "shared joke"). */
  kind: string;
  /** "active" / "stale" / "rejected". */
  status: "active" | "stale" | "rejected";
  /** Embedding for top-K retrieval. */
  embedding?: string;
  createdAt: number;
  updatedAt: number;
};

export type FollowUp = {
  id: string;
  forPersonId?: string;
  forPlaceId?: string;
  text: string;
  /** Marked used once it has been raised in a conversation. */
  used: boolean;
  createdAt: number;
};

// --------------------------------------------------------------------------
// James + profile + style
// --------------------------------------------------------------------------

export type JamesProfile = {
  id: "singleton";
  displayName: string;
  age?: string;
  background?: string;
  personality?: string;
  humorStyle?: string;
  communicationStyle?: string;
  topicsLoved?: string[];
  topicsAvoided?: string[];
  signaturePhrases?: string[];
  currentLifeContext?: string;
  notes?: string;
  updatedAt: number;
};

export type StyleProfile = {
  id: "singleton";
  preferredOpeners: string[];
  preferredSignOffs: string[];
  formality: "casual" | "neutral" | "formal";
  humorMarkers: string[];
  tabooPhrases: string[];
  averageSentenceLength: number;
  readingGradeEstimate: number;
  categoryPreferenceScores: Partial<Record<SuggestionCategory, number>>;
  /** When the last distillation ran. */
  updatedAt: number;
  /** Last distillation failure reason, if any. */
  lastError?: string;
};

export type StyleEvidenceEntry = {
  /** key is `${personId}-${aggregationWindow}` — kept open for now. */
  id: string;
  personId?: string;
  /** Aggregated counts of categories tapped / ignored / edited. */
  counts: Record<string, number>;
  updatedAt: number;
};

// --------------------------------------------------------------------------
// Documents
// --------------------------------------------------------------------------

export type DocumentRecord = {
  id: string;
  /** Plain text content, capped to ~60k chars in the prototype — same here. */
  content: string;
  filename?: string;
  mimeType?: string;
  createdAt: number;
};

export type PersonDocument = DocumentRecord & { personId: string };
export type JamesDocument = DocumentRecord;
export type EventDocument = DocumentRecord & { eventId: string };

// --------------------------------------------------------------------------
// Helpers + manual replies + settings
// --------------------------------------------------------------------------

export type ManualReply = {
  id: string;
  conversationId?: string;
  rawText: string;
  expandedText: string;
  spokenAt: number;
};

/**
 * On-device cache of synthesised TTS audio for the canned quick phrases.
 * Single source of truth for "James never goes silent" — these clips must
 * play with zero network and zero LiveConversation dependency.
 *
 * Cache key is `phraseText::voiceId` because changing James's voice id
 * invalidates every prior synth.
 */
export type CachedPhraseAudio = {
  id: string;
  phraseText: string;
  voiceId: string;
  mimeType: string;
  audioBuffer: ArrayBuffer;
  cachedAt: number;
};

/**
 * Tier-2 / post-conversation jobs that should run in the background after
 * the user taps Stop. Queued here so they survive tab close / reload — the
 * drainer reads pending rows on next app mount and replays them, instead
 * of fire-and-forget which the browser kills on navigation.
 */
export type PendingJob = {
  id: string;
  type:
    | "summariseConversation"
    | "rediarize"
    | "rebuildVoiceprints"
    | "enrichProfiles"
    | "distillStyle"
    | "extractMemories"
    | "updateLexicon"
    | "detectIntroductions";
  conversationId: string;
  status: "pending" | "running" | "done" | "failed";
  attempts: number;
  lastError?: string;
  createdAt: number;
  updatedAt: number;
};

/**
 * Drafts the Helpers tab has generated. Each row carries enough state for
 * a history view AND for the style-distillation loop (`jamesEdit` and
 * `sentAt` are the load-bearing signals — they're the Helpers-tab
 * equivalent of `suggestionsLog.editedTo` / `selected`).
 */
export type HelperDraft = {
  id: string;
  platform: "facebook" | "email" | "imessage";
  /** What James was replying to (if anything). */
  incoming?: string;
  /** James's rough typed input. */
  rawText: string;
  /** AI recommendation. */
  recommended: string;
  /** Alternative tones the AI also returned. */
  alternatives: Array<{ text: string; tone: string }>;
  /** What James actually used (his edit on top of the recommended draft). */
  jamesEdit?: string;
  createdAt: number;
  /** When he tapped "mark sent". null = drafted but never sent. */
  sentAt?: number;
};

/**
 * Cadence guard for the Tier-1 style distillation job. One row per run; we
 * read the most-recent row to decide whether to skip (legacy: ≤ once per
 * 12h unless force=true).
 */
export type StyleDistillRun = {
  id: string;
  startedAt: number;
  endedAt?: number;
  samplesUsed: number;
  /** What the distiller produced; lets the System tab show "last run" detail
   * without re-querying styleProfile. */
  summary?: string;
  /** "ok" / "skipped" / "failed". */
  status: "ok" | "skipped" | "failed";
  error?: string;
};

/**
 * Proposed changes to a Person row from the post-conversation profile
 * enrichment pass. Never auto-applied unless the user (or a high-confidence
 * heuristic per C4 plan) confirms them. Status transitions:
 *   auto       → user hasn't reviewed yet
 *   confirmed  → applied to the Person row, kept here for audit
 *   rejected   → user said no, never proposed again
 *   auto-applied → confidence was high enough to skip review
 */
export type ProfileProposal = {
  id: string;
  personId: string;
  conversationId: string;
  /** Person field being proposed against ("relationship", "topicsLoved", "notes" …). */
  field: string;
  value: string;
  op: "set" | "append" | "remove";
  reasoning?: string;
  status: "auto" | "confirmed" | "rejected" | "auto-applied";
  createdAt: number;
};

/**
 * Per-person vocabulary contribution. Aggregated to build Scribe keyterms
 * (the C6 / T1 path) so proper nouns + jargon stop being mistranscribed.
 * `weight` is a heuristic boost — 3.0 for explicit names, 1.0–2.0 for words
 * extracted from transcripts. `source` lets the System tab show provenance.
 */
export type PersonLexiconEntry = {
  id: string;
  term: string;
  personId?: string;
  weight: number;
  source: "name" | "transcript" | "manual" | "profile";
  createdAt: number;
};

export type SettingsRecord = {
  id: "singleton";
  llmProvider: LLMProviderId;
  sttProvider: STTProviderId;
  ttsProvider: TTSProviderId;
  /** James's ElevenLabs voice_id (also surfaced as PARLEY_JAMES_VOICE_ID on the server). */
  jamesVoiceId?: string;
  /** User-saved custom voices (e.g. via the voice designer panel). */
  customVoices?: Array<{ voiceId: string; name: string }>;
  /** Per-tier model overrides. The server proxies fall back to the env-var
   * default when these are absent. */
  fastModel?: string;
  smartModel?: string;
  /** Speaker-ID matcher tuning. */
  speakerIdWebGPU: boolean;
  speakerIdAcceptThreshold: number;
  speakerIdAskThreshold: number;
  /** GPS toggle for place auto-detection. */
  gpsEnabled: boolean;
  /** iPad size preset for UI scaling. */
  displayPreset: "mini" | "11" | "12.9" | "13";
  /** Cross-session dead-phrase suppression thresholds (System tab). */
  deadPhraseShownTimes?: number;
  deadPhraseWindowDays?: number;
};

export const DEFAULT_SETTINGS: SettingsRecord = {
  id: "singleton",
  llmProvider: "anthropic",
  sttProvider: "elevenlabs-scribe",
  ttsProvider: "elevenlabs-flash",
  speakerIdWebGPU: true,
  speakerIdAcceptThreshold: 0.7,
  speakerIdAskThreshold: 0.45,
  gpsEnabled: false,
  displayPreset: "11",
};

export const DEFAULT_JAMES_PROFILE: JamesProfile = {
  id: "singleton",
  displayName: "James",
  updatedAt: 0,
};

// --------------------------------------------------------------------------
// Dexie
// --------------------------------------------------------------------------

// --------------------------------------------------------------------------
// Local accounts (on-device auth — no third-party identity provider)
// --------------------------------------------------------------------------

/**
 * A login account stored on this device. Passwords are never stored in the
 * clear — only a PBKDF2 hash + per-account salt (see src/lib/auth-local.ts).
 * The first account created on a device is made admin automatically.
 */
export type Account = {
  id: string;
  email: string;
  /** lower-cased email, unique index for lookup */
  emailKey: string;
  /** base64 PBKDF2-SHA256 hash of the password */
  passwordHash: string;
  /** base64 random salt */
  salt: string;
  is_admin: boolean;
  createdAt: number;
  lastSignInAt: number | null;
};

export class ParleyDB extends Dexie {
  accounts!: EntityTable<Account, "id">;
  people!: EntityTable<Person, "id">;
  voiceprints!: EntityTable<Voiceprint, "personId">;
  voiceprintContributions!: EntityTable<VoiceprintContribution, "id">;

  places!: EntityTable<Place, "id">;
  events!: EntityTable<EventRecord, "id">;

  conversations!: EntityTable<Conversation, "id">;
  transcriptSegments!: EntityTable<TranscriptSegment, "id">;
  segmentEmbeddings!: EntityTable<SegmentEmbedding, "segmentId">;

  suggestionsLog!: EntityTable<SuggestionLog, "id">;

  memories!: EntityTable<Memory, "id">;
  followUps!: EntityTable<FollowUp, "id">;

  jamesProfile!: EntityTable<JamesProfile, "id">;
  styleProfile!: EntityTable<StyleProfile, "id">;
  styleEvidence!: EntityTable<StyleEvidenceEntry, "id">;

  personDocuments!: EntityTable<PersonDocument, "id">;
  jamesDocuments!: EntityTable<JamesDocument, "id">;
  eventDocuments!: EntityTable<EventDocument, "id">;

  manualReplies!: EntityTable<ManualReply, "id">;

  settings!: EntityTable<SettingsRecord, "id">;

  cachedPhraseAudio!: EntityTable<CachedPhraseAudio, "id">;
  pendingJobs!: EntityTable<PendingJob, "id">;

  helperDrafts!: EntityTable<HelperDraft, "id">;
  styleDistillRuns!: EntityTable<StyleDistillRun, "id">;
  profileProposals!: EntityTable<ProfileProposal, "id">;
  personLexicon!: EntityTable<PersonLexiconEntry, "id">;

  constructor() {
    super("parley");
    this.version(1).stores({
      people: "id, name, status, updatedAt",
      voiceprints: "personId, updatedAt",
      voiceprintContributions: "id, personId, conversationId, createdAt",

      places: "id, name, updatedAt",
      events: "id, start, end, placeId, updatedAt",

      conversations: "id, startedAt, endedAt, placeId, eventId",
      transcriptSegments:
        "id, conversationId, speakerLabel, personId, speakerKind, startedAt, status",
      segmentEmbeddings: "segmentId, conversationId",

      suggestionsLog:
        "id, conversationId, triggeringSegmentId, personId, category, selected, createdAt",

      memories: "id, personId, placeId, conversationId, status, updatedAt",
      followUps: "id, forPersonId, forPlaceId, used, createdAt",

      jamesProfile: "id, updatedAt",
      styleProfile: "id, updatedAt",
      styleEvidence: "id, personId, updatedAt",

      personDocuments: "id, personId, createdAt",
      jamesDocuments: "id, createdAt",
      eventDocuments: "id, eventId, createdAt",

      manualReplies: "id, conversationId, spokenAt",

      settings: "id",
    });

    // v2: durable-degradation tables. cachedPhraseAudio so the five quick
    // phrases play offline and with no LiveConversation; pendingJobs so
    // tier-2 work survives tab close after Stop. Place.personIds is a
    // type-only addition (Dexie doesn't enforce TS types) so no index
    // change is needed for it here.
    this.version(2).stores({
      cachedPhraseAudio: "id, phraseText, voiceId, cachedAt",
      pendingJobs: "id, type, conversationId, status, createdAt",
    });

    // v3: AI learning loop tables. helperDrafts persists every Helpers-tab
    // draft so the distillation pass can read them as style evidence.
    // styleDistillRuns is the cadence guard. profileProposals carries the
    // Tier-2 enrichment output queue. personLexicon backs Scribe keyterm
    // biasing (T1/C6). Settings additions (customVoices/fast/smartModel,
    // dead-phrase tunables) are type-only — no index change required.
    this.version(3).stores({
      helperDrafts: "id, platform, createdAt, sentAt",
      styleDistillRuns: "id, startedAt, status",
      profileProposals: "id, personId, conversationId, status, createdAt",
      personLexicon: "id, term, personId, source, createdAt",
    });

    // v4: on-device login accounts. emailKey is the unique lookup key
    // (lower-cased email). No third-party auth provider — credentials and
    // session live entirely on the device.
    this.version(4).stores({
      accounts: "id, &emailKey, is_admin, createdAt",
    });
  }
}

let _db: ParleyDB | undefined;

export function db(): ParleyDB {
  if (typeof window === "undefined") {
    throw new Error("Parley DB is browser-only. Don't read it during SSR.");
  }
  if (!_db) _db = new ParleyDB();
  return _db;
}
