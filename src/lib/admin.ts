import { getIdToken } from "@/lib/auth";

/**
 * Admin data helpers — Firebase-backed, cross-device.
 *
 * Accounts live in Firebase Auth (not on-device any more), so the admin
 * dashboard sees *every* Parley account regardless of which device created it.
 * Data comes from two keyed server routes that hold the Firebase Admin SDK and
 * verify the caller carries the `admin` custom claim:
 *
 *   POST /api/admin/users → { users: AdminUserRecord[] }   (all users, newest first)
 *   POST /api/admin/user  → { user: AdminUserRecord }       (one user by uid)
 *
 * These are plain client fetch helpers. Firebase auth state only exists in the
 * browser, so they must be called from components (useEffect), never from
 * route loaders (which run during SSR where there is no signed-in user).
 */

export type AdminUserRecord = {
  uid: string;
  email: string | null;
  displayName: string | null;
  is_admin: boolean;
  disabled: boolean;
  createdAt: string | null; // ISO string (Firebase metadata.creationTime)
  lastSignInAt: string | null; // ISO string
  provider: string | null; // e.g. "password"
};

/** Error from an /api/admin/* call, carrying the HTTP status for the pages. */
export class AdminApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "AdminApiError";
    this.status = status;
  }
}

const SERVICE_ACCOUNT_MISSING =
  "Admin features need the Firebase service account configured on the server. See docs/setup.md.";

async function authedFetch(
  path: string,
  extraBody: Record<string, unknown> = {},
): Promise<Response> {
  const token = await getIdToken();
  if (!token) throw new AdminApiError(401, "Not signed in.");
  return fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ idToken: token, ...extraBody }),
  });
}

async function parseError(res: Response): Promise<never> {
  if (res.status === 503) {
    throw new AdminApiError(503, SERVICE_ACCOUNT_MISSING);
  }
  let message = "Request failed";
  try {
    const body = (await res.json()) as { error?: string };
    if (body.error) message = body.error;
  } catch {
    // non-JSON body — keep the generic message
  }
  throw new AdminApiError(res.status, message);
}

// Module-level caches so callers on different pages don't re-fetch within a
// short stale window. Pass `{ force: true }` to bypass.
const CACHE_TTL_MS = 30_000;
let usersCache: { value: AdminUserRecord[]; at: number } | null = null;
const usageCache = new Map<number, { value: UsageAggregate; at: number }>();

/** Fetch every Parley account (newest first). Throws AdminApiError on failure. */
export async function fetchUsers(opts?: { force?: boolean }): Promise<AdminUserRecord[]> {
  if (!opts?.force && usersCache && Date.now() - usersCache.at < CACHE_TTL_MS) {
    return usersCache.value;
  }
  const res = await authedFetch("/api/admin/users");
  if (!res.ok) return parseError(res);
  const body = (await res.json()) as { users: AdminUserRecord[] };
  usersCache = { value: body.users, at: Date.now() };
  return body.users;
}

/** Fetch a single account by uid. Returns null if it doesn't exist (404). */
export async function fetchUser(uid: string): Promise<AdminUserRecord | null> {
  const res = await authedFetch("/api/admin/user", { uid });
  if (res.status === 404) return null;
  if (!res.ok) return parseError(res);
  const body = (await res.json()) as { user: AdminUserRecord };
  return body.user;
}

// --------------------------------------------------------------------------
// Usage aggregates (from /api/admin/usage)
// --------------------------------------------------------------------------

export type UsageUserBucket = {
  uid: string | null;
  events: number;
  tokensIn: number;
  tokensOut: number;
  characters: number;
  audioBytes: number;
  millicents: number;
};

export type UsageKindBucket = { kind: string; events: number; millicents: number };
export type UsageProviderBucket = { provider: string; events: number; millicents: number };

export type UsageAggregate = {
  totals: {
    events: number;
    tokensIn: number;
    tokensOut: number;
    characters: number;
    audioBytes: number;
    millicents: number;
  };
  byUser: UsageUserBucket[];
  byKind: UsageKindBucket[];
  byProvider: UsageProviderBucket[];
  days: number;
  rangeFrom: string;
  rangeTo: string;
};

