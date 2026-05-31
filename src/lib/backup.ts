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
 *     [0..3]    magic 'PRLY' (0x50 0x52 0x4c 0x59)
 *     [4]       format version (== 2)
 *     [5..8]    PBKDF2 iterations (uint32, big-endian)
 *     [9..24]   PBKDF2 salt (16 bytes, random per backup)
 *     [25..36]  AES-GCM IV (12 bytes, random per backup)
 *     [37..]    ciphertext = AES-GCM(plaintext)
 *
 * Binary row fields (e.g. `cachedPhraseAudio.audioBuffer`) don't survive
 * a plain JSON.stringify — the serializer base64-tags ArrayBuffer/typed
 * arrays and decodes them on import so every table round-trips losslessly.
 */

const MAGIC = new Uint8Array([0x50, 0x52, 0x4c, 0x59]); // "PRLY"
const FORMAT_VERSION = 2;
const SALT_BYTES = 16;
const IV_BYTES = 12;
const ITER_BYTES = 4;
const PBKDF2_ITERATIONS_DEFAULT = 600_000;
const PBKDF2_ITERATIONS_MIN = 1;
const PBKDF2_ITERATIONS_MAX = 10_000_000;

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

function listTables() {
  // Drive directly off the Dexie instance so a new table joins the backup
  // automatically (no hand-kept allow-list to drift out of sync).
  return db.tables;
}

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
  out.set(MAGIC, cursor); cursor += MAGIC.length;
  out[cursor++] = FORMAT_VERSION;
  writeUint32BE(out, cursor, iterations); cursor += ITER_BYTES;
  out.set(salt, cursor); cursor += salt.length;
  out.set(iv, cursor); cursor += iv.length;
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
  if (bytes.length < MAGIC.length + 1 + ITER_BYTES + SALT_BYTES + IV_BYTES + 1) {
    throw new Error("Backup file is too short to be valid.");
  }
  for (let i = 0; i < MAGIC.length; i++) {
    if (bytes[i] !== MAGIC[i]) throw new Error("File is not a Parley backup.");
  }
  let cursor = MAGIC.length;
  const fmt = bytes[cursor++];
  if (fmt !== FORMAT_VERSION) throw new Error(`Unsupported backup format version: ${fmt}`);
  const iterations = readUint32BE(bytes, cursor);
  cursor += ITER_BYTES;
  if (iterations < PBKDF2_ITERATIONS_MIN || iterations > PBKDF2_ITERATIONS_MAX) {
    throw new Error("Backup header declares an invalid PBKDF2 iteration count.");
  }
  const salt = bytes.subarray(cursor, cursor + SALT_BYTES); cursor += SALT_BYTES;
  const iv = bytes.subarray(cursor, cursor + IV_BYTES); cursor += IV_BYTES;
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
  for (const t of listTables()) {
    try {
      tables[t.name] = await t.toArray();
    } catch (err) {
      console.warn(`[backup] dump skipped ${t.name}:`, err);
      tables[t.name] = [];
    }
  }
  return { version: FORMAT_VERSION, exportedAt: Date.now(), tables };
}

async function applyDump(dump: BackupDump, replace: boolean): Promise<void> {
  for (const t of listTables()) {
    const rows = dump.tables[t.name];
    if (!Array.isArray(rows)) continue;
    try {
      if (replace) await t.clear();
      if (rows.length > 0) await t.bulkPut(rows);
    } catch (err) {
      console.warn(`[backup] import skipped ${t.name}:`, err);
    }
  }
}

async function deriveKey(passphrase: string, salt: Uint8Array, iterations: number) {
  const passKey = await crypto.subtle.importKey(
    "raw",
    bufferOf(new TextEncoder().encode(passphrase)),
    { name: "PBKDF2" },
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: bufferOf(salt), iterations, hash: "SHA-256" },
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
  return ((buf[offset] << 24) >>> 0) + (buf[offset + 1] << 16) + (buf[offset + 2] << 8) + buf[offset + 3];
}

const AB_TAG = "__ab__";
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}
function serializeForJson(value: unknown): unknown {
  if (value instanceof ArrayBuffer) return { [AB_TAG]: bytesToBase64(new Uint8Array(value)) };
  if (ArrayBuffer.isView(value)) {
    const view = value as ArrayBufferView;
    return { [AB_TAG]: bytesToBase64(new Uint8Array(view.buffer, view.byteOffset, view.byteLength)) };
  }
  if (Array.isArray(value)) return value.map(serializeForJson);
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = serializeForJson(v);
    return out;
  }
  return value;
}
function deserializeFromJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(deserializeFromJson);
  if (isPlainObject(value)) {
    const keys = Object.keys(value);
    if (keys.length === 1 && keys[0] === AB_TAG && typeof value[AB_TAG] === "string") {
      return base64ToBytes(value[AB_TAG] as string).buffer;
    }
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = deserializeFromJson(v);
    return out;
  }
  return value;
}
function bytesToBase64(bytes: Uint8Array): string {
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
