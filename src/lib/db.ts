import Dexie, { type Table } from "dexie";
import { nanoid } from "nanoid";

export type Person = {
  id: string;
  name: string;
  relationship?: string;
  interests?: string[];
  notes?: string;
  style_notes?: string;
  /** Topics this person brings up enthusiastically (auto-enriched). */
  topics_loved?: string;
  /** Topics this person steers away from (auto-enriched). */
  topics_avoided?: string;
  /** Freeform observations about the James↔person dynamic. */
  relationship_dynamics?: string;
  /** Constrained tags about dynamic (e.g. "teases", "interrupts"). */
  dynamic_tags?: string[];
  /** "live" = user-confirmed person. "auto" = proposed by intro detection,
   *  awaiting Confirm in Settings → People. */
  status?: "live" | "auto";
  /** Confidence of this person's stored voiceprint after offline rebuild (0..1). */
  voiceprint_confidence?: number;
  created_at: number;
};

export type Place = {
  id: string;
  name: string;
  lat: number;
  lng: number;
  radius_m: number;
  notes?: string;
  created_at: number;
};

export type Conversation = {
  id: string;
  started_at: number;
  ended_at?: number;
  person_ids: string[];
  place_id?: string;
  gps_lat?: number;
  gps_lng?: number;
  plan_id?: string;
  summary?: string;
  highlights?: string[];
  speaker_map: Record<string, string>; // speaker_label -> person_id
};

export type TranscriptSegment = {
  id: string;
  conversation_id: string;
  speaker_label: string;
  person_id?: string;
  text: string;
  ts: number;
  /** Confidence in the final speaker assignment (0..1), set by re-diarize pass. */
  confidence?: number;
  /** Timestamp of last re-diarization pass that touched this segment. */
  rediarized_at?: number;
  /** Tier 3.1 — optional semantic embedding (text-embedding-3-small, 1536 dims). */
  embedding?: number[];
  /** Tier 3.1 — model name used to produce `embedding`. */
  embedding_model?: string;
  /** MFCC vector captured at transcription time — stored so later manual
   *  speaker reassignments can improve the correct person's voiceprint. */
  mfcc?: number[];
};

export type SuggestionLog = {
  id: string;
  conversation_id: string;
  text: string;
  category: string;
  source: string;
  plan_point_id?: string;
  shown_at: number;
  selected: boolean;
  edited_to?: string;
  ignored: boolean;
  spoken: boolean;
  time_to_tap_ms?: number;
  /** Which person was the conversation primarily with when this was shown.
   * Used by Tier 1 style-evidence aggregation to bucket picks per person. */
  person_id?: string;
  /** Set when a row was bumped out of the visible 6 by a refresh without
   * being selected — Tier 1 uses this to detect "ignored" suggestions
   * across the cross-session dead-phrase filter. */
  displaced_at?: number;
  /** Set true when this row was on screen but James composed/typed his own
   * reply instead of tapping any suggestion — a strong "all of these missed"
   * signal that the loser-marking + dead-phrase logic both consume. */
  rejected_for_manual?: boolean;
  /** Explicit feedback from the long-press feedback menu. */
  feedback?: SuggestionFeedback;
  feedback_at?: number;
  /** The line(s) James was replying to when this suggestion was shown —
   * a small slice of context so the row reads as a real "memory of choice". */
  context_snippet?: string;
};

export type SuggestionFeedback =
  | "love" // perfect, sounds exactly like me
  | "good" // fine
  | "too_formal"
  | "too_casual"
  | "wrong_tone"
  | "not_me"; // doesn't sound like me / off

/**
 * A durable memory of a single suggestion decision: the context, which option
 * James chose, and the alternatives he passed over. The chosen one was "best";
 * the alternatives were worse. When `typed_own` is set he rejected ALL of them
 * and said his own thing — so every alternative missed and `typed_own` is the
 * target the model should have hit. Feeds the live suggestion prompt so the AI
 * learns his preferences over time.
 */
export type SuggestionChoice = {
  id: string;
  conversation_id: string;
  person_id?: string;
  ts: number;
  /** What was being replied to (recent transcript snippet). */
  context: string;
  /** The suggestion text he tapped (undefined when he typed his own). */
  chosen?: string;
  chosen_category?: string;
  /** The other suggestion texts shown at the same time (the ones he didn't pick). */
  alternatives: string[];
  /** Set when he composed his own reply instead of using any suggestion. */
  typed_own?: string;
  outcome: "selected" | "manual" | "feedback";
  /** Carried when outcome === "feedback". */
  feedback?: SuggestionFeedback;
};

