import { nanoid } from "nanoid";
import { doc, setDoc } from "firebase/firestore";
import { getStorage, ref, uploadBytes } from "firebase/storage";

import { db, type SyncError, type SyncOutboxRow } from "@/lib/db";
import { getFirebaseApp, getFirebaseDb, isFirebaseConfigured } from "@/lib/firebase/client";
import { getSettingsSnapshot } from "@/lib/settings";

/**
 * Write-behind cloud-sync engine.
 *
 * The cockpit hot path stays Dexie-only — every write is local-first and
 * never blocks on a network call. This engine intercepts those writes via
 * Dexie's `creating` / `updating` hooks, drops a lightweight outbox row,
 * and a background flush loop drains the outbox to Firestore (+ Firebase
 * Storage for blob fields).
 *
 * Rules of the road:
 *   • New-only. The id="cursor" row in `syncOutbox` records the engine
 *     start time; any source row whose `updatedAt` predates the cutoff is
 *     never synced. No backfill.
 *   • Most-recent-write-wins. The dedup key is `(table, rowId)` — a fresh
 *     write replaces any prior queued outbox row for the same target, so
 *     the flusher always sends the live state, not stale snapshots.
 *   • Idempotent. Send is `setDoc` (full upsert); audio uploads run once
 *     per outbox row, tracked via `audioUploaded` so retries don't
 *     re-upload the same blob.
 *   • Auth-scoped. Every doc and blob lives under `users/<uid>/...` and
 *     uses the signed-in user's ID token (handled by the Firebase client
 *     SDK). Firestore rules enforce the boundary.
 *
 * Browser-only. Don't import this from any module that runs during SSR.
 */

// --------------------------------------------------------------------------
// Configuration
// --------------------------------------------------------------------------

const SYNCED_TABLES = [
  "conversations",
  "transcriptSegments",
  "voiceprints",
  "voiceprintContributions", // metadata row; audio uploaded separately
  "people",
  "places",
  "events",
  "jamesProfile",
  "styleProfile",
  "memories",
  "followUps",
  "suggestionsLog",
  "helperDrafts",
  "manualReplies",
  // The sync-error log itself syncs to Firestore so the admin overview
  // can aggregate unrecovered errors across users via a collectionGroup
  // query. Text-only — no entry in AUDIO_TABLES.
  "syncErrors",
] as const;

type SyncedTable = (typeof SYNCED_TABLES)[number];

/**
 * Which Dexie tables carry a blob field that should be uploaded to
 * Firebase Storage instead of being JSON-encoded into the Firestore doc.
 * The value is the field name on the Dexie row.
 *
 * NB: a table can appear here without being in SYNCED_TABLES — in that
 * case the audio entry is dormant until the table is added to the
 * synced list. Kept aligned with the spec for forward-compat.
 */
const AUDIO_TABLES: Record<string, string> = {
  voiceprintContributions: "audio",
  cachedPhraseAudio: "audio",
};

const FLUSH_INTERVAL_MS = 2_000;
const FLUSH_BATCH_SIZE = 50;
const FLUSH_BACKOFF_MAX_MS = 60_000;

const CURSOR_ID = "cursor";

/**
 * Once an outbox row has failed this many times in a row, we drop a
 * SyncError row so the user and the admin can see it's stuck. We don't
 * stop retrying — exponential backoff continues — we just surface the
 * fact that this particular row is in trouble.
 */
const MAX_RETRIES_BEFORE_LOG = 3;

/** Cap on locally-retained SyncError rows per device. Older rows are pruned. */
const MAX_SYNC_ERRORS_LOCAL = 50;

/** Trim the message we persist so it never carries a giant payload / secret. */
const SYNC_ERROR_MESSAGE_MAX = 500;

// --------------------------------------------------------------------------
// Engine state
// --------------------------------------------------------------------------

type EngineHandle = {
  uid: string;
  unsubscribeHooks: Array<() => void>;
  stopped: boolean;
  timer: ReturnType<typeof setTimeout> | null;
  consecutiveFailures: number;
  flushing: Promise<void> | null;
};

/**
 * Status read by the Settings UI via `subscribeStatus`. Kept module-level
 * so we don't lose history when the engine restarts (toggle off + on).
 */
type SyncStatus = {
  running: boolean;
  lastFlushAt: number | null;
  lastError: string | null;
};

