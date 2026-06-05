/**
 * Legacy `.parlbak` backup reader + schema migrator.
 *
 * The pre-rebuild app shipped an encrypted local backup (`.parlbak`) with a
 * different on-disk format AND a different (snake_case) Dexie schema. This
 * module reads those files and migrates them into the CURRENT
 * `ExportManifest` shape so `restoreFromManifest` can ingest them unchanged.
 *
 * Old on-disk format ("PRLY" v2, multi-byte fields big-endian):
 *   [0..3]   magic 'PRLY' (0x50 0x52 0x4c 0x59)
 *   [4]      format version (== 2)
 *   [5..8]   PBKDF2 iterations (uint32) — usually 600,000
 *   [9..24]  PBKDF2 salt (16 bytes)
 *   [25..36] AES-GCM IV (12 bytes)
 *   [37..]   ciphertext = AES-GCM(utf8(JSON.stringify(dump)))
 *
 * Decrypted payload: `{ version, exportedAt, tables: { <name>: row[] } }`
 * where binary fields are tagged `{ "__ab__": "<base64>" }`.
 *
 * The current format is "PARLEY" v1 — see `crypto-passphrase.ts`. The two
 * are distinguished by their magic bytes, so a file can be routed without a
 * heuristic.
 */

import type { ExportManifest } from "@/lib/data-export";

const PRLY_MAGIC = [0x50, 0x52, 0x4c, 0x59]; // "PRLY"
const PRLY_FORMAT_VERSION = 2;
const SALT_BYTES = 16;
const IV_BYTES = 12;
const ITER_BYTES = 4;
const HEADER_BYTES = PRLY_MAGIC.length + 1 + ITER_BYTES + SALT_BYTES + IV_BYTES; // 37
const PBKDF2_ITERATIONS_MIN = 1;
const PBKDF2_ITERATIONS_MAX = 10_000_000;

/** Cheap probe: does the buffer start with the legacy 'PRLY' magic? */
export function hasLegacyParlbakMagic(bytes: Uint8Array): boolean {
  if (bytes.length < PRLY_MAGIC.length) return false;
  for (let i = 0; i < PRLY_MAGIC.length; i++) {
    if (bytes[i] !== PRLY_MAGIC[i]) return false;
  }
  return true;
}

type LegacyDump = {
  version?: number;
  exportedAt?: number;
  tables?: Record<string, unknown[]>;
};

/**
 * Decrypt a legacy `.parlbak` file and migrate it to a current
 * ExportManifest. Throws on a malformed header, unsupported version, or a
 * wrong password (AES-GCM auth-tag failure).
 */
export async function importLegacyParlbak(
  bytes: Uint8Array,
  passphrase: string,
): Promise<ExportManifest> {
  const dump = await decryptLegacyDump(bytes, passphrase);
  return migrateDumpToManifest(dump);
}

async function decryptLegacyDump(bytes: Uint8Array, passphrase: string): Promise<LegacyDump> {
  if (!hasLegacyParlbakMagic(bytes)) {
    throw new Error("This doesn't look like a Parley backup file.");
  }
  if (bytes.length < HEADER_BYTES + 1) {
    throw new Error("Backup file is too short to be valid.");
  }
  let cursor = PRLY_MAGIC.length;
  const fmt = bytes[cursor++];
  if (fmt !== PRLY_FORMAT_VERSION) {
    throw new Error(`Unsupported backup format version: ${fmt}`);
  }
  const iterations = readUint32BE(bytes, cursor);
  cursor += ITER_BYTES;
  if (iterations < PBKDF2_ITERATIONS_MIN || iterations > PBKDF2_ITERATIONS_MAX) {
    throw new Error("Backup header declares an invalid PBKDF2 iteration count.");
  }
  const salt = bytes.subarray(cursor, cursor + SALT_BYTES);
  cursor += SALT_BYTES;
  const iv = bytes.subarray(cursor, cursor + IV_BYTES);
  cursor += IV_BYTES;
  const ciphertext = bytes.subarray(cursor);

  const key = await deriveKey(passphrase, salt, iterations);
  let plaintext: ArrayBuffer;
  try {
    plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: toArrayBuffer(iv) },
      key,
      toArrayBuffer(ciphertext),
    );
  } catch {
    throw new Error("Wrong password or the file is corrupt.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(plaintext));
  } catch {
    throw new Error("Backup decrypted but its contents are not valid JSON.");
  }
  if (!parsed || typeof parsed !== "object" || !("tables" in parsed)) {
    throw new Error("Backup payload is malformed (missing `tables`).");
  }
  return parsed as LegacyDump;
}

// --------------------------------------------------------------------------
// Schema migration: old snake_case tables/fields → current camelCase schema
// --------------------------------------------------------------------------

/**
 * Old table name → current table name, or `null` to drop. Tables not listed
 * are passed through unchanged (covers `people`, `places`, `conversations`,
 * `memories`, `events`, `voiceprints`, `settings`, `cachedPhraseAudio`,
 * which already share a name with the current schema).
 */
