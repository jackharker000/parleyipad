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
 * Format on disk (little-endian byte layout):
 *   [0..3]    magic 'PRLY' (0x50 0x52 0x4c 0x59)
 *   [4]       format version (currently 1)
 *   [5..20]   PBKDF2 salt (16 bytes, random per backup)
 *   [21..32]  AES-GCM IV (12 bytes, random per backup)
 *   [33..]    ciphertext = AES-GCM(plaintext = utf8(JSON.stringify(dump)))
 *
 * `dump` shape: `{ version, exportedAt, tables: Record<tableName, rows[]> }`.
 * Each table name matches the Dexie property, so import can do a
 * `db()[name].bulkPut(rows)` loop without a mapping table.
 */

const MAGIC = new Uint8Array([0x50, 0x52, 0x4c, 0x59]); // "PRLY"
const FORMAT_VERSION = 1;
const SALT_BYTES = 16;
const IV_BYTES = 12;
const PBKDF2_ITERATIONS = 200_000;

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
  const plaintext = new TextEncoder().encode(JSON.stringify(dump));

  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const key = await deriveKey(passphrase, salt);
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv: bufferOf(iv) }, key, bufferOf(plaintext)),
  );

  const out = new Uint8Array(MAGIC.length + 1 + salt.length + iv.length + ciphertext.length);
  let cursor = 0;
  out.set(MAGIC, cursor);
  cursor += MAGIC.length;
  out[cursor++] = FORMAT_VERSION;
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
  if (bytes.length < MAGIC.length + 1 + SALT_BYTES + IV_BYTES + 1) {
    throw new Error("Backup file is too short to be valid.");
  }
  for (let i = 0; i < MAGIC.length; i++) {
    if (bytes[i] !== MAGIC[i]) throw new Error("File is not a Parley backup.");
  }
  let cursor = MAGIC.length;
  const fmt = bytes[cursor++];
  if (fmt !== FORMAT_VERSION) {
    throw new Error(`Unsupported backup format version: ${fmt}`);
  }
  const salt = bytes.subarray(cursor, cursor + SALT_BYTES);
  cursor += SALT_BYTES;
  const iv = bytes.subarray(cursor, cursor + IV_BYTES);
  cursor += IV_BYTES;
  const ciphertext = bytes.subarray(cursor);

  let plaintext: ArrayBuffer;
  try {
    const key = await deriveKey(passphrase, salt);
    plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: bufferOf(iv) },
      key,
      bufferOf(ciphertext),
    );
  } catch {
    throw new Error("Wrong passphrase or the file has been tampered with.");
  }

  const dump = JSON.parse(new TextDecoder().decode(plaintext)) as BackupDump;
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

async function deriveKey(passphrase: string, salt: Uint8Array): Promise<CryptoKey> {
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
      iterations: PBKDF2_ITERATIONS,
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

export function suggestedBackupFilename(exportedAt: number = Date.now()): string {
  const d = new Date(exportedAt);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `parley-backup-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}.parlbak`;
}

export const __exportedForTests = { TABLE_NAMES, MAGIC, FORMAT_VERSION } as {
  TABLE_NAMES: readonly TableName[];
  MAGIC: Uint8Array;
  FORMAT_VERSION: number;
};