const status: SyncStatus = {
  running: false,
  lastFlushAt: null,
  lastError: null,
};

const statusListeners = new Set<(s: SyncStatus) => void>();

function emitStatus(): void {
  for (const fn of statusListeners) fn({ ...status });
}

export function subscribeSyncStatus(fn: (s: SyncStatus) => void): () => void {
  statusListeners.add(fn);
  fn({ ...status });
  return () => {
    statusListeners.delete(fn);
  };
}

export function getSyncStatus(): SyncStatus {
  return { ...status };
}

let active: EngineHandle | null = null;
let refCount = 0;

// --------------------------------------------------------------------------
// Public API
// --------------------------------------------------------------------------

/**
 * Start the write-behind sync engine for the given user. Returns a dispose
 * function that releases this caller's reference; the engine only stops
 * once every caller has disposed (or `stopCloudSync()` is called
 * explicitly, e.g. by the Settings toggle going off).
 *
 * Refcounting is what lets the same engine power both the app-layout
 * mount in `routes/app.tsx` AND the Settings panel's `useCloudSync` hook
 * — when the user navigates between routes the Settings hook unmounts
 * and remounts, but the app-layout hook keeps the engine alive.
 *
 * Returns a no-op dispose when:
 *   • we're on the server (typeof window === "undefined")
 *   • Firebase isn't configured on this build (`VITE_FIREBASE_*` missing)
 *   • the user has cloudSyncEnabled === false
 */
export function startCloudSync(uid: string): () => void {
  if (typeof window === "undefined") return () => {};
  if (!isFirebaseConfigured()) return () => {};
  if (!uid) return () => {};

  // Account switch — drop the old engine first, then start fresh below.
  if (active && active.uid !== uid) {
    forceStop();
  }

  // Already running for this uid — bump refcount and share.
  if (active && active.uid === uid && !active.stopped) {
    refCount += 1;
    return () => releaseRef();
  }

  // First caller — boot the engine. Settings is async so we kick off
  // speculatively; if the user has sync disabled we tear back down
  // before any write hits the network.
  const handle: EngineHandle = {
    uid,
    unsubscribeHooks: [],
    stopped: false,
    timer: null,
    consecutiveFailures: 0,
    flushing: null,
  };
  active = handle;
  refCount = 1;

  void (async () => {
    try {
      const settings = await getSettingsSnapshot();
      // Default ON: undefined === true so new accounts get sync without
      // a one-time settings migration.
      const enabled = settings.cloudSyncEnabled !== false;
      if (!enabled || handle.stopped) {
        if (active === handle) forceStop();
        return;
      }
      await ensureCursor();
      installHooks(handle);
      status.running = true;
      status.lastError = null;
      emitStatus();
      scheduleFlush(handle, FLUSH_INTERVAL_MS);
    } catch (err) {
      status.lastError = errorMessage(err);
      emitStatus();
      if (active === handle) forceStop();
    }
  })();

  return () => releaseRef();
}

/**
 * Drop one caller's reference. When the count hits zero, the engine
 * tears down (Dexie hooks off, timer cleared). Most callers never reach
 * this — the explicit `stopCloudSync()` does the same thing, but
 * unconditionally (used by the Settings toggle).
 */
function releaseRef(): void {
  if (refCount > 0) refCount -= 1;
  if (refCount === 0) forceStop();
}

/**
 * Tear down the active engine immediately, regardless of refcount.
 * Called by the Settings toggle (off) and on account switch. Idempotent.
 */
export function stopCloudSync(): void {
  refCount = 0;
  forceStop();
}

function forceStop(): void {
  if (!active) return;
  const handle = active;
  active = null;
  handle.stopped = true;
  for (const off of handle.unsubscribeHooks) {
    try {
      off();
    } catch {
      // Dexie hooks throw on duplicate unsubscribe — swallow.
    }
  }
  handle.unsubscribeHooks = [];
  if (handle.timer) clearTimeout(handle.timer);
  handle.timer = null;
  status.running = false;
  emitStatus();
}

// --------------------------------------------------------------------------
// Cursor (new-only cutoff)
// --------------------------------------------------------------------------

/**
 * Read or create the engine-start cursor. Any source row whose
 * `updatedAt`/`createdAt` is earlier than this cutoff is skipped by the
 * flusher — i.e. no backfill of pre-existing data.
 */
