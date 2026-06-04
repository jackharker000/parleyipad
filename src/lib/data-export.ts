import { db } from "@/lib/db";

/**
 * Per-account local data export. Walks every Dexie table, serialises each
 * row to JSON, replaces any Blob/File-valued field with a tagged base64
 * wrapper, and either downloads the result as plain JSON or as an AES-GCM-
 * encrypted binary file (PBKDF2-SHA256 derived key).
 *
 * Encryption is the recommended path (per the 21 May 2026 CLAUDE.md
 * decision: "encrypted local file export, no cloud backend"). Unencrypted
 * JSON is offered as a secondary affordance for users who explicitly want
 * to inspect their own data.
 *
 * Encrypted file layout (multi-byte fields are big-endian):
 *   [0..5]    magic "PARLEY" (0x50 0x41 0x52 0x4c 0x45 0x59)
 *   [6]       format version (== 1)
 *   [7..22]   PBKDF2 salt (16 bytes, random per export)
 *   [23..34]  AES-GCM IV (12 bytes, random per export)
 *   [35..]    ciphertext = AES-GCM(utf8(JSON.stringify(manifest)))
 *
 * PBKDF2 parameters: SHA-256, 250,000 iterations, 256-bit derived AES key.
 * This is intentionally lower than the cadence backup uses (600k) because
 * the export is a one-shot affordance the user is sitting waiting for,
 * not a repeated decrypt — keeping it snappy on iPad matters more than
 * squeezing the last factor of two out of brute-force resistance.
 *
 * Blob fields are detected dynamically (anything that is `instanceof Blob`
 * in a row's JSON tree). On the schema as it stands today that's the
 * `audio` field on voiceprintContributions and cachedPhraseAudio. Any
 * future Blob/File slot inherits this treatment automatically.
 */

const BLOB_TAG = "__blob";

type BlobWrapper = {
  [BLOB_TAG]: true;
  storagePath: null;
  sizeBytes: number;
  type: string;
  dataB64: string;
};

export type ExportManifest = {
  version: 1;
  exportedAt: string;
  accountId: string | null;
  encrypted: boolean;
  tables: Record<string, Array<Record<string, unknown>>>;
};

const MAGIC = new Uint8Array([0x50, 0x41, 0x52, 0x4c, 0x45, 0x59]); // "PARLEY"
const FORMAT_VERSION = 1;
const SALT_BYTES = 16;
const IV_BYTES = 12;
const PBKDF2_ITERATIONS = 250_000;

// --------------------------------------------------------------------------
// Manifest construction
// --------------------------------------------------------------------------

export async function buildExportManifest(opts?: {
  uid?: string | null;
}): Promise<ExportManifest> {
  const tables: Record<string, Array<Record<string, unknown>>> = {};
  for (const table of db().tables) {
    try {
      const rows = (await table.toArray()) as Array<Record<string, unknown>>;
      tables[table.name] = await Promise.all(
        rows.map((row) => serialiseRow(row) as Promise<Record<string, unknown>>),
      );
    } catch (err) {
      console.warn(`[data-export] skipped table ${table.name}:`, err);
      tables[table.name] = [];
    }
  }
  return {
    version: 1,
    exportedAt: new Date().toISOString(),
    accountId: opts?.uid ?? null,
    encrypted: false,
    tables,
  };
}

async function serialiseRow(value: unknown): Promise<unknown> {
  if (value instanceof Blob) {
    const buf = await value.arrayBuffer();
    const wrapper: BlobWrapper = {
      [BLOB_TAG]: true,
      storagePath: null,
      sizeBytes: value.size,
      type: value.type || "application/octet-stream",
      dataB64: bytesToBase64(new Uint8Array(buf)),
    };
    return wrapper;
  }
  if (value instanceof ArrayBuffer) {
    const wrapper: BlobWrapper = {
      [BLOB_TAG]: true,
      storagePath: null,
      sizeBytes: value.byteLength,
      type: "application/octet-stream",
      dataB64: bytesToBase64(new Uint8Array(value)),
    };
    return wrapper;
  }
  if (ArrayBuffer.isView(value)) {
    const view = value as ArrayBufferView;
    const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
    const wrapper: BlobWrapper = {
      [BLOB_TAG]: true,
      storagePath: null,
      sizeBytes: bytes.byteLength,
      type: "application/octet-stream",
      dataB64: bytesToBase64(bytes),
    };
    return wrapper;
  }
  if (Array.isArray(value)) {
    const out: unknown[] = [];
    for (const v of value) out.push(await serialiseRow(v));
    return out;
  }
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = await serialiseRow(v);
    }
    return out;
  }
  return value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

