import { db, newId, getJamesProfile, updateJamesProfile, type Person } from "./db";

const SEED_FLAG = "aac_seeded_v1";
// === Tier 1.1: backfill person_id on historical suggestions_log rows ===
const SUGGESTIONS_LOG_PERSON_ID_BACKFILL_FLAG = "suggestions_log_person_id_backfill_v1";

const SEED_PEOPLE: Omit<Person, "id" | "created_at">[] = [
  {
    name: "Glenis",
    relationship: "Mother",
    notes: "James's mother, in her 70s. Lives with James in Glen Massey.",
  },
  {
    name: "Matt",
    relationship: "Brother",
    interests: ["Sailing"],
    notes: "James's only brother, born 1976. Lives in Remuera, Auckland. Married to Antonia. Loves sailing.",
  },
  {
    name: "Antonia",
    relationship: "Sister-in-law",
    notes: "Married to James's brother Matt. Lives in Remuera, Auckland.",
  },
  {
    name: "Jack",
    relationship: "Nephew",
    interests: ["Sailing", "Wing foiling"],
    notes: "Matt and Antonia's son, born 9 Feb 2011. Studies Cambridge curriculum at ACG College in Parnell. Very smart, doing very well at school. Loves sailing and wing foiling.",
  },
  {
    name: "Kevin",
    relationship: "Uncle",
    notes: "James's uncle. Lives in Auckland with his partner Sharron.",
  },
  {
    name: "Sharron",
    relationship: "Uncle Kevin's partner",
    notes: "Kevin's partner. Lives in Auckland with Kevin.",
  },
  {
    name: "Ross",
    relationship: "Uncle",
    notes: "James's uncle.",
  },
];

export async function seedJamesIfNeeded() {
  if (typeof window === "undefined") return;
  if (localStorage.getItem(SEED_FLAG)) return;

  try {
    const profile = await getJamesProfile();
    if (!profile.updated_at) {
      await updateJamesProfile({
        display_name: "James",
        age: "44",
        background:
          "Lives in Glen Massey with his mother Glenis (in her 70s). Has cerebral palsy and has been non-verbal his whole life. Has one brother, Matt (born 1976), who lives in Remuera, Auckland with his wife Antonia and their son Jack (born 9 Feb 2011). Also has two uncles, Kevin (lives in Auckland with his partner Sharron) and Ross.",
        communication_style:
          "Non-verbal his whole life due to cerebral palsy. Uses this app to communicate. Struggles to type accurately, so most of his typed input is truncated and contains errors — interpret his typing generously and infer intent from context.",
        current_life_context:
          "Living at home in Glen Massey with mum Glenis. Close to brother Matt's family in Auckland — nephew Jack is doing very well at ACG Parnell.",
      });
    }

    const existing = await db.people.toArray();
    const existingNames = new Set(existing.map((p) => p.name.toLowerCase()));
    const now = Date.now();
    const toAdd = SEED_PEOPLE.filter((p) => !existingNames.has(p.name.toLowerCase())).map(
      (p) => ({ ...p, id: newId(), created_at: now }),
    );
    if (toAdd.length) await db.people.bulkAdd(toAdd);

    localStorage.setItem(SEED_FLAG, "1");
  } catch (e) {
    console.error("Seed failed", e);
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