export type ManualReply = {
  id: string;
  conversation_id: string;
  text: string;
  ts: number;
};

export type Memory = {
  id: string;
  person_id?: string;
  place_id?: string;
  conversation_id: string;
  text: string;
  kind: "fact" | "preference" | "event" | "todo";
  status: "auto" | "edited" | "hidden";
  created_at: number;
  /** Tier 3.1 — semantic embedding for retrieval (text-embedding-3-small). */
  embedding?: number[];
  /** Tier 3.1 — model name used to produce `embedding`. Compare only across
   *  memories produced with the same model. */
  embedding_model?: string;
};

export type FollowUp = {
  id: string;
  for_person_id?: string;
  for_place_id?: string;
  text: string;
  created_at: number;
  used: boolean;
};

export type Settings = {
  id: "singleton";
  voice_id: string;
  voice_name: string;
  gps_enabled: boolean;
  cloud_sync: boolean;
  suggestion_refresh_ms: number;
  ipad_model?: IPadModel;
  suggestion_model?: string;
  expand_model?: string;
  /** Latency-critical tier: live suggestions + clarify-and-speak expansion. */
  fast_model?: string;
  /** Quality-critical tier: post-conversation summary, memory extraction, event prep, drafts. */
  smart_model?: string;
  /** When true, holding a suggestion opens the long-press feedback menu.
   *  Defaults on — a tuning/testing aid that can be switched off for daily use. */
  suggestion_feedback_enabled?: boolean;
  custom_voices?: Array<{
    voice_id: string;
    name: string;
    labels?: Record<string, string>;
  }>;
};

export type IPadModel =
  | "auto"
  | "ipad_mini"
  | "ipad_10_9"
  | "ipad_air_11"
  | "ipad_pro_12_9"
  | "ipad_pro_13";

export const IPAD_PRESETS: Record<
  Exclude<IPadModel, "auto">,
  { label: string; width: number; height: number }
> = {
  ipad_mini: { label: 'iPad mini (8.3")', width: 1133, height: 744 },
  ipad_10_9: { label: 'iPad 10.9"', width: 1180, height: 820 },
  ipad_air_11: { label: 'iPad Air / Pro 11"', width: 1194, height: 834 },
  ipad_pro_12_9: { label: 'iPad Pro 12.9"', width: 1366, height: 1024 },
  ipad_pro_13: { label: 'iPad Pro 13" (M4)', width: 1376, height: 1032 },
};

export type StyleProfile = {
  id: "singleton";
  updated_at: number;
  json: string;
};

// === Tier 1: feedback loop ===
/** Cached per-person style evidence so suggestion refreshes don't re-run the
 * Dexie aggregation on every 1.5 s tick. Keyed by sorted-joined personIds. */
export type StyleEvidenceCache = {
  id: string;
  person_id: string;
  computed_at: number;
  json: string; // serialized StyleEvidence
};

/** Run log for the auto style-profile distillation job. */
export type StyleDistillRun = {
  id: string;
  ran_at: number;
  conversations_seen: number;
  samples_used: number;
  ok: boolean;
  error?: string;
};

/** Shape persisted to `style_profile.json` after distillation. Kept here so
 * both the server fn and the reader use a single source of truth. */
export type StyleProfileJson = {
  version: 1;
  generated_at: number;
  source_window_days: number;
  source_sample_count: number;
  preferred_openers: string[];
  preferred_signoffs: string[];
  formality: "casual" | "neutral" | "formal";
  formality_score: number; // 0..1
  humor_markers: string[];
  taboo_phrases: string[];
  avg_sentence_length_words: number;
  reading_grade_estimate: number;
  category_preference: Record<string, number>;
  notes: string;
};

export type JamesProfile = {
  id: "singleton";
  // Structured fields
  display_name: string;
  age?: string;
  background?: string; // family, career, where grew up
  personality?: string; // dry wit, warm, etc.
  humor_style?: string;
  communication_style?: string; // short sentences, prefers questions, etc.
  topics_loved?: string;
  topics_avoided?: string;
  signature_phrases?: string; // newline separated
  current_life_context?: string; // recent events, what's on his mind
  // Freeform
  freeform_notes?: string; // anything else
  updated_at: number;
};

export type JamesDocument = {
  id: string;
  name: string;
  mime: string;
  size: number;
  text: string; // extracted plain text (truncated)
  note?: string; // optional user note about this document
  created_at: number;
};

