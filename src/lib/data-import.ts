import { db } from "@/lib/db";
import { decryptManifestBytes, hasParleyMagic } from "@/lib/crypto-passphrase";
import type { ExportManifest } from "@/lib/data-export";

/**
 * Restore counterpart to `data-export.ts`. Reads the user's encrypted
 * `.parley.enc` (or plain `.json`) export back into Dexie. The on-disk
 * format is described in `crypto-passphrase.ts`; the manifest shape and
 * the blob-wrapper convention are owned by `data-export.ts`.
 *
 * Two-step usage by the UI:
 *
 *   1. `parseExportFile(file)` — magic-sniffs the bytes. Returns either a
 *      ready-to-restore manifest (plain JSON), or a stub flagged
 *      `encryptedNeedsPassword: true` (encrypted, no password supplied).
 *   2. `parseExportFile(file, password)` — same call with the password.
 *      Returns a decrypted, parsed manifest, or throws on wrong password.
 *
 * Then the UI calls `restoreFromManifest(manifest)` which atomically wipes
 * every Dexie table and writes back the rows in the manifest. The caller
 * is responsible for pausing the cloud-sync engine first — see the
 * import card for the sequencing — otherwise the Dexie hooks will spam
 * the outbox with a row per restored entry.
 */

// --------------------------------------------------------------------------
// File parsing
// --------------------------------------------------------------------------

export type ParsedExport = {
  manifest: ExportManifest;
  fileType: "encrypted" | "json";
  fileBytes: number;
  /** True only when the file is encrypted and no usable password was given. */
  encryptedNeedsPassword: boolean;
};

/**
 * Read the file. Detects format by magic bytes:
 *   - "PARLEY" → encrypted, needs the password to surface the manifest
 *   - anything else → plain JSON manifest
 *
 * For encrypted files, callers can pass `password === undefined` (or "") to
 * get back a stub with `encryptedNeedsPassword: true` plus a sentinel
 * manifest the UI shouldn't show — that signals "ask the user for a
 * password and call me again". Supplying a non-empty password triggers
 * decryption + manifest parse; wrong password throws `Wrong password or
 * the file is corrupt.` (from `decryptManifestBytes`).
 */
export async function parseExportFile(file: File, password?: string): Promise<ParsedExport> {
  const buf = await file.arrayBuffer();
  const bytes = new Uint8Array(buf);
  const isEncrypted = hasParleyMagic(bytes);

  if (isEncrypted) {
    const pw = password?.trim() ?? "";
    if (pw.length === 0) {
      // Stub return — the caller is responsible for not reading
      // `manifest` until `encryptedNeedsPassword === false`.
      return {
        manifest: PLACEHOLDER_MANIFEST,
        fileType: "encrypted",
        fileBytes: file.size,
        encryptedNeedsPassword: true,
      };
    }
    const plaintext = await decryptManifestBytes(bytes, pw);
    const manifest = parseManifestJson(plaintext);
    return {
      manifest,
      fileType: "encrypted",
      fileBytes: file.size,
      encryptedNeedsPassword: false,
    };
  }

  // Plain JSON. UTF-8 decode, parse, validate.
  const text = new TextDecoder().decode(bytes);
  const manifest = parseManifestJson(text);
  return {
    manifest,
    fileType: "json",
    fileBytes: file.size,
    encryptedNeedsPassword: false,
  };
}

function parseManifestJson(input: string | Uint8Array): ExportManifest {
  const text = typeof input === "string" ? input : new TextDecoder().decode(input);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("This file isn't valid JSON — it might be the wrong file.");
  }
  if (!isManifestShape(parsed)) {
    throw new Error("This doesn't look like a Parley export — the manifest is malformed.");
  }
  if (parsed.version !== 1) {
    throw new Error(
      `Unsupported export version (${parsed.version}). This build only reads version 1.`,
    );
  }
  return parsed;
}

function isManifestShape(value: unknown): value is ExportManifest {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  if (typeof v.version !== "number") return false;
  if (typeof v.exportedAt !== "string") return false;
  if (typeof v.tables !== "object" || v.tables === null) return false;
  // accountId is `string | null` and `encrypted` is `boolean`, but we don't
  // hard-fail on those — older or hand-edited files might omit them, and
  // they're not load-bearing for restore.
  return true;
}

const PLACEHOLDER_MANIFEST: ExportManifest = {
  version: 1,
  exportedAt: "",
  accountId: null,
  encrypted: true,
  tables: {},
};

// --------------------------------------------------------------------------
// Restore
// --------------------------------------------------------------------------

export type RestoreSummary = {
  tablesRestored: number;
  rowsWritten: number;
  blobsWritten: number;
  durationMs: number;
};

