import type { AuditEvent } from "@/lib/audit-types";
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
const userCache = new Map<string, { value: AdminUserRecord | null; at: number }>();
const userDataCountsCache = new Map<string, { value: Record<string, number>; at: number }>();
const activityCache = new Map<string, { value: AuditEntry[]; at: number }>();

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
export async function fetchUser(
  uid: string,
  opts?: { force?: boolean },
): Promise<AdminUserRecord | null> {
  const cached = userCache.get(uid);
  if (!opts?.force && cached && Date.now() - cached.at < CACHE_TTL_MS) {
    return cached.value;
  }
  const res = await authedFetch("/api/admin/user", { uid });
  if (res.status === 404) {
    userCache.set(uid, { value: null, at: Date.now() });
    return null;
  }
  if (!res.ok) return parseError(res);
  const body = (await res.json()) as { user: AdminUserRecord };
  userCache.set(uid, { value: body.user, at: Date.now() });
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
export type UsageDayBucket = { date: string; events: number; millicents: number };

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
  byDay: UsageDayBucket[];
  days: number;
  rangeFrom: string;
  rangeTo: string;
  /**
   * Distinct uids active in the last 15 minutes. Populated by the server only
   * when `days <= 1` (Overview's "Active now" widget) so the rest of the
   * pages don't pay for the extra scan.
   */
  activeRecent?: { uids: string[]; minutes: number };
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
// Single-conversation bundle (from /api/admin/conversation)
// --------------------------------------------------------------------------

export type AdminConversationBundle = {
  conversation: Record<string, unknown>;
  segments: Array<Record<string, unknown>>;
  suggestions: Array<Record<string, unknown>>;
  contributions: Array<Record<string, unknown>>;
  people: Array<Record<string, unknown>>;
};

const conversationCache = new Map<string, { value: AdminConversationBundle; at: number }>();

/**
 * Fetch every Firestore row tied to a single conversation under a user,
 * plus the user's people list (for personId → name resolution). Cached 30s
 * per `(uid, conversationId)` so back-navigation is instant.
 */
export async function fetchAdminConversation(
  uid: string,
  conversationId: string,
  opts?: { force?: boolean },
): Promise<AdminConversationBundle> {
  const key = `${uid}::${conversationId}`;
  const cached = conversationCache.get(key);
  if (!opts?.force && cached && Date.now() - cached.at < CACHE_TTL_MS) {
    return cached.value;
  }
  const res = await authedFetch("/api/admin/conversation", { uid, conversationId });
  if (!res.ok) return parseError(res);
  const body = (await res.json()) as AdminConversationBundle;
  conversationCache.set(key, { value: body, at: Date.now() });
  return body;
}

/**
 * Fetch per-table document counts for a user. Powers the chip badges on the
 * admin user-detail Synced data section.
 */
export async function fetchUserDataCounts(
  uid: string,
  opts?: { force?: boolean },
): Promise<Record<string, number>> {
  const cached = userDataCountsCache.get(uid);
  if (!opts?.force && cached && Date.now() - cached.at < CACHE_TTL_MS) {
    return cached.value;
  }
  const res = await authedFetch("/api/admin/user-data-counts", { uid });
  if (!res.ok) return parseError(res);
  const body = (await res.json()) as { counts: Record<string, number> };
  userDataCountsCache.set(uid, { value: body.counts, at: Date.now() });
  return body.counts;
}

// --------------------------------------------------------------------------
// Sync-error summary (from /api/admin/sync-errors-summary)
// --------------------------------------------------------------------------

/**
 * Map of uid → unrecovered sync-error count in the last 24 hours. Powers
 * the "Users with sync errors" stat on /admin and the "Sync issues"
 * filter + column on /admin/users. Cached 30s like the other admin
 * fetchers; pass `{ force: true }` to bypass (e.g. after a destructive
 * action that could clear errors).
 */
let syncErrorsSummaryCache: {
  value: Record<string, number>;
  at: number;
} | null = null;

export async function fetchSyncErrorsSummary(opts?: {
  force?: boolean;
}): Promise<Record<string, number>> {
  if (
    !opts?.force &&
    syncErrorsSummaryCache &&
    Date.now() - syncErrorsSummaryCache.at < CACHE_TTL_MS
  ) {
    return syncErrorsSummaryCache.value;
  }
  const res = await authedFetch("/api/admin/sync-errors-summary");
  if (!res.ok) return parseError(res);
  const body = (await res.json()) as { counts: Record<string, number> };
  syncErrorsSummaryCache = { value: body.counts, at: Date.now() };
  return body.counts;
}

// --------------------------------------------------------------------------
// Destructive account actions (from /api/admin/user-action)
// --------------------------------------------------------------------------

export type AdminUserAction = "revoke-admin" | "disable" | "enable" | "delete";

/**
 * Run a destructive account action. Returns `{ partial: true }` when a
 * `delete` succeeded against Firebase Auth but the Firestore/Storage wipe
 * didn't fully complete. Throws AdminApiError on failure.
 */
export async function performUserAction(
  uid: string,
  action: AdminUserAction,
): Promise<{ partial: boolean }> {
  const res = await authedFetch("/api/admin/user-action", { uid, action });
  if (!res.ok) return parseError(res);
  const body = (await res.json()) as { ok: true; partial?: boolean };
  // Invalidate the caches that could surface the now-stale user/aggregates,
  // plus the activity feed (it just gained a new row).
  userCache.delete(uid);
  usersCache = null;
  userDataCountsCache.delete(uid);
  activityCache.clear();
  return { partial: Boolean(body.partial) };
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
// Waitlist (from /api/admin/waitlist + /api/admin/waitlist-action)
// --------------------------------------------------------------------------

export type WaitlistEntry = {
  id: string;
  name: string;
  email: string;
  about: string;
  createdAt: string | null;
  status: string | null;
  onboardedAt: string | null;
};

export type WaitlistAction = "onboarded" | "archive" | "delete";

let waitlistCache: { value: WaitlistEntry[]; at: number } | null = null;

/** Fetch waitlist entries newest-first. Throws AdminApiError on failure. */
export async function fetchWaitlist(opts?: { force?: boolean }): Promise<WaitlistEntry[]> {
  if (!opts?.force && waitlistCache && Date.now() - waitlistCache.at < CACHE_TTL_MS) {
    return waitlistCache.value;
  }
  const res = await authedFetch("/api/admin/waitlist");
  if (!res.ok) return parseError(res);
  const body = (await res.json()) as { entries: WaitlistEntry[] };
  waitlistCache = { value: body.entries, at: Date.now() };
  return body.entries;
}

/** Update or delete a single waitlist entry. Invalidates the local cache. */
export async function markWaitlistEntry(id: string, action: WaitlistAction): Promise<void> {
  const res = await authedFetch("/api/admin/waitlist-action", { id, action });
  if (!res.ok) return parseError(res);
  waitlistCache = null;
  // The activity log just gained a new row — invalidate so the next page
  // load shows it immediately rather than after the 30s TTL.
  activityCache.clear();
}

// --------------------------------------------------------------------------
// Audit trail (from /api/admin/activity)
// --------------------------------------------------------------------------

/** Re-export the shared audit types so consumers can import from one place. */
export type { AdminAction, AuditEvent } from "@/lib/audit-types";

/** One row in the `admin_actions` Firestore collection. */
export type AuditEntry = AuditEvent & { id: string; createdAt: string };

/**
 * Fetch recent admin-audit events. Cached 30s per `targetUid` (or "all" when
 * not filtering). Pass `{ force: true }` to skip the cache (e.g. polling).
 */
export async function fetchActivity(opts?: {
  targetUid?: string;
  limit?: number;
  force?: boolean;
}): Promise<AuditEntry[]> {
  const key = opts?.targetUid ?? "all";
  const cached = activityCache.get(key);
  if (!opts?.force && cached && Date.now() - cached.at < CACHE_TTL_MS) {
    return cached.value;
  }
  const body: Record<string, unknown> = {};
  if (opts?.targetUid) body.targetUid = opts.targetUid;
  if (opts?.limit) body.limit = opts.limit;
  const res = await authedFetch("/api/admin/activity", body);
  if (!res.ok) return parseError(res);
  const data = (await res.json()) as { entries: AuditEntry[] };
  activityCache.set(key, { value: data.entries, at: Date.now() });
  return data.entries;
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