export type EventPrepItem = {
  id: string;
  text: string;
  selected: boolean;
  edited?: boolean;
};

export type EventItem = {
  id: string;
  name: string;
  when?: string; // freeform date/time
  location?: string;
  person_ids: string[];
  key_info?: string;
  prep_prompt?: string; // user-provided steering for AI prep
  key_points: EventPrepItem[];
  key_questions: EventPrepItem[];
  notes?: string;
  created_at: number;
};

export type EventDocument = {
  id: string;
  event_id: string;
  name: string;
  mime: string;
  size: number;
  text: string;
  note?: string;
  created_at: number;
};

export type Voiceprint = {
  id: string; // == person_id
  person_id: string;
  centroid: number[]; // mean MFCC vector (length = MFCC_COEFFS)
  sample_count: number;
  updated_at: number;
  /** Optional sub-centroids when the speaker has multiple stable modes
   *  (e.g. calm vs animated, in-person vs phone). Written by the offline
   *  re-clustering pass when 2-means split is significantly tighter than
   *  the single-centroid mean. */
  sub_centroids?: Array<{ label: string; centroid: number[]; count: number }>;
  /** Intra-cluster cohesion (0..1). Written by offline rebuild. */
  confidence?: number;
  /** Timestamp of last offline rebuild pass that wrote to this voiceprint. */
  last_rebuilt_at?: number;
};

export type VoiceprintContribution = {
  id: string;
  person_id: string;
  conversation_id?: string;
  source: "manual" | "auto"; // manual = recorded in settings; auto = learned during conversation
  mfcc: number[];
  ts: number;
  /** Optional preview text captured at the moment the contribution was learned. */
  preview_text?: string;
};

export type PersonDocument = {
  id: string;
  person_id: string;
  name: string;
  mime: string;
  size: number;
  text: string; // extracted plain text (truncated)
  note?: string;
  created_at: number;
};

/**
 * Proposed updates to a Person's profile, generated by the post-conversation
 * enrichment pass. Status semantics:
 *  - "auto":    created by the LLM, awaiting user review.
 *  - "edited":  user tweaked the value before accepting (also implies applied).
 *  - "applied": user accepted as-is; the change has been merged into the Person row.
 *  - "hidden":  user rejected (will not be re-proposed for the same conversation).
 */
export type ProfileProposal = {
  id: string;
  person_id: string;
  conversation_id: string;
  field:
    | "interests"
    | "style_notes"
    | "topics_loved"
    | "topics_avoided"
    | "relationship_dynamics"
    | "dynamic_tags";
  /** For array fields ("interests", "dynamic_tags") the value is a single
   *  candidate entry. For text fields it is the full proposed snippet. */
  value: string;
  op: "add" | "replace";
  status: "auto" | "edited" | "applied" | "hidden";
  reasoning?: string;
  created_at: number;
};

/**
 * Per-utterance mean-MFCC vector, captured during the live session and
 * persisted so the post-conversation re-diarize pass can re-cluster
 * speakers using stored voiceprints as seeds.
 */
export type SegmentMfcc = {
  id: string;
  segment_id: string;
  conversation_id: string;
  mfcc: number[];
  ts: number;
};

export const MFCC_COEFFS = 20;
/** Cosine-similarity threshold above which an unknown speaker is auto-matched to a stored voiceprint.
 *  MFCC means across short utterances from the same speaker typically land in
 *  the 0.78–0.92 range, so 0.86 was too strict and almost never triggered.
 *  0.80 catches genuine matches while still filtering most strangers. */
export const VOICEPRINT_MATCH_THRESHOLD = 0.8;

class AacDb extends Dexie {
  people!: Table<Person, string>;
  places!: Table<Place, string>;
  conversations!: Table<Conversation, string>;
  transcript_segments!: Table<TranscriptSegment, string>;
  suggestions_log!: Table<SuggestionLog, string>;
  manual_replies!: Table<ManualReply, string>;
  memories!: Table<Memory, string>;
  follow_ups!: Table<FollowUp, string>;
  settings!: Table<Settings, string>;
  style_profile!: Table<StyleProfile, string>;
  james_profile!: Table<JamesProfile, string>;
  james_documents!: Table<JamesDocument, string>;
  events!: Table<EventItem, string>;
  event_documents!: Table<EventDocument, string>;
  voiceprints!: Table<Voiceprint, string>;
  person_documents!: Table<PersonDocument, string>;
  voiceprint_contributions!: Table<VoiceprintContribution, string>;
  // === Tier 1: feedback loop ===
  style_evidence_cache!: Table<StyleEvidenceCache, string>;
  style_distill_runs!: Table<StyleDistillRun, string>;
  // === Tier 2: post-conversation analysis ===
  profile_proposals!: Table<ProfileProposal, string>;
  segment_mfccs!: Table<SegmentMfcc, string>;
  // === Preference learning: which suggestion James chose vs. the rest ===
  suggestion_choices!: Table<SuggestionChoice, string>;

