import Dexie, { type EntityTable } from "dexie";

/**
 * Parley local-first database. Single user, single iPad, single schema version.
 * Every record is owned by James. No tenant column, no soft-delete graveyard,
 * no migration spaghetti — we delete the database and re-seed when the schema
 * needs to change, until the rebuild ships v1.
 */

export type LLMProviderId = "anthropic" | "openai";
export type STTProviderId = "elevenlabs-scribe";
export type TTSProviderId = "elevenlabs-flash" | "cartesia-sonic";

export type Person = {
  id: string;
  name: string;
  relation?: string;
  notes?: string;
  createdAt: number;
  updatedAt: number;
};

export type VoiceSample = {
  id: string;
  personId: string;
  /** 192-dim float32 ECAPA-TDNN embedding, L2-normalized, stored as base64. */
  embedding: string;
  /** RMS energy of the source audio, for quality gating. */
  rms: number;
  /** Duration in seconds. */
  durationSec: number;
  /** Source: live capture during conversation, or explicit enrollment. */
  source: "enrollment" | "conversation";
  createdAt: number;
};

export type Location = {
  id: string;
  name: string;
  /** People often heard here — biases the speaker-ID prior. */
  associatedPersonIds: string[];
  notes?: string;
  createdAt: number;
  updatedAt: number;
};

export type EventRecord = {
  id: string;
  title: string;
  start: number;
  end?: number;
  locationId?: string;
  /** Expected attendees — biases the speaker-ID prior during the event window. */
  expectedPersonIds: string[];
  notes?: string;
  createdAt: number;
  updatedAt: number;
};

export type Conversation = {
  id: string;
  startedAt: number;
  endedAt?: number;
  locationId?: string;
  eventId?: string;
  /** Cached summary, written by the smart model post-conversation. */
  summary?: string;
};

export type Turn = {
  id: string;
  conversationId: string;
  startedAt: number;
  endedAt: number;
  speakerPersonId?: string;
  /** "self" = James, "other" = someone else (unknown identity). */
  speakerKind: "self" | "other";
  text: string;
  /** Posterior probability the speaker is `speakerPersonId`, if assigned. */
  speakerConfidence?: number;
};

export type Suggestion = {
  id: string;
  turnId?: string;
  conversationId: string;
  text: string;
  category:
    | "answer"
    | "question"
    | "followup"
    | "planned"
    | "quick"
    | "humor"
    | "clarify"
    | "moment";
  /** Was it tapped + spoken aloud. */
  used: boolean;
  createdAt: number;
};

export type SettingsRecord = {
  id: "singleton";
  llmProvider: LLMProviderId;
  sttProvider: STTProviderId;
  ttsProvider: TTSProviderId;
  jamesVoiceId?: string;
  speakerIdWebGPU: boolean;
  speakerIdAcceptThreshold: number;
  speakerIdAskThreshold: number;
};

export const DEFAULT_SETTINGS: SettingsRecord = {
  id: "singleton",
  llmProvider: "anthropic",
  sttProvider: "elevenlabs-scribe",
  ttsProvider: "elevenlabs-flash",
  speakerIdWebGPU: true,
  speakerIdAcceptThreshold: 0.7,
  speakerIdAskThreshold: 0.45,
};

export class ParleyDB extends Dexie {
  people!: EntityTable<Person, "id">;
  voiceSamples!: EntityTable<VoiceSample, "id">;
  locations!: EntityTable<Location, "id">;
  events!: EntityTable<EventRecord, "id">;
  conversations!: EntityTable<Conversation, "id">;
  turns!: EntityTable<Turn, "id">;
  suggestions!: EntityTable<Suggestion, "id">;
  settings!: EntityTable<SettingsRecord, "id">;

  constructor() {
    super("parley");
    this.version(1).stores({
      people: "id, name, updatedAt",
      voiceSamples: "id, personId, createdAt",
      locations: "id, name, updatedAt",
      events: "id, start, end, locationId, updatedAt",
      conversations: "id, startedAt, endedAt, locationId, eventId",
      turns: "id, conversationId, startedAt, speakerPersonId, speakerKind",
      suggestions: "id, conversationId, turnId, createdAt",
      settings: "id",
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