async function ensureCursor(): Promise<number> {
  const existing = (await db().syncOutbox.get(CURSOR_ID)) as SyncOutboxRow | undefined;
  if (existing?.startedAt) return existing.startedAt;
  const now = Date.now();
  const cursor: SyncOutboxRow = {
    id: CURSOR_ID,
    table: "__cursor__",
    rowId: CURSOR_ID,
    op: "upsert",
    queuedAt: now,
    retries: 0,
    audioUploaded: true,
    startedAt: now,
  };
  await db().syncOutbox.put(cursor);
  return now;
}

async function getCursor(): Promise<number> {
  const row = (await db().syncOutbox.get(CURSOR_ID)) as SyncOutboxRow | undefined;
  return row?.startedAt ?? Date.now();
}

// --------------------------------------------------------------------------
// Dexie hooks
// --------------------------------------------------------------------------

/**
 * Install Dexie `creating` + `updating` hooks on every synced table. The
 * hooks are fire-and-forget — they call `void enqueue(...)` so a Dexie
 * write never awaits a sync operation. If the outbox upsert fails we
 * lose at most one queue entry; the next write on the same row re-queues.
 */
function installHooks(handle: EngineHandle): void {
  const d = db();
  for (const name of SYNCED_TABLES) {
    // syncErrors is deliberately excluded from the hook-driven outbox
    // path: a failed sync that records into syncErrors would re-fire
    // this hook and enqueue itself, which after MAX_RETRIES_BEFORE_LOG
    // failures recurses into recordSyncError again — chronic write loop
    // capped only by the 50-row prune. recordSyncError instead pushes
    // its row to Firestore directly (best-effort, never throws).
    if (name === "syncErrors") continue;
    // Dexie's runtime table lookup. The static class fields are typed
    // separately, but a string-indexed access is the only generic way
    // to attach hooks across the full list. `d.table(name)` throws if
    // the table isn't in the schema — every entry in SYNCED_TABLES is,
    // so the throw is treated as a programming error.
    const tbl = d.table(name);

    // Dexie hook signatures:
    //   creating(primKey, obj, transaction)
    //   updating(modifications, primKey, obj, transaction)
    const onCreate = function (this: unknown, primKey: unknown) {
      if (handle.stopped) return;
      void enqueue(name, String(primKey));
    };
    const onUpdate = function (this: unknown, _modifications: unknown, primKey: unknown) {
      if (handle.stopped) return;
      void enqueue(name, String(primKey));
    };

    // Dexie's TableHooks overloads need an any-cast to reach the
    // (eventName, subscriber) call signature — the struct-style
    // accessors on the same interface confuse TS picking the right one.
    const hookHandle = tbl.hook as unknown as {
      (event: "creating", fn: typeof onCreate): void;
      (event: "updating", fn: typeof onUpdate): void;
      (event: "creating"): { unsubscribe: (fn: typeof onCreate) => void };
      (event: "updating"): { unsubscribe: (fn: typeof onUpdate) => void };
    };

    hookHandle("creating", onCreate);
    hookHandle("updating", onUpdate);

    handle.unsubscribeHooks.push(() => hookHandle("creating").unsubscribe(onCreate));
    handle.unsubscribeHooks.push(() => hookHandle("updating").unsubscribe(onUpdate));
  }
}

/**
 * Append (or replace) an outbox row for a given (table, rowId). Dedup
 * keeps the queue bounded under heavy write activity — most-recent-write
 * wins so the flusher always sends the live row, not a stale copy.
 */
async function enqueue(table: SyncedTable, rowId: string): Promise<void> {
  try {
    // No compound (table, rowId) index — fetch the at-most-a-handful of
    // candidates for this table and filter in memory. Under steady state
    // there's at most one prior entry per row, so this stays cheap.
    const candidates = await db().syncOutbox.where("table").equals(table).toArray();
    const prior = candidates.find((r) => r.rowId === rowId && r.id !== CURSOR_ID);

    if (prior) {
      // Replace in place — keep the same id so the dedup key stays
      // stable, but reset retries since this is effectively a new
      // attempt with the freshest row state.
      await db().syncOutbox.put({
        ...prior,
        queuedAt: Date.now(),
        retries: 0,
        audioUploaded: prior.audioUploaded, // keep blob-upload progress
      });
      return;
    }

    const row: SyncOutboxRow = {
      id: nanoid(),
      table,
      rowId,
      op: "upsert",
      queuedAt: Date.now(),
      retries: 0,
      audioUploaded: false,
    };
    await db().syncOutbox.put(row);
  } catch (err) {
    // Outbox writes shouldn't crash the cockpit. Surface to status so
    // the Settings panel can show "last error"; the next write on the
    // same row will retry the enqueue.
    status.lastError = errorMessage(err);
    emitStatus();
  }
}