// --------------------------------------------------------------------------
// Blob preparation (shared by downloadExport + the UI receipt path)
// --------------------------------------------------------------------------

export type PreparedExport = {
  blob: Blob;
  filename: string;
  manifest: ExportManifest;
};

/**
 * Build the final file (Blob + filename) without writing it to disk. The
 * settings card uses this so it can show the filename and size on the
 * success line; `downloadExport` is a thin wrapper that prepares and then
 * triggers the download. Same code path, single source of truth.
 */
export async function prepareExport(opts?: {
  uid?: string | null;
  password?: string;
  filenamePrefix?: string;
}): Promise<PreparedExport> {
  const manifest = await buildExportManifest({ uid: opts?.uid ?? null });
  const password = opts?.password?.trim() ?? "";
  const prefix = opts?.filenamePrefix ?? "parley-export";
  const stamp = filenameStamp(new Date());

  if (password.length > 0) {
    manifest.encrypted = true;
    const plaintext = new TextEncoder().encode(JSON.stringify(manifest));
    const encrypted = await encryptManifest(plaintext, password);
    return {
      blob: new Blob([toArrayBuffer(encrypted)], { type: "application/octet-stream" }),
      filename: `${prefix}-${stamp}.parley.enc`,
      manifest,
    };
  }
  return {
    blob: new Blob([JSON.stringify(manifest, null, 2)], { type: "application/json" }),
    filename: `${prefix}-${stamp}.json`,
    manifest,
  };
}

// --------------------------------------------------------------------------
// Download
// --------------------------------------------------------------------------

export async function downloadExport(opts?: {
  uid?: string | null;
  password?: string;
  filenamePrefix?: string;
}): Promise<void> {
  const { blob, filename } = await prepareExport(opts);
  triggerDownload(blob, filename);
}

function triggerDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  try {
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.rel = "noopener";
    document.body.appendChild(a);
    a.click();
    a.remove();
  } finally {
    // Defer revocation a tick so Safari has time to start the download.
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}

export function triggerExportDownload(prepared: PreparedExport): void {
  triggerDownload(prepared.blob, prepared.filename);
}

// --------------------------------------------------------------------------
// Encryption
// --------------------------------------------------------------------------

async function encryptManifest(plaintext: Uint8Array, password: string): Promise<Uint8Array> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const key = await deriveKey(password, salt);
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: toArrayBuffer(iv) },
      key,
      toArrayBuffer(plaintext),
    ),
  );
  const out = new Uint8Array(
    MAGIC.length + 1 + salt.length + iv.length + ciphertext.length,
  );
  let cursor = 0;
  out.set(MAGIC, cursor);
  cursor += MAGIC.length;
  out[cursor++] = FORMAT_VERSION;
  out.set(salt, cursor);
  cursor += salt.length;
  out.set(iv, cursor);
  cursor += iv.length;
  out.set(ciphertext, cursor);
  return out;
}

async function deriveKey(password: string, salt: Uint8Array): Promise<CryptoKey> {
  const passKey = await crypto.subtle.importKey(
    "raw",
    toArrayBuffer(new TextEncoder().encode(password)),
    { name: "PBKDF2" },
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: toArrayBuffer(salt),
      iterations: PBKDF2_ITERATIONS,
      hash: "SHA-256",
    },
    passKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt"],
  );
}

// --------------------------------------------------------------------------
// Utilities
// --------------------------------------------------------------------------

function toArrayBuffer(view: Uint8Array): ArrayBuffer {
  const out = new ArrayBuffer(view.byteLength);
  new Uint8Array(out).set(view);
  return out;
}

function bytesToBase64(bytes: Uint8Array): string {
  // Chunked to stay well under the argument-count limit of
  // String.fromCharCode for large audio blobs (voice samples can be MBs).
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(
      null,
      Array.from(bytes.subarray(i, i + chunk)) as unknown as number[],
    );
  }
  return btoa(binary);
}

function filenameStamp(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}
