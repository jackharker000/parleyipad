import { db } from "./db";
import { supabase } from "@/integrations/supabase/client";

/**
 * Cloud backup strategy: snapshot-based.
 *
 * On sign-in we pull the user's `user_backups.data` JSON blob and hydrate every
 * Dexie table from it. After that, any local Dexie write triggers a debounced
 * push of a fresh full snapshot back to the cloud. Dexie remains the in-session
 * source of truth so the UI stays fast and works offline.
 *
 * Tier 3.1 note: `memories` and `transcript_segments` rows now carry an
 * optional `embedding` array (1536 floats ≈ 6 KB per row). At ~500 memories
 * this adds ~3 MB to the snapshot. Acceptable for now; if a future user
 * hits the JSONB size limit, strip embeddings from the snapshot here and
 * re-derive them on the next mount via `backfillMemoryEmbeddings()`.
 */

const TABLES = [
  "people",
  "places",
  "conversations",
  "transcript_segments",
  "suggestions_log",
  "manual_replies",
  "memories",
  "follow_ups",
  "settings",
  "style_profile",
  "james_profile",
  "james_documents",
  "events",
  "event_documents",
  "voiceprints",
  "person_documents",
  "voiceprint_contributions",
  // === Tier 1: feedback loop ===
  "style_evidence_cache",
  "style_distill_runs",
  // === Tier 2: post-conversation analysis ===
  "profile_proposals",
  "segment_mfccs",
] as const;

type TableName = (typeof TABLES)[number];
type Snapshot = Partial<Record<TableName, unknown[]>> & { _v?: number };

let currentUserId: string | null = null;
let pushTimer: ReturnType<typeof setTimeout> | null = null;
let hooksWired = false;
let suppressPush = false;

async function takeSnapshot(): Promise<Snapshot> {
  const snap: Snapshot = { _v: 1 };
  for (const t of TABLES) {
    snap[t] = await (db as any)[t].toArray();
  }
  return snap;
}

async function applySnapshot(snap: Snapshot) {
  suppressPush = true;
  try {
    for (const t of TABLES) {
      const rows = snap[t];
      if (!Array.isArray(rows)) continue;
      await (db as any)[t].clear();
      if (rows.length) await (db as any)[t].bulkPut(rows);
    }
  } finally {
    suppressPush = false;
  }
}

async function pushNow() {
  if (!currentUserId) return;
  try {
    const snap = await takeSnapshot();
    const { error } = await supabase
      .from("user_backups")
      .upsert(
        { user_id: currentUserId, data: snap as any, updated_at: new Date().toISOString() },
        { onConflict: "user_id" },
      );
    if (error) console.error("[cloud-sync] push failed", error);
  } catch (e) {
    console.error("[cloud-sync] push exception", e);
  }
}

function schedulePush() {
  if (suppressPush || !currentUserId) return;
  if (pushTimer) clearTimeout(pushTimer);
  pushTimer = setTimeout(pushNow, 1500);
}

function wireDexieHooks() {
  if (hooksWired) return;
  hooksWired = true;
  for (const t of TABLES) {
    const tbl = (db as any)[t];
    tbl.hook("creating", () => {
      schedulePush();
    });
    tbl.hook("updating", () => {
      schedulePush();
    });
    tbl.hook("deleting", () => {
      schedulePush();
    });
  }
}

/** Pull cloud data for this user into Dexie, replacing local content. */
export async function pullForUser(userId: string) {
  currentUserId = userId;
  const { data, error } = await supabase
    .from("user_backups")
    .select("data")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) {
    console.error("[cloud-sync] pull failed", error);
    return;
  }
  if (data?.data && typeof data.data === "object") {
    await applySnapshot(data.data as Snapshot);
  } else {
    // First sign-in: push whatever's already in local Dexie as the initial backup.
    await pushNow();
  }
  wireDexieHooks();
}

/** Wipe local Dexie tables (e.g. on sign-out so the next user starts clean). */
export async function clearLocal() {
  currentUserId = null;
  if (pushTimer) {
    clearTimeout(pushTimer);
    pushTimer = null;
  }
  suppressPush = true;
  try {
    for (const t of TABLES) {
      await (db as any)[t].clear();
    }
  } finally {
    suppressPush = false;
  }
}

/** Force an immediate push (useful before sign-out). */
export async function flushPush() {
  if (pushTimer) {
    clearTimeout(pushTimer);
    pushTimer = null;
  }
  await pushNow();
}