// --------------------------------------------------------------------------
// Flush loop
// --------------------------------------------------------------------------

function scheduleFlush(handle: EngineHandle, delayMs: number): void {
  if (handle.stopped) return;
  if (handle.timer) clearTimeout(handle.timer);
  handle.timer = setTimeout(() => {
    handle.timer = null;
    void runFlush(handle);
  }, delayMs);
}

async function runFlush(handle: EngineHandle): Promise<void> {
  if (handle.stopped) return;
  if (handle.flushing) {
    // Already flushing — let the in-flight pass finish; it'll
    // re-schedule itself.
    return;
  }
  handle.flushing = (async () => {
    try {
      const batch = await loadBatch();
      if (batch.length === 0) {
        // Nothing to do — quiet poll.
        handle.consecutiveFailures = 0;
        scheduleFlush(handle, FLUSH_INTERVAL_MS);
        return;
      }
      const cursor = await getCursor();
      const ok = await flushBatch(handle, batch, cursor);
      if (ok) {
        handle.consecutiveFailures = 0;
        status.lastFlushAt = Date.now();
        status.lastError = null;
        emitStatus();
        // More may have arrived during the flush — keep draining
        // aggressively while the outbox is non-empty.
        scheduleFlush(handle, FLUSH_INTERVAL_MS);
      } else {
        handle.consecutiveFailures += 1;
        const backoff = Math.min(
          FLUSH_BACKOFF_MAX_MS,
          FLUSH_INTERVAL_MS * 2 ** handle.consecutiveFailures,
        );
        scheduleFlush(handle, backoff);
      }
    } finally {
      handle.flushing = null;
    }
  })();
  await handle.flushing;
}

async function loadBatch(): Promise<SyncOutboxRow[]> {
  const rows = await db()
    .syncOutbox.orderBy("queuedAt")
    .limit(FLUSH_BATCH_SIZE + 1) // +1 in case the cursor row sorts in
    .toArray();
  return rows.filter((r) => r.id !== CURSOR_ID).slice(0, FLUSH_BATCH_SIZE);
}

/**
 * Process one batch. Returns true if every row succeeded; false if any
 * failed (the loop will back off and retry the failed rows on the next
 * pass — they stay in the outbox).
 */
async function flushBatch(
  handle: EngineHandle,
  batch: SyncOutboxRow[],
  cursor: number,
): Promise<boolean> {
  let allOk = true;
  for (const entry of batch) {
    if (handle.stopped) return allOk;
    try {
      const sent = await processOne(handle.uid, entry, cursor);
      if (sent === "synced" || sent === "skipped") {
        // Race-safe delete: only remove the outbox row if it hasn't been
        // re-queued (queuedAt moved forward) while we were sending. If a
        // newer write came in, leave the entry so the next flush pass
        // picks up the fresh row state.
        const live = await db().syncOutbox.get(entry.id);
        if (live && live.queuedAt === entry.queuedAt) {
          await db().syncOutbox.delete(entry.id);
          // The row finally went through — mark any matching SyncError
          // as recovered so the admin can tell "broke once, healed" from
          // "currently broken". Wrapped so the recovery write never
          // crashes the outer flush loop.
          try {
            await markSyncErrorRecovered(entry.table, entry.rowId);
          } catch (recErr) {
            console.warn(
              "[sync] failed to mark sync error recovered",
              recErr instanceof Error ? recErr.message : recErr,
            );
          }
        }
      } else if (sent === "audio-pending") {
        // Blob upload succeeded but Firestore write failed — keep the
        // outbox row so we resend the doc; audioUploaded was already
        // persisted by processOne, so we won't re-upload the blob.
        allOk = false;
      }
    } catch (err) {
      allOk = false;
      const message = errorMessage(err);
      status.lastError = message;
      emitStatus();
      const nextRetries = (entry.retries ?? 0) + 1;
      await db().syncOutbox.update(entry.id, { retries: nextRetries });
      // Surface a SyncError once we've crossed the threshold. The first
      // crossing creates the row; subsequent failures bump retries +
      // refresh the message in place, so the admin sees the latest
      // failure attached to the same logical entry. Defensive try/catch
      // — a logging hiccup must never break the flush loop.
      if (nextRetries >= MAX_RETRIES_BEFORE_LOG) {
        try {
          await recordSyncError({ ...entry, retries: nextRetries }, message);
        } catch (logErr) {
          console.warn(
            "[sync] failed to record sync error",
            logErr instanceof Error ? logErr.message : logErr,
          );
        }
      }
    }
  }
  return allOk;
}

