import { db, getJamesProfile } from "./db";

// === Tier 1.1: backfill person_id on historical suggestions_log rows ===
const SUGGESTIONS_LOG_PERSON_ID_BACKFILL_FLAG = "suggestions_log_person_id_backfill_v1";

/**
 * First-run initialization for a fresh account.
 *
 * Multi-user: this app supports many different account owners, so we must NOT
 * seed any specific person's identity or relatives. Doing so would inject one
 * user's family (and even push them to a brand-new account's cloud backup on
 * first sign-in). We only ensure the owner-profile row exists — blank until
 * first-run onboarding captures the real owner's name. Their people, profile,
 * and history are entered by them (or restored from their own cloud backup).
 */
export async function ensureOwnerProfile() {
  if (typeof window === "undefined") return;
  try {
    // Lazily creates the blank singleton profile row if none exists yet.
    await getJamesProfile();
  } catch (e) {
    console.error("Owner profile init failed", e);
  }
}

/**
 * === Tier 1.1: feedback loop ===
 *
 * Historical `suggestions_log` rows were written before we added `person_id`
 * to the schema. Walk all conversations once and tag each row with the
 * conversation's primary person, so style-evidence aggregation can bucket
 * them per person. Idempotent and gated by a localStorage flag.
 */
export async function backfillSuggestionsLogPersonIds() {
  if (typeof window === "undefined") return;
  if (localStorage.getItem(SUGGESTIONS_LOG_PERSON_ID_BACKFILL_FLAG)) return;
  try {
    const conversations = await db.conversations.toArray();
    for (const c of conversations) {
      const primary = c.person_ids?.[0];
      if (!primary) continue;
      const rows = await db.suggestions_log
        .where("conversation_id")
        .equals(c.id)
        .filter((r) => !r.person_id)
        .toArray();
      if (rows.length === 0) continue;
      await db.suggestions_log.bulkPut(rows.map((r) => ({ ...r, person_id: primary })));
    }
    localStorage.setItem(SUGGESTIONS_LOG_PERSON_ID_BACKFILL_FLAG, "1");
  } catch (e) {
    console.warn("suggestions_log person_id backfill failed", e);
  }
}