  constructor() {
    super("aac_copilot");
    this.version(1).stores({
      people: "id, name, created_at",
      places: "id, name, created_at",
      conversations: "id, started_at, place_id",
      transcript_segments: "id, conversation_id, ts",
      suggestions_log: "id, conversation_id, shown_at",
      manual_replies: "id, conversation_id, ts",
      memories: "id, person_id, place_id, conversation_id, created_at",
      follow_ups: "id, for_person_id, for_place_id, used, created_at",
      settings: "id",
      style_profile: "id",
    });
    this.version(2).stores({
      james_profile: "id",
    });
    this.version(3).stores({
      james_documents: "id, created_at",
    });
    this.version(4).stores({
      events: "id, name, created_at",
      event_documents: "id, event_id, created_at",
    });
    this.version(5).stores({
      voiceprints: "id, person_id, updated_at",
    });
    this.version(6).stores({
      person_documents: "id, person_id, created_at",
    });
    this.version(7).stores({
      voiceprint_contributions: "id, person_id, ts",
    });
    // === Tier 1: feedback loop ===
    // Add `person_id` and `[person_id+ignored]` index to suggestions_log
    // so we can bucket picks per person and filter cross-session dead
    // phrases cheaply. Introduces caches for style evidence + distill runs.
    this.version(8).stores({
      suggestions_log: "id, conversation_id, shown_at, person_id, [person_id+ignored]",
      style_evidence_cache: "id, person_id, computed_at",
      style_distill_runs: "id, ran_at",
    });
    // === Tier 2: post-conversation analysis ===
    // Adds profile_proposals (per-person review queue), segment_mfccs
    // (per-utterance MFCC for re-diarize), and extends people/voiceprints
    // with new queryable indexes.
    // Tier 3.1's `embedding` / `embedding_model` fields on Memory and
    // TranscriptSegment are non-indexed properties — no version bump needed.
    this.version(9).stores({
      people: "id, name, status, created_at",
      voiceprints: "id, person_id, updated_at, confidence",
      profile_proposals: "id, person_id, conversation_id, status, created_at",
      segment_mfccs: "id, segment_id, conversation_id, ts",
    });
    // === Preference learning ===
    // suggestion_choices records each decision (chosen vs. alternatives, or a
    // typed-own rejection) so the suggestion prompt can learn his preferences.
    // The new SuggestionLog fields (rejected_for_manual, feedback, feedback_at,
    // context_snippet) are non-indexed properties — no re-declaration needed.
    this.version(10).stores({
      suggestion_choices: "id, conversation_id, person_id, ts",
    });
    // Forward-compat shim: PR #6 (Dexie v11) shipped to production added a
    // `cachedPhraseAudio` TTS cache table. iPads that opened that build have
    // an existing DB at v11; without this declaration the rollback to PR #5
    // would throw VersionError and lock them out of their own data. We don't
    // read or write this table from PR #5 code — it just needs to exist so
    // Dexie accepts the existing IDB and the user's people, voiceprints,
    // transcripts, memories, and profile survive the downgrade intact.
    this.version(11).stores({
      cachedPhraseAudio: "id, kind, voiceId, cachedAt",
    });
  }
}

export const db = new AacDb();
export const newId = () => nanoid(12);

export const DEFAULT_SETTINGS: Settings = {
  id: "singleton",
  voice_id: "EXAVITQu4vr4xnSDxMaL", // Sarah
  voice_name: "Sarah",
  gps_enabled: true,
  cloud_sync: false,
  suggestion_refresh_ms: 3500,
  ipad_model: "auto",
  // Default to Gemini (prefixed ids route to it as primary). If the free tier
  // rate-limits, the server's fallback chain automatically retries on
  // Anthropic / OpenAI, so suggestions never break — switch the primary in
  // Settings → AI models.
  suggestion_model: "gemini/gemini-2.5-flash-lite",
  expand_model: "gemini/gemini-2.5-flash-lite",
  fast_model: "gemini/gemini-2.5-flash-lite",
  smart_model: "gemini/gemini-2.5-flash",
  suggestion_feedback_enabled: true,
};

