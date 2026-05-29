import { db } from "@/lib/db";

/**
 * Local-only encrypted backup. Dumps every Dexie table to JSON, encrypts
 * with a user-supplied passphrase via Web Crypto AES-GCM + PBKDF2-derived
 * key, and returns the ciphertext as a Blob the caller can offer for
 * download via the Files / iCloud Drive app.
 *
 * Single-user, local-first: no server is involved. Forgotten passphrase
 * means forfeited backup — same trade-off as a personal-vault password.
 *
 * Format on disk (multi-byte fields are big-endian):
 *
 *   Version 1 (legacy, still importable; PBKDF2 iterations implied 200_000):
 *     [0..3]    magic 'PRLY' (0x50 0x52 0x4c 0x59)
 *     [4]       format version (== 1)
 *     [5..20]   PBKDF2 salt (16 bytes, random per backup)
 *     [21..32]  AES-GCM IV (12 bytes, random per backup)
 *     [33..]    ciphertext = AES-GCM(plaintext)
 *
 *   Version 2 (current; PBKDF2 iteration count stored in the header so the
 *   default can change over time without orphaning older files):
 *     [0..3]    magic 'PRLY'
 *     [4]       format version (== 2)
 *     [5..8]    PBKDF2 iterations (uint32, big-endian)
 *     [9..24]   PBKDF2 salt (16 bytes, random per backup)
 *     [25..36]  AES-GCM IV (12 bytes, random per backup)
 *     [37..]    ciphertext = AES-GCM(plaintext)
 *
 *   plaintext = utf8(JSON.stringify(serialize(dump)))
 *
 * `dump` shape: `{ version, exportedAt, tables: Record<tableName, rows[]> }`.
 * Each table name matches the Dexie property, so import can do a
 * `db()[name].bulkPut(rows)` loop without a mapping table.
 *
 * Binary row fields (e.g. `cachedPhraseAudio.audioBuffer`, an ArrayBuffer)
 * do not survive a plain `JSON.stringify` — they collapse to `{}`. The
 * serializer below base64-encodes any ArrayBuffer / typed-array value into a
 * tagged wrapper `{ "__ab__": "<base64>" }` and decodes it back to an
 * ArrayBuffer on import, so binary fields round-trip losslessly for every
 * table without per-table knowledge.
 */

const MAGIC = new Uint8Array([0x50, 0x52, 0x4c, 0x59]); // "PRLY"
const FORMAT_VERSION = 2;
const SALT_BYTES = 16;
const IV_BYTES = 12;
const ITER_BYTES = 4;

// OWASP 2023+ guidance for PBKDF2-HMAC-SHA256. Stored in the v2 header so a
// future bump applies only to new files and old files keep their own count.
const PBKDF2_ITERATIONS_DEFAULT = 600_000;
// Version-1 files predate the stored count; they were always written at 200k.
const PBKDF2_ITERATIONS_V1 = 200_000;
// Sanity bounds on the iteration count read from a v2 header. The count drives
// PBKDF2 cost linearly, so a corrupt or hostile header claiming a near-uint32-max
// value would otherwise hang this single-purpose iPad for minutes inside
// deriveKey before any auth failure surfaced. The cap still leaves ample room
// for future OWASP bumps (~16x today's default) while staying bounded.
const PBKDF2_ITERATIONS_MIN = 1;
const PBKDF2_ITERATIONS_MAX = 10_000_000;

const TABLE_NAMES = [
  "people",
  "voiceprints",
  "voiceprintContributions",
  "places",
  "events",
  "conversations",
  "transcriptSegments",
  "segmentEmbeddings",
  "suggestionsLog",
  "memories",
  "followUps",
  "jamesProfile",
  "styleProfile",
  "styleEvidence",
  "personDocuments",
  "jamesDocuments",
  "eventDocuments",
  "manualReplies",
  "settings",
  "cachedPhraseAudio",
  "pendingJobs",
  "helperDrafts",
  "styleDistillRuns",
  "profileProposals",
  "personLexicon",
] as const;

type TableName = (typeof TABLE_NAMES)[number];

export type BackupMeta = {
  exportedAt: number;
  rowCount: number;
  perTable: Record<string, number>;
};

export type BackupDump = {
  version: number;
  exportedAt: number;
  tables: Record<string, unknown[]>;
};