type ProcessResult = "synced" | "skipped" | "audio-pending";

/**
 * Read the live Dexie row, transform it (uploading any blob field and
 * replacing it with a Storage reference), then write the JSON-serialised
 * document to Firestore at `users/<uid>/<table>/<rowId>`.
 */
async function processOne(
  uid: string,
  entry: SyncOutboxRow,
  cursor: number,
): Promise<ProcessResult> {
  let tbl;
  try {
    tbl = db().table(entry.table);
  } catch {
    // Table no longer in the schema — drop the outbox row.
    return "skipped";
  }

  const row = (await tbl.get(entry.rowId)) as Record<string, unknown> | undefined;
  if (!row) return "skipped";

  // New-only: skip anything whose timestamp predates the cutoff. We
  // accept either `updatedAt` or `createdAt` so tables that only have
  // a createdAt (e.g. suggestionsLog) still gate correctly.
  const rowTime = pickTime(row);
  if (rowTime != null && rowTime < cursor) return "skipped";

  const audioField = AUDIO_TABLES[entry.table];
  let payload: Record<string, unknown> = { ...row };

  if (audioField) {
    const blob = row[audioField];
    if (blob && !entry.audioUploaded && isUploadableBlob(blob)) {
      const buf = await toArrayBuffer(blob);
      const bytes = new Uint8Array(buf);
      const path = `users/${uid}/${entry.table}/${entry.rowId}.bin`;
      const storage = getStorage(getFirebaseApp());
      await uploadBytes(ref(storage, path), bytes);
      // Persist the audio-uploaded flag immediately so a Firestore
      // failure below doesn't cause a re-upload on the next retry.
      await db().syncOutbox.update(entry.id, { audioUploaded: true });
      entry.audioUploaded = true;
      payload[audioField] = {
        storagePath: path,
        sizeBytes: bytes.byteLength,
      };
    } else if (entry.audioUploaded && blob && isUploadableBlob(blob)) {
      // Already uploaded on a prior attempt — reconstruct the
      // Firestore-side reference without re-uploading.
      const buf = await toArrayBuffer(blob);
      const path = `users/${uid}/${entry.table}/${entry.rowId}.bin`;
      payload[audioField] = {
        storagePath: path,
        sizeBytes: buf.byteLength,
      };
    } else if (blob && !isUploadableBlob(blob)) {
      // Field present but not a blob (e.g. already replaced by a
      // reference object). Pass through as-is.
    }
  }

  payload = sanitiseForFirestore(payload);

  const fs = getFirebaseDb();
  await setDoc(doc(fs, "users", uid, entry.table, entry.rowId), payload);
  return "synced";
}

// --------------------------------------------------------------------------
// Sync-error log
// --------------------------------------------------------------------------

/**
 * Idempotent log of "this outbox row has been stuck for a while". Only one
 * unrecovered SyncError exists per (table, rowId) at a time — subsequent
 * calls just bump the retries field on the existing row so the admin sees
 * the count rise rather than dozens of duplicate entries.
 *
 * After write, prune the on-device log to MAX_SYNC_ERRORS_LOCAL via a
 * single range query so we don't fill IndexedDB on a chronically broken
 * device. Pruning is best-effort — if it fails the next write will retry.
 *
 * Never throws — the caller has wrapped this in try/catch defensively but
 * we also swallow inside so a bad row can't bubble out into the flush loop.
 */