/** Fetch aggregated usage_events for the last `days` days. */
export async function fetchUsage(
  days = 30,
  opts?: { force?: boolean },
): Promise<UsageAggregate> {
  const cached = usageCache.get(days);
  if (!opts?.force && cached && Date.now() - cached.at < CACHE_TTL_MS) {
    return cached.value;
  }
  const res = await authedFetch("/api/admin/usage", { days });
  if (!res.ok) return parseError(res);
  const body = (await res.json()) as { aggregate: UsageAggregate };
  usageCache.set(days, { value: body.aggregate, at: Date.now() });
  return body.aggregate;
}

// --------------------------------------------------------------------------
// Synced per-user data (from /api/admin/user-data)
// --------------------------------------------------------------------------

/**
 * Fetch decoded Firestore rows from `users/{uid}/<table>`. Each row is the
 * Dexie row's JSON (with Blob fields swapped for `{ storagePath, sizeBytes }`).
 * Defaults to 100 rows per call; the server caps at 500.
 */
export async function fetchUserData(
  uid: string,
  table: string,
  limit = 100,
): Promise<Array<Record<string, unknown>>> {
  const res = await authedFetch("/api/admin/user-data", { uid, table, limit });
  if (!res.ok) return parseError(res);
  const body = (await res.json()) as { rows: Array<Record<string, unknown>> };
  return body.rows;
}

// --------------------------------------------------------------------------
// Signed audio playback (from /api/admin/audio-url)
// --------------------------------------------------------------------------

/** Single-shared <audio> instance so triggering a new clip stops the previous. */
let currentAudio: HTMLAudioElement | null = null;

/**
 * Fetch a short-lived signed URL for a Storage blob and play it. If another
 * clip is already playing, it is paused first. Returns the Audio element so
 * callers can pause/resume by tracking the same ref.
 */
export async function playAudioFromAdminUrl(
  storagePath: string,
): Promise<HTMLAudioElement> {
  const res = await authedFetch("/api/admin/audio-url", { storagePath });
  if (!res.ok) return parseError(res);
  const { url } = (await res.json()) as { url: string };

  if (currentAudio) {
    try {
      currentAudio.pause();
    } catch {
      // ignore
    }
  }

  const audio = new Audio(url);
  currentAudio = audio;
  await audio.play();
  return audio;
}

/** Stop any audio started via playAudioFromAdminUrl. Safe to call any time. */
export function stopAdminAudio(): void {
  if (currentAudio) {
    try {
      currentAudio.pause();
    } catch {
      // ignore
    }
    currentAudio = null;
  }
}

// --------------------------------------------------------------------------
// Display helpers shared by the admin pages.
// --------------------------------------------------------------------------

/**
 * Compact relative-time string (e.g. "3h ago", "yesterday", "2 weeks ago").
 * Returns "—" when the input can't be parsed. Falls back to a few sensible
 * thresholds without bringing in a date library.
 */
export function relativeTime(input: string | number | Date | null | undefined): string {
  if (input == null) return "—";
  const d =
    input instanceof Date
      ? input
      : typeof input === "number"
        ? new Date(input)
        : new Date(input);
  if (Number.isNaN(d.getTime())) return "—";

  const diffMs = Date.now() - d.getTime();
  // Negative diff (timestamp in the future) — flip and prefix.
  const future = diffMs < 0;
  const ms = Math.abs(diffMs);
  const sec = Math.round(ms / 1000);
  const min = Math.round(sec / 60);
  const hr = Math.round(min / 60);
  const day = Math.round(hr / 24);
  const week = Math.round(day / 7);
  const month = Math.round(day / 30);
  const year = Math.round(day / 365);

  let core: string;
  if (sec < 45) core = "just now";
  else if (min < 2) core = "1m";
  else if (min < 60) core = `${min}m`;
  else if (hr < 2) core = "1h";
  else if (hr < 24) core = `${hr}h`;
  else if (day === 1) core = future ? "tomorrow" : "yesterday";
  else if (day < 14) core = `${day}d`;
  else if (week < 8) core = `${week}w`;
  else if (month < 12) core = `${month}mo`;
  else core = `${year}y`;

  if (core === "just now" || core === "yesterday" || core === "tomorrow") {
    return core;
  }
  return future ? `in ${core}` : `${core} ago`;
}