export async function exportEncryptedBackup(passphrase: string): Promise<{
  blob: Blob;
  meta: BackupMeta;
}> {
  if (!passphrase || passphrase.length < 6) {
    throw new Error("Passphrase must be at least 6 characters.");
  }

  const dump = await buildDump();
  const plaintext = new TextEncoder().encode(JSON.stringify(serializeForJson(dump)));

  const iterations = PBKDF2_ITERATIONS_DEFAULT;
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const key = await deriveKey(passphrase, salt, iterations);
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv: bufferOf(iv) }, key, bufferOf(plaintext)),
  );

  const out = new Uint8Array(
    MAGIC.length + 1 + ITER_BYTES + salt.length + iv.length + ciphertext.length,
  );
  let cursor = 0;
  out.set(MAGIC, cursor);
  cursor += MAGIC.length;
  out[cursor++] = FORMAT_VERSION;
  writeUint32BE(out, cursor, iterations);
  cursor += ITER_BYTES;
  out.set(salt, cursor);
  cursor += salt.length;
  out.set(iv, cursor);
  cursor += iv.length;
  out.set(ciphertext, cursor);

  return {
    blob: new Blob([out], { type: "application/octet-stream" }),
    meta: {
      exportedAt: dump.exportedAt,
      rowCount: Object.values(dump.tables).reduce((s, r) => s + r.length, 0),
      perTable: Object.fromEntries(Object.entries(dump.tables).map(([k, v]) => [k, v.length])),
    },
  };
}

export async function importEncryptedBackup(
  file: ArrayBuffer | Uint8Array,
  passphrase: string,
  opts?: { replace?: boolean },
): Promise<BackupMeta> {
  const bytes = file instanceof Uint8Array ? file : new Uint8Array(file);
  // Smallest possible valid file is a v1 header plus at least one ciphertext
  // byte; v2 is longer, so this also covers it.
  if (bytes.length < MAGIC.length + 1 + SALT_BYTES + IV_BYTES + 1) {
    throw new Error("Backup file is too short to be valid.");
  }
  for (let i = 0; i < MAGIC.length; i++) {
    if (bytes[i] !== MAGIC[i]) throw new Error("File is not a Parley backup.");
  }
  let cursor = MAGIC.length;
  const fmt = bytes[cursor++];

  let iterations: number;
  if (fmt === 1) {
    iterations = PBKDF2_ITERATIONS_V1;
  } else if (fmt === 2) {
    if (bytes.length < MAGIC.length + 1 + ITER_BYTES + SALT_BYTES + IV_BYTES + 1) {
      throw new Error("Backup file is too short to be valid.");
    }
    iterations = readUint32BE(bytes, cursor);
    cursor += ITER_BYTES;
    // Reject an implausible count before it reaches deriveKey (see bounds above).
    if (iterations < PBKDF2_ITERATIONS_MIN || iterations > PBKDF2_ITERATIONS_MAX) {
      throw new Error("Backup header declares an invalid PBKDF2 iteration count.");
    }
  } else {
    throw new Error(`Unsupported backup format version: ${fmt}`);
  }

  const salt = bytes.subarray(cursor, cursor + SALT_BYTES);
  cursor += SALT_BYTES;
  const iv = bytes.subarray(cursor, cursor + IV_BYTES);
  cursor += IV_BYTES;
  const ciphertext = bytes.subarray(cursor);

  let plaintext: ArrayBuffer;
  try {
    const key = await deriveKey(passphrase, salt, iterations);
    plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: bufferOf(iv) },
      key,
      bufferOf(ciphertext),
    );
  } catch {
    throw new Error("Wrong passphrase or the file has been tampered with.");
  }

  const dump = deserializeFromJson(JSON.parse(new TextDecoder().decode(plaintext))) as BackupDump;
  if (!dump.tables || typeof dump.tables !== "object") {
    throw new Error("Backup payload is malformed (missing `tables`).");
  }

  await applyDump(dump, !!opts?.replace);

  return {
    exportedAt: dump.exportedAt,
    rowCount: Object.values(dump.tables).reduce((s, r) => s + (Array.isArray(r) ? r.length : 0), 0),
    perTable: Object.fromEntries(
      Object.entries(dump.tables).map(([k, v]) => [k, Array.isArray(v) ? v.length : 0]),
    ),
  };
}

async function buildDump(): Promise<BackupDump> {
  const tables: Record<string, unknown[]> = {};
  for (const name of TABLE_NAMES) {
    const t = (db() as unknown as Record<string, { toArray: () => Promise<unknown[]> }>)[name];
    if (!t) continue;
    try {
      tables[name] = await t.toArray();
    } catch (err) {
      console.warn(`[backup] dump skipped table ${name}:`, err);
      tables[name] = [];
    }
  }
  return { version: FORMAT_VERSION, exportedAt: Date.now(), tables };
}