async function recordSyncError(
  entry: SyncOutboxRow,
  rawMessage: string | null,
): Promise<void> {
  const now = Date.now();
  const message = trimMessage(rawMessage);
  const kind = classifyErrorKind(entry, rawMessage);

  // Find an existing unrecovered row for this target. Booleans aren't
  // sortable IDB keys, so we scan rows with this (table, rowId) and
  // filter by `recovered === false` in memory. The active set is small
  // (capped at MAX_SYNC_ERRORS_LOCAL on the device) so this stays cheap.
  const candidates = await db()
    .syncErrors.where("table")
    .equals(entry.table)
    .toArray();
  const prior = candidates.find(
    (e) => e.rowId === entry.rowId && e.recovered === false,
  );

  let written: SyncError;
  if (prior) {
    written = {
      ...prior,
      retries: entry.retries ?? prior.retries,
      message,
      kind,
      updatedAt: now,
    };
    await db().syncErrors.update(prior.id, {
      retries: written.retries,
      message: written.message,
      kind: written.kind,
      updatedAt: written.updatedAt,
    });
  } else {
    written = {
      id: nanoid(),
      table: entry.table,
      rowId: entry.rowId,
      op: "upsert",
      message,
      retries: entry.retries ?? 0,
      kind,
      recovered: false,
      createdAt: now,
      updatedAt: now,
    };
    await db().syncErrors.put(written);
  }

  await pruneSyncErrorsIfNeeded();
  // Direct upload (no outbox enqueue, no Dexie hook): bypasses the loop
  // where a failed flush of a syncErrors row would itself record another
  // syncError. Best-effort; the cockpit never blocks on it.
  void pushSyncErrorDirect(written);
}

/**
 * When an outbox row finally succeeds, flip its matching unrecovered
 * SyncError to `recovered: true`. The admin view uses this to distinguish
 * "broke once, healed itself" from "currently broken right now".
 */
async function markSyncErrorRecovered(table: string, rowId: string): Promise<void> {
  const candidates = await db().syncErrors.where("table").equals(table).toArray();
  const matches = candidates.filter(
    (e) => e.rowId === rowId && e.recovered === false,
  );
  if (matches.length === 0) return;
  const now = Date.now();
  // Individual updates keep it portable across Dexie minor versions where
  // bulkUpdate availability isn't guaranteed. The match set is tiny in
  // practice (almost always 1), so this isn't a hot path.
  await Promise.all(
    matches.map(async (m) => {
      await db().syncErrors.update(m.id, { recovered: true, updatedAt: now });
      void pushSyncErrorDirect({ ...m, recovered: true, updatedAt: now });
    }),
  );
}

/**
 * Push a SyncError row to Firestore via a direct setDoc, bypassing the
 * outbox + Dexie hook path so a failed sync of a syncErrors row can't
 * cascade into recording another syncError. Best-effort: silent no-op
 * when no engine is running or Firebase isn't configured. Failures are
 * swallowed (the row is still in local Dexie; the admin gets it next
 * time something works).
 */
async function pushSyncErrorDirect(row: SyncError): Promise<void> {
  try {
    if (!active || active.stopped) return;
    if (!isFirebaseConfigured()) return;
    const uid = active.uid;
    const fs = getFirebaseDb();
    await setDoc(doc(fs, "users", uid, "syncErrors", row.id), {
      table: row.table,
      rowId: row.rowId,
      op: row.op,
      message: row.message,
      retries: row.retries,
      kind: row.kind,
      recovered: row.recovered,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    });
  } catch {
    // Direct push failed; nothing to do — the local row stands and the
    // next successful flush cycle will see it via list queries from the
    // admin anyway.
  }
}

/**
 * Keep at most MAX_SYNC_ERRORS_LOCAL rows on the device. We delete by an
 * orderBy/offset query so the whole prune is a single Dexie call — no
 * per-row trips. If we're under the cap, this short-circuits cheaply.
 */
async function pruneSyncErrorsIfNeeded(): Promise<void> {
  const total = await db().syncErrors.count();
  if (total <= MAX_SYNC_ERRORS_LOCAL) return;
  const excess = total - MAX_SYNC_ERRORS_LOCAL;
  // Oldest createdAt first → delete the first `excess` of them. Dexie
  // supports a single delete() on a filtered query, which is one IDB
  // round trip regardless of row count.
  await db()
    .syncErrors.orderBy("createdAt")
    .limit(excess)
    .delete();
}