const TABLE_RENAME: Record<string, string | null> = {
  transcript_segments: "transcriptSegments",
  suggestions_log: "suggestionsLog",
  manual_replies: "manualReplies",
  follow_ups: "followUps",
  style_profile: "styleProfile",
  james_profile: "jamesProfile",
  james_documents: "jamesDocuments",
  event_documents: "eventDocuments",
  person_documents: "personDocuments",
  voiceprint_contributions: "voiceprintContributions",
  style_evidence_cache: "styleEvidence",
  style_distill_runs: "styleDistillRuns",
  profile_proposals: "profileProposals",
  // Dropped — no equivalent in the current (ECAPA / suggestionsLog) schema.
  segment_mfccs: null,
  suggestion_choices: null,
};

function migrateDumpToManifest(dump: LegacyDump): ExportManifest {
  const inTables = dump.tables ?? {};
  const outTables: Record<string, Array<Record<string, unknown>>> = {};

  for (const [oldName, rows] of Object.entries(inTables)) {
    if (oldName in TABLE_RENAME && TABLE_RENAME[oldName] === null) continue; // dropped
    const newName = (oldName in TABLE_RENAME ? TABLE_RENAME[oldName] : oldName) as string;
    if (!Array.isArray(rows)) continue;

    const migrated: Array<Record<string, unknown>> = [];
    for (const row of rows) {
      if (!row || typeof row !== "object") continue;
      migrated.push(migrateRow(newName, row as Record<string, unknown>));
    }
    outTables[newName] = migrated;
  }

  return {
    version: 1,
    exportedAt: new Date(dump.exportedAt ?? Date.now()).toISOString(),
    accountId: null,
    encrypted: false,
    tables: outTables,
  };
}

/**
 * Migrate a single row to the current schema: snake_case → camelCase keys,
 * legacy binary tags → current blob wrappers, plus per-table fix-ups
 * (renamed fields, back-filled required fields).
 */
function migrateRow(table: string, row: Record<string, unknown>): Record<string, unknown> {
  // Generic snake_case → camelCase on every key, recursively converting the
  // legacy `{ __ab__ }` binary tag to the current `{ __blob }` wrapper.
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    out[camel(k)] = convertValue(v);
  }

  switch (table) {
    case "people": {
      // The People list filters on `status`; legacy rows have none. Default
      // to "active" (curated by James) so they show up. updatedAt is
      // required by the current type — fall back to createdAt or now.
      if (out.status == null) out.status = "active";
      if (out.updatedAt == null) out.updatedAt = out.createdAt ?? Date.now();
      break;
    }
    case "jamesProfile": {
      out.id = "singleton";
      if (out.updatedAt == null) out.updatedAt = Date.now();
      break;
    }
    case "cachedPhraseAudio": {
      // Legacy field was `text`; the current type calls it `phraseText`.
      // `kind` was dropped from the current schema.
      if (out.phraseText == null && out.text != null) out.phraseText = out.text;
      delete out.text;
      delete out.kind;
      if (out.cachedAt == null) out.cachedAt = Date.now();
      break;
    }
    case "settings": {
      // Settings shape diverged completely (provider model, speaker-ID
      // thresholds, etc.). Carry only the few fields that still mean the
      // same thing; the read path merges DEFAULT_SETTINGS over whatever's
      // present, so a partial row is safe.
      const safe: Record<string, unknown> = { id: "singleton" };
      if (typeof out.voiceId === "string") safe.jamesVoiceId = out.voiceId;
      if (typeof out.gpsEnabled === "boolean") safe.gpsEnabled = out.gpsEnabled;
      if (typeof out.cloudSync === "boolean") safe.cloudSyncEnabled = out.cloudSync;
      return safe;
    }
    default:
      break;
  }
  return out;
}

const AB_TAG = "__ab__";

/** Recursively convert a legacy value: `{ __ab__ }` → `{ __blob }`, descend
 *  arrays/objects, snake→camel object keys. */
function convertValue(value: unknown): unknown {
  if (isPlainObject(value)) {
    const keys = Object.keys(value);
    if (keys.length === 1 && keys[0] === AB_TAG && typeof value[AB_TAG] === "string") {
      // Legacy ArrayBuffer tag → current blob wrapper. octet-stream type
      // makes restoreFromManifest rehydrate it back to an ArrayBuffer,
      // which is what the audioBuffer slot wants.
      return {
        __blob: true,
        dataB64: value[AB_TAG] as string,
        type: "application/octet-stream",
      };
    }
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[camel(k)] = convertValue(v);
    return out;
  }
  if (Array.isArray(value)) return value.map(convertValue);
  return value;
}

function camel(key: string): string {
  return key.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

// --------------------------------------------------------------------------
// Crypto + byte helpers (legacy format uses iterations-from-header)
// --------------------------------------------------------------------------

async function deriveKey(
  passphrase: string,
  salt: Uint8Array,
  iterations: number,
): Promise<CryptoKey> {
  const passKey = await crypto.subtle.importKey(
    "raw",
    toArrayBuffer(new TextEncoder().encode(passphrase)),
    { name: "PBKDF2" },
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: toArrayBuffer(salt), iterations, hash: "SHA-256" },
    passKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["decrypt"],
  );
}

function toArrayBuffer(view: Uint8Array): ArrayBuffer {
  const out = new ArrayBuffer(view.byteLength);
  new Uint8Array(out).set(view);
  return out;
}

function readUint32BE(buf: Uint8Array, offset: number): number {
  return (
    ((buf[offset] << 24) >>> 0) +
    (buf[offset + 1] << 16) +
    (buf[offset + 2] << 8) +
    buf[offset + 3]
  );
}
