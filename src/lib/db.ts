import Dexie, { type Table } from "dexie";
import { nanoid } from "nanoid";

export type Person = {
  id: string;
  name: string;
  relationship?: string;
  interests?: string[];
  notes?: string;
  style_notes?: string;
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
  /** Tier 3.1 — optional semantic embedding (text-embedding-3-small, 1536 dims). */
  embedding?: number[];
  /** Tier 3.1 — model name used to produce `embedding`. */
  embedding_model?: string;
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

export const MFCC_COEFFS = 13;
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
    // Tier 3.1 — added `embedding` and `embedding_model` fields on Memory
    // and TranscriptSegment. No new indexes (embeddings are scanned
    // in-memory by retrieval.ts), so the stores strings are unchanged from
    // version 1. Declaring v8 explicitly lets Dexie know schema is current.
    this.version(8).stores({
      memories: "id, person_id, place_id, conversation_id, created_at",
      transcript_segments: "id, conversation_id, ts",
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
  suggestion_model: "google/gemini-2.5-flash-lite",
  expand_model: "google/gemini-2.5-flash-lite",
  fast_model: "google/gemini-2.5-flash-lite",
  smart_model: "google/gemini-2.5-pro",
};

export type ModelOption = {
  id: string;
  label: string;
  hint: string;
  provider: "gateway" | "openai-direct";
};

// Models served via Lovable AI Gateway (no extra key needed) plus
// "openai-direct/*" options that use the user's own OPENAI_API_KEY.
export const MODEL_OPTIONS: ModelOption[] = [
  {
    id: "openai-direct/gpt-5.5-pro",
    label: "GPT-5.5 Pro (your key)",
    hint: "Premium · deepest reasoning",
    provider: "openai-direct",
  },
  {
    id: "openai-direct/gpt-5.5",
    label: "GPT-5.5 (your key)",
    hint: "Most capable · state of the art",
    provider: "openai-direct",
  },
  {
    id: "openai-direct/gpt-5.4-pro",
    label: "GPT-5.4 Pro (your key)",
    hint: "Premium reasoning",
    provider: "openai-direct",
  },
  {
    id: "openai-direct/gpt-5.4",
    label: "GPT-5.4 (your key)",
    hint: "Advanced reasoning · code",
    provider: "openai-direct",
  },
  {
    id: "openai-direct/gpt-5.4-mini",
    label: "GPT-5.4 mini (your key)",
    hint: "Faster · balanced 5.4",
    provider: "openai-direct",
  },
  {
    id: "openai-direct/gpt-5.4-nano",
    label: "GPT-5.4 nano (your key)",
    hint: "Fastest · cheapest 5.4",
    provider: "openai-direct",
  },
  {
    id: "openai-direct/gpt-5.2",
    label: "GPT-5.2 (your key)",
    hint: "Enhanced reasoning",
    provider: "openai-direct",
  },
  {
    id: "openai-direct/gpt-5",
    label: "GPT-5 (your key)",
    hint: "Powerful all-rounder",
    provider: "openai-direct",
  },
  {
    id: "openai-direct/gpt-5-mini",
    label: "GPT-5 mini (your key)",
    hint: "Fast · balanced · your OpenAI key",
    provider: "openai-direct",
  },
  {
    id: "openai-direct/gpt-5-nano",
    label: "GPT-5 nano (your key)",
    hint: "Fastest · cheapest · your OpenAI key",
    provider: "openai-direct",
  },
  {
    id: "openai-direct/gpt-4o",
    label: "GPT-4o (your key)",
    hint: "Legacy · uses your OpenAI key",
    provider: "openai-direct",
  },
  {
    id: "openai-direct/gpt-4o-mini",
    label: "GPT-4o mini (your key)",
    hint: "Legacy · fast · your OpenAI key",
    provider: "openai-direct",
  },
];

export async function getSettings(): Promise<Settings> {
  const existing = await db.settings.get("singleton");
  if (existing) {
    // Backfill new tier fields for users who set up before the split.
    if (!existing.fast_model || !existing.smart_model) {
      const migrated = {
        ...existing,
        fast_model: existing.fast_model ?? existing.suggestion_model ?? DEFAULT_SETTINGS.fast_model,
        smart_model: existing.smart_model ?? DEFAULT_SETTINGS.smart_model,
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
  display_name: "James",
  updated_at: 0,
};

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
