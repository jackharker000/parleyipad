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
};

export async function getSettings(): Promise<Settings> {
  const existing = await db.settings.get("singleton");
  if (existing) return existing;
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