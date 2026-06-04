/**
 * Shared passphrase-encrypted file format used by `data-export.ts` (writer)
 * and `data-import.ts` (reader). Single source of truth for the magic
 * header, the PBKDF2 parameters, and the AES-GCM wrap/unwrap routines.
 *
 * File layout (multi-byte fields are big-endian):
 *   [0..5]    magic "PARLEY" (0x50 0x41 0x52 0x4c 0x45 0x59)
 *   [6]       format version (== 1)
 *   [7..22]   PBKDF2 salt (16 bytes, random per export)
 *   [23..34]  AES-GCM IV (12 bytes, random per export)
 *   [35..]    ciphertext = AES-GCM(utf8(JSON.stringify(manifest)))
 *
 * PBKDF2 parameters: SHA-256, 250,000 iterations, 256-bit derived AES key.
 * Sized for snappy decryption on iPad (the user is sitting waiting for it).
 */

export const PARLEY_MAGIC = new Uint8Array([0x50, 0x41, 0x52, 0x4c, 0x45, 0x59]); // "PARLEY"
export const PARLEY_FORMAT_VERSION = 1;
export const SALT_BYTES = 16;
export const IV_BYTES = 12;
export const PBKDF2_ITERATIONS = 250_000;
export const HEADER_BYTES = PARLEY_MAGIC.length + 1 + SALT_BYTES + IV_BYTES; // 35

/**
 * Returns true if the buffer starts with the "PARLEY" magic. Cheap probe
 * the import card uses before deciding whether to ask for a password.
 */
export function hasParleyMagic(bytes: Uint8Array): boolean {
  if (bytes.length < PARLEY_MAGIC.length) return false;
  for (let i = 0; i < PARLEY_MAGIC.length; i++) {
    if (bytes[i] !== PARLEY_MAGIC[i]) return false;
  }
  return true;
}

/**
 * Wrap plaintext bytes into the encrypted Parley file format. Used by the
 * export path. Returns the full file body (magic + version + salt + iv +
 * ciphertext) as a single Uint8Array ready to drop into a Blob.
 */
export async function encryptManifestBytes(
  plaintext: Uint8Array,
  password: string,
): Promise<Uint8Array> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const key = await deriveKey(password, salt, ["encrypt"]);
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: toArrayBuffer(iv) },
      key,
      toArrayBuffer(plaintext),
    ),
  );
  const out = new Uint8Array(
    PARLEY_MAGIC.length + 1 + salt.length + iv.length + ciphertext.length,
  );
  let cursor = 0;
  out.set(PARLEY_MAGIC, cursor);
  cursor += PARLEY_MAGIC.length;
  out[cursor++] = PARLEY_FORMAT_VERSION;
  out.set(salt, cursor);
  cursor += salt.length;
  out.set(iv, cursor);
  cursor += iv.length;
  out.set(ciphertext, cursor);
  return out;
}

/**
 * Unwrap an encrypted Parley file back to plaintext bytes. Used by the
 * import path. Throws on malformed header, unsupported format version, or
 * wrong password (AES-GCM auth-tag failure → OperationError → friendlier
 * message).
 */
export async function decryptManifestBytes(
  file: Uint8Array,
  password: string,
): Promise<Uint8Array> {
  if (!hasParleyMagic(file)) {
    throw new Error("This doesn't look like a Parley encrypted export.");
  }
  if (file.length < HEADER_BYTES) {
    throw new Error("Encrypted file is truncated — header is incomplete.");
  }
  const version = file[PARLEY_MAGIC.length];
  if (version !== PARLEY_FORMAT_VERSION) {
    throw new Error(
      `Unsupported export format version (${version}). This build only reads version ${PARLEY_FORMAT_VERSION}.`,
    );
  }
  const saltStart = PARLEY_MAGIC.length + 1;
  const ivStart = saltStart + SALT_BYTES;
  const ciphertextStart = ivStart + IV_BYTES;
  const salt = file.subarray(saltStart, ivStart);
  const iv = file.subarray(ivStart, ciphertextStart);
  const ciphertext = file.subarray(ciphertextStart);
  const key = await deriveKey(password, salt, ["decrypt"]);
  try {
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: toArrayBuffer(iv) },
      key,
      toArrayBuffer(ciphertext),
    );
    return new Uint8Array(plaintext);
  } catch {
    // subtle.decrypt throws an OperationError on auth-tag mismatch — the
    // canonical signal for wrong password (or a tampered/corrupt file).
    throw new Error("Wrong password or the file is corrupt.");
  }
}

async function deriveKey(
  password: string,
  salt: Uint8Array,
  usages: KeyUsage[],
): Promise<CryptoKey> {
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
    usages,
  );
}

/**
 * SubtleCrypto rejects views over SharedArrayBuffer in some runtimes;
 * copy into a fresh ArrayBuffer so every call site is safe.
 */
function toArrayBuffer(view: Uint8Array): ArrayBuffer {
  const out = new ArrayBuffer(view.byteLength);
  new Uint8Array(out).set(view);
  return out;
}