/**
 * Wipe every Dexie table THEN write back rows from the manifest. Atomic —
 * the whole thing runs inside one `rw` transaction across every table.
 *
 * Blob wrappers (`{ __blob: true, dataB64, type, sizeBytes }` from
 * data-export.ts) are re-hydrated:
 *   - `type === "application/octet-stream"` → `ArrayBuffer` (matches the
 *     CachedPhraseAudio.audioBuffer slot, which is the only typed-buffer
 *     field in the schema today)
 *   - anything else → `Blob` (preserves the original MIME type)
 *
 * Tables in the manifest that don't exist in this schema version are
 * skipped with a warning — forward-compat for restoring a newer export
 * into an older build.
 *
 * The outbox is cleared at the tail of the transaction so the sync engine
 * has no stale work to do when the caller reloads. (The "new-only" cursor
 * would skip the restored rows anyway since their `updatedAt` predates
 * the engine start, but we don't want even the no-op cycles.)
 *
 * IMPORTANT: the caller MUST pause the cloud-sync engine BEFORE calling
 * this — every restored row would otherwise fire a Dexie `creating` hook
 * that enqueues an outbox upsert.
 */
export async function restoreFromManifest(manifest: ExportManifest): Promise<RestoreSummary> {
  const startedAt = Date.now();
  let tablesRestored = 0;
  let rowsWritten = 0;
  let blobsWritten = 0;

  const d = db();
  const knownTables = new Set(d.tables.map((t) => t.name));

  // Pre-compute the rehydrated payload per table so the blob decode work
  // happens outside the Dexie transaction (atob + Uint8Array allocation
  // can be heavy for MBs of audio; we don't want to hold the rw lock for
  // that). Counts of newly-allocated blobs are tracked here so the
  // summary line is accurate.
  const prepared: Array<{ table: string; rows: unknown[] }> = [];
  for (const [name, rawRows] of Object.entries(manifest.tables)) {
    if (!knownTables.has(name)) {
      console.warn(`[data-import] skipping unknown table "${name}" — not in this schema version.`);
      continue;
    }
    if (!Array.isArray(rawRows)) {
      console.warn(`[data-import] skipping table "${name}" — payload is not an array.`);
      continue;
    }
    const rows: unknown[] = [];
    for (const row of rawRows) {
      const { value, blobCount } = rehydrate(row);
      rows.push(value);
      blobsWritten += blobCount;
    }
    prepared.push({ table: name, rows });
    rowsWritten += rows.length;
    tablesRestored += 1;
  }

  await d.transaction("rw", d.tables, async () => {
    // Wipe every Dexie table (including ones absent from the manifest —
    // restore is a full replace, not a merge).
    for (const table of d.tables) {
      await table.clear();
    }
    // Write the manifest rows back, table by table. `bulkPut` instead of
    // `bulkAdd` so any quirky duplicate primary key in the source file
    // doesn't kill the whole transaction — last write wins is fine, the
    // source is the user's own export.
    for (const { table, rows } of prepared) {
      if (rows.length === 0) continue;
      await d.table(table).bulkPut(rows as Record<string, unknown>[]);
    }
  });

  return {
    tablesRestored,
    rowsWritten,
    blobsWritten,
    durationMs: Date.now() - startedAt,
  };
}

// --------------------------------------------------------------------------
// Blob rehydration
// --------------------------------------------------------------------------

const BLOB_TAG = "__blob";

type BlobWrapper = {
  [BLOB_TAG]: true;
  type?: string;
  dataB64: string;
  sizeBytes?: number;
};

function isBlobWrapper(value: unknown): value is BlobWrapper {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return v[BLOB_TAG] === true && typeof v.dataB64 === "string";
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Walk a JSON-parsed row, swapping every blob-wrapper for the real
 * binary. Mirrors the encoder in `data-export.ts` exactly so a row
 * round-trips bit-for-bit.
 *
 * Returns the rehydrated value plus a count of binaries we materialised
 * (used for the summary line in the UI).
 */
function rehydrate(value: unknown): { value: unknown; blobCount: number } {
  if (isBlobWrapper(value)) {
    const bytes = base64ToBytes(value.dataB64);
    const mime = value.type ?? "application/octet-stream";
    // `audioBuffer: ArrayBuffer` on cachedPhraseAudio is the only Dexie
    // slot that wants the bare ArrayBuffer back. octet-stream is the
    // marker the encoder uses for ArrayBuffer / typed-array inputs, so
    // we restore octet-stream wrappers as ArrayBuffer and everything
    // else as a Blob (preserving the original MIME).
    //
    // `Uint8Array.buffer` is typed `ArrayBufferLike` (it could be a
    // SharedArrayBuffer), so we copy into a fresh ArrayBuffer for both
    // branches. The blob branch needs the same copy because the
    // `BlobPart` slot also rejects ArrayBufferLike-backed views.
    const ab = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(ab).set(bytes);
    const restored: ArrayBuffer | Blob =
      mime === "application/octet-stream" ? ab : new Blob([ab], { type: mime });
    return { value: restored, blobCount: 1 };
  }
  if (Array.isArray(value)) {
    let count = 0;
    const out: unknown[] = [];
    for (const item of value) {
      const r = rehydrate(item);
      out.push(r.value);
      count += r.blobCount;
    }
    return { value: out, blobCount: count };
  }
  if (isPlainObject(value)) {
    let count = 0;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      const r = rehydrate(v);
      out[k] = r.value;
      count += r.blobCount;
    }
    return { value: out, blobCount: count };
  }
  return { value, blobCount: 0 };
}

function base64ToBytes(b64: string): Uint8Array {
  // Mirror the chunked encode in data-export.ts. atob is single-shot
  // (no chunking needed on the way back), but the resulting binary
  // string can be large — copy into a Uint8Array byte-by-byte.
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}