/**
 * Normalize a stored model id to a provider-prefixed one. Legacy gateway ids
 * (`google/…`, bare, or anything without a known provider prefix) are rewritten
 * to the reliable Anthropic default for the tier, so the Settings UI, local
 * storage, and the server's `resolveChatChain` all agree on which provider runs.
 */
function normalizeModelId(
  id: string | undefined,
  tier: "fast" | "smart",
): string {
  if (
    id &&
    (id.startsWith("anthropic/") ||
      id.startsWith("gemini/") ||
      id.startsWith("openai-direct/"))
  ) {
    return id;
  }
  // Legacy / unknown id → the default provider (Gemini) for the tier.
  return tier === "fast"
    ? "gemini/gemini-2.5-flash-lite"
    : "gemini/gemini-2.5-flash";
}

/** Provider family of a prefixed model id (must match ai-models.providerIdForModel). */
function providerOf(id: string): "anthropic" | "gemini" | "openai" {
  if (id.startsWith("gemini/") || id.startsWith("google/")) return "gemini";
  if (id.startsWith("openai-direct/") || id.startsWith("openai/")) return "openai";
  return id.startsWith("anthropic/") ? "anthropic" : "gemini";
}

export async function getSettings(): Promise<Settings> {
  const existing = await db.settings.get("singleton");
  if (existing) {
    // Heal tier fields: backfill the fast/smart split for pre-split users AND
    // rewrite any legacy `google/…` ids to provider-prefixed ones so storage,
    // UI and routing converge. suggestion_model / expand_model track fast_model.
    const fast = normalizeModelId(
      existing.fast_model ?? existing.suggestion_model,
      "fast",
    );
    let smart = normalizeModelId(existing.smart_model, "smart");
    // Keep both tiers on the SAME provider so the Settings picker (which derives
    // the active provider from the fast model) can't display the wrong smart
    // model. If they diverge, snap smart to the fast provider's smart default.
    if (providerOf(smart) !== providerOf(fast)) {
      const p = providerOf(fast);
      smart =
        p === "anthropic"
          ? "anthropic/claude-sonnet-4-5"
          : p === "openai"
            ? "openai-direct/gpt-4o"
            : "gemini/gemini-2.5-flash";
    }
    if (
      existing.fast_model !== fast ||
      existing.smart_model !== smart ||
      existing.suggestion_model !== fast ||
      existing.expand_model !== fast
    ) {
      const migrated: Settings = {
        ...existing,
        fast_model: fast,
        smart_model: smart,
        suggestion_model: fast,
        expand_model: fast,
      };
      await db.settings.put(migrated);
      return migrated;
    }
    return existing;
  }
  await db.settings.put(DEFAULT_SETTINGS);
  return DEFAULT_SETTINGS;
}

export async function updateSettings(patch: Partial<Settings>) {
  const cur = await getSettings();
  const next = { ...cur, ...patch, id: "singleton" as const };
  await db.settings.put(next);
  return next;
}

export const DEFAULT_JAMES_PROFILE: JamesProfile = {
  id: "singleton",
  // Blank by default so a brand-new account doesn't inherit "James". First-run
  // onboarding captures the real owner's name (see OwnerOnboarding). Existing
  // installs already have their name stored, so they're unaffected.
  display_name: "",
  updated_at: 0,
};

/**
 * The display name of the account owner — the non-speaking user this app
 * speaks FOR. Single source of truth for every prompt and UI label so the
 * app reads as whoever's actually signed in, not a hardcoded "James".
 * Falls back to a neutral term only if onboarding hasn't set a name yet.
 */
export function ownerName(
  profile?: Pick<JamesProfile, "display_name"> | null,
): string {
  const n = profile?.display_name?.trim();
  return n && n.length > 0 ? n : "the user";
}

/** True when no owner name has been set yet — drives first-run onboarding. */
export function needsOwnerOnboarding(
  profile?: Pick<JamesProfile, "display_name"> | null,
): boolean {
  return !profile?.display_name?.trim();
}

export async function getJamesProfile(): Promise<JamesProfile> {
  const existing = await db.james_profile.get("singleton");
  if (existing) return existing;
  await db.james_profile.put(DEFAULT_JAMES_PROFILE);
  return DEFAULT_JAMES_PROFILE;
}

export async function updateJamesProfile(patch: Partial<JamesProfile>) {
  const cur = await getJamesProfile();
  const next = { ...cur, ...patch, id: "singleton" as const, updated_at: Date.now() };
  await db.james_profile.put(next);
  return next;
}