/**
 * Guess whether a stuck row is failing because of the audio upload or
 * the Firestore write. Used to colour the kind badge in the admin view;
 * the heuristic doesn't have to be precise — just useful at a glance.
 */
function classifyErrorKind(
  entry: SyncOutboxRow,
  message: string | null,
): "text" | "blob" | "unknown" {
  // Audio-bearing tables that haven't finished their blob upload are
  // almost certainly stuck on Storage rather than Firestore.
  if (entry.table === "voiceprintContributions" && !entry.audioUploaded) {
    return "blob";
  }
  if (entry.table === "cachedPhraseAudio" && !entry.audioUploaded) {
    return "blob";
  }
  // Cheap message sniff for the obvious Storage failure modes.
  if (message) {
    const m = message.toLowerCase();
    if (m.includes("storage") || m.includes("uploadbytes") || m.includes("blob")) {
      return "blob";
    }
    if (m.includes("firestore") || m.includes("setdoc") || m.includes("permission")) {
      return "text";
    }
  }
  return "unknown";
}

function trimMessage(raw: string | null): string {
  if (!raw) return "(no message)";
  const s = String(raw);
  if (s.length <= SYNC_ERROR_MESSAGE_MAX) return s;
  return s.slice(0, SYNC_ERROR_MESSAGE_MAX - 1) + "…";
}

// --------------------------------------------------------------------------
// Row helpers
// --------------------------------------------------------------------------

function pickTime(row: Record<string, unknown>): number | null {
  const u = row.updatedAt;
  if (typeof u === "number" && Number.isFinite(u)) return u;
  const c = row.createdAt;
  if (typeof c === "number" && Number.isFinite(c)) return c;
  // Conversations carry startedAt instead of createdAt.
  const s = row.startedAt;
  if (typeof s === "number" && Number.isFinite(s)) return s;
  // Manual replies carry spokenAt.
  const sp = row.spokenAt;
  if (typeof sp === "number" && Number.isFinite(sp)) return sp;
  // Cached audio carries cachedAt.
  const ca = row.cachedAt;
  if (typeof ca === "number" && Number.isFinite(ca)) return ca;
  return null;
}

function isUploadableBlob(v: unknown): boolean {
  if (typeof Blob !== "undefined" && v instanceof Blob) return true;
  if (v instanceof ArrayBuffer) return true;
  if (ArrayBuffer.isView(v)) return true;
  return false;
}

async function toArrayBuffer(v: unknown): Promise<ArrayBuffer> {
  if (typeof Blob !== "undefined" && v instanceof Blob) return await v.arrayBuffer();
  if (v instanceof ArrayBuffer) return v;
  if (ArrayBuffer.isView(v)) {
    // Slice into a fresh ArrayBuffer so we (a) don't accidentally
    // upload data outside the typed-array's logical view, and (b)
    // promote a SharedArrayBuffer-backed view to a plain ArrayBuffer
    // that uploadBytes will accept.
    const view = v as ArrayBufferView;
    const out = new ArrayBuffer(view.byteLength);
    new Uint8Array(out).set(
      new Uint8Array(view.buffer as ArrayBufferLike, view.byteOffset, view.byteLength),
    );
    return out;
  }
  throw new Error("Not a blob-like value");
}

/**
 * Strip / replace anything Firestore can't natively serialise. Plain
 * objects and arrays recurse; Blob/ArrayBuffer/typed-array values get
 * dropped (they should already have been replaced by Storage refs
 * upstream, but a stray one would otherwise break setDoc).
 */
function sanitiseForFirestore(value: unknown): Record<string, unknown> {
  return sanitise(value) as Record<string, unknown>;
}

function sanitise(value: unknown): unknown {
  if (value === null) return null;
  if (value === undefined) return null;
  const t = typeof value;
  if (t === "string" || t === "number" || t === "boolean") return value;
  if (typeof Blob !== "undefined" && value instanceof Blob) {
    // Shouldn't happen — caller should have replaced blob fields with
    // Storage refs. Drop rather than crash the whole batch.
    return null;
  }
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) return null;
  if (Array.isArray(value)) return value.map(sanitise);
  if (t === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (v === undefined) continue; // Firestore rejects undefined
      out[k] = sanitise(v);
    }
    return out;
  }
  return null;
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