async function applyDump(dump: BackupDump, replace: boolean): Promise<void> {
  for (const name of TABLE_NAMES) {
    const rows = dump.tables[name];
    if (!Array.isArray(rows)) continue;
    const t = (
      db() as unknown as Record<
        string,
        { clear: () => Promise<void>; bulkPut: (rs: unknown[]) => Promise<unknown> }
      >
    )[name];
    if (!t) continue;
    try {
      if (replace) await t.clear();
      if (rows.length > 0) await t.bulkPut(rows);
    } catch (err) {
      console.warn(`[backup] import skipped table ${name}:`, err);
    }
  }
}

async function deriveKey(
  passphrase: string,
  salt: Uint8Array,
  iterations: number,
): Promise<CryptoKey> {
  const passKey = await crypto.subtle.importKey(
    "raw",
    bufferOf(new TextEncoder().encode(passphrase)),
    { name: "PBKDF2" },
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: bufferOf(salt),
      iterations,
      hash: "SHA-256",
    },
    passKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

function bufferOf(view: Uint8Array): ArrayBuffer {
  const out = new ArrayBuffer(view.byteLength);
  new Uint8Array(out).set(view);
  return out;
}

function writeUint32BE(buf: Uint8Array, offset: number, value: number): void {
  buf[offset] = (value >>> 24) & 0xff;
  buf[offset + 1] = (value >>> 16) & 0xff;
  buf[offset + 2] = (value >>> 8) & 0xff;
  buf[offset + 3] = value & 0xff;
}

function readUint32BE(buf: Uint8Array, offset: number): number {
  return (
    ((buf[offset] << 24) >>> 0) + (buf[offset + 1] << 16) + (buf[offset + 2] << 8) + buf[offset + 3]
  );
}

// --- Binary-aware JSON (de)serialization -----------------------------------
//
// ArrayBuffer and typed arrays serialize to `{}` under JSON.stringify, so any
// binary row field would be silently dropped. We walk the structure before
// stringify / after parse and replace each binary value with a tagged wrapper
// `{ "__ab__": "<base64>" }`. We can't lean on JSON.stringify's replacer alone:
// by the time the replacer sees an ArrayBuffer-valued property the engine has
// no enumerable keys to surface, and a typed array would already be coerced to
// an index map — so we transform explicitly here.

const AB_TAG = "__ab__";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function serializeForJson(value: unknown): unknown {
  if (value instanceof ArrayBuffer) {
    return { [AB_TAG]: bytesToBase64(new Uint8Array(value)) };
  }
  // Typed arrays / DataView: snapshot the exact bytes they view. On import they
  // come back as ArrayBuffer, matching the `audioBuffer: ArrayBuffer` schema.
  if (ArrayBuffer.isView(value)) {
    const view = value as ArrayBufferView;
    const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
    return { [AB_TAG]: bytesToBase64(bytes) };
  }
  if (Array.isArray(value)) {
    return value.map(serializeForJson);
  }
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = serializeForJson(v);
    }
    return out;
  }
  // string / number / boolean / null / undefined pass through untouched.
  return value;
}

function deserializeFromJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(deserializeFromJson);
  }
  if (isPlainObject(value)) {
    // A wrapper is exactly `{ __ab__: <string> }` and nothing else; anything
    // shaped differently is treated as an ordinary object so we never confuse
    // real data that happens to contain the key.
    const keys = Object.keys(value);
    if (keys.length === 1 && keys[0] === AB_TAG && typeof value[AB_TAG] === "string") {
      return base64ToBytes(value[AB_TAG] as string).buffer;
    }
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = deserializeFromJson(v);
    }
    return out;
  }
  return value;
}

function bytesToBase64(bytes: Uint8Array): string {
  // Chunked to stay well under the argument-count limit of String.fromCharCode
  // for large audio blobs.
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

export function suggestedBackupFilename(exportedAt: number = Date.now()): string {
  const d = new Date(exportedAt);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `parley-backup-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}.parlbak`;
}

export const __exportedForTests = {
  TABLE_NAMES,
  MAGIC,
  FORMAT_VERSION,
  serializeForJson,
  deserializeFromJson,
} as {
  TABLE_NAMES: readonly TableName[];
  MAGIC: Uint8Array;
  FORMAT_VERSION: number;
  serializeForJson: (value: unknown) => unknown;
  deserializeFromJson: (value: unknown) => unknown;
};
