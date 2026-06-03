import { useEffect, useState } from "react";

import { db, type Account } from "@/lib/db";

/**
 * On-device authentication. No third-party identity provider, no server.
 * Accounts live in IndexedDB on this device; passwords are stored only as a
 * PBKDF2-SHA256 hash with a per-account salt. The "session" is the currently
 * signed-in account id, kept in localStorage. Route guards run on the client
 * (the trust boundary here is the device itself, like a screen lock — this
 * gates access to local-first data, it is not a server security boundary).
 */

export type LocalUser = {
  id: string;
  email: string;
  is_admin: boolean;
};

const SESSION_KEY = "parley.session";
const SESSION_EVENT = "parley:session-changed";
const PBKDF2_ITERATIONS = 100_000;

// --------------------------------------------------------------------------
// Crypto helpers (Web Crypto — available in browsers and iPad Safari)
// --------------------------------------------------------------------------

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

function fromBase64(b64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

async function derive(password: string, salt: Uint8Array<ArrayBuffer>): Promise<string> {
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    enc.encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: PBKDF2_ITERATIONS, hash: "SHA-256" },
    keyMaterial,
    256,
  );
  return toBase64(new Uint8Array(bits));
}

async function hashPassword(
  password: string,
): Promise<{ passwordHash: string; salt: string }> {
  const saltBytes = crypto.getRandomValues(new Uint8Array(16));
  const passwordHash = await derive(password, saltBytes);
  return { passwordHash, salt: toBase64(saltBytes) };
}

async function verifyPassword(
  password: string,
  account: Account,
): Promise<boolean> {
  const candidate = await derive(password, fromBase64(account.salt));
  // Constant-time-ish compare (lengths are equal; PBKDF2 output is fixed-size).
  if (candidate.length !== account.passwordHash.length) return false;
  let diff = 0;
  for (let i = 0; i < candidate.length; i++) {
    diff |= candidate.charCodeAt(i) ^ account.passwordHash.charCodeAt(i);
  }
  return diff === 0;
}

function newId(): string {
  if (crypto.randomUUID) return crypto.randomUUID();
  return toBase64(crypto.getRandomValues(new Uint8Array(16))).replace(/[^a-zA-Z0-9]/g, "");
}

function toLocalUser(a: Account): LocalUser {
  return { id: a.id, email: a.email, is_admin: a.is_admin };
}

// --------------------------------------------------------------------------
// Session (localStorage)
// --------------------------------------------------------------------------

export function readSession(): LocalUser | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as LocalUser;
    if (!parsed || typeof parsed.id !== "string") return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeSession(user: LocalUser | null) {
  if (typeof window === "undefined") return;
  if (user) {
    window.localStorage.setItem(SESSION_KEY, JSON.stringify(user));
  } else {
    window.localStorage.removeItem(SESSION_KEY);
  }
  window.dispatchEvent(new Event(SESSION_EVENT));
}

// --------------------------------------------------------------------------
// Public API
// --------------------------------------------------------------------------

function normaliseEmail(email: string): string {
  return email.trim().toLowerCase();
}

export class AuthError extends Error {}

/** Create an account and sign in. The first account on a device becomes admin. */
export async function signUp(email: string, password: string): Promise<LocalUser> {
  const cleanEmail = email.trim();
  const emailKey = normaliseEmail(email);
  if (!emailKey || !emailKey.includes("@")) {
    throw new AuthError("Enter a valid email address.");
  }
  if (password.length < 6) {
    throw new AuthError("Password must be at least 6 characters.");
  }

  const existing = await db().accounts.where("emailKey").equals(emailKey).first();
  if (existing) {
    throw new AuthError("An account with that email already exists.");
  }

  const total = await db().accounts.count();
  const { passwordHash, salt } = await hashPassword(password);
  const account: Account = {
    id: newId(),
    email: cleanEmail,
    emailKey,
    passwordHash,
    salt,
    is_admin: total === 0, // first account on this device is the admin
    createdAt: Date.now(),
    lastSignInAt: Date.now(),
  };
  await db().accounts.add(account);
  const user = toLocalUser(account);
  writeSession(user);
  return user;
}

export async function signIn(email: string, password: string): Promise<LocalUser> {
  const emailKey = normaliseEmail(email);
  const account = await db().accounts.where("emailKey").equals(emailKey).first();
  if (!account) {
    throw new AuthError("No account found with that email.");
  }
  const ok = await verifyPassword(password, account);
  if (!ok) {
    throw new AuthError("Incorrect password.");
  }
  await db().accounts.update(account.id, { lastSignInAt: Date.now() });
  const user = toLocalUser(account);
  writeSession(user);
  return user;
}

export function signOut() {
  writeSession(null);
}

/** All accounts on this device (admin view). Never returns password material. */
export async function listLocalAccounts(): Promise<
  Array<Omit<Account, "passwordHash" | "salt">>
> {
  const all = await db().accounts.orderBy("createdAt").toArray();
  return all.map(({ passwordHash: _p, salt: _s, ...rest }) => rest);
}

// --------------------------------------------------------------------------
// React hook
// --------------------------------------------------------------------------

/**
 * Reads the current session. On the client, the initial value is read
 * synchronously from localStorage so client-side navigation has no flash;
 * `loading` is only true during the first render after SSR hydration.
 */
export function useLocalSession(): { user: LocalUser | null; loading: boolean } {
  const [user, setUser] = useState<LocalUser | null>(() => readSession());
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setUser(readSession());
    setLoading(false);

    function sync() {
      setUser(readSession());
    }
    window.addEventListener(SESSION_EVENT, sync);
    window.addEventListener("storage", sync);
    return () => {
      window.removeEventListener(SESSION_EVENT, sync);
      window.removeEventListener("storage", sync);
    };
  }, []);

  return { user, loading };
}
