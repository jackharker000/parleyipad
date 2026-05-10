import { db, getJamesProfile, type Person, type Place } from "./db";

export type ConversationContext = {
  jamesProfile: {
    name: string;
    background?: string;
    personality?: string;
    humor?: string;
    communication?: string;
    topicsLoved?: string;
    topicsAvoided?: string;
    signaturePhrases?: string[];
    currentLifeContext?: string;
    freeform?: string;
  };
  people: Array<{
    name: string;
    relationship?: string;
    interests?: string[];
    notes?: string;
    style_notes?: string;
    recentMemories: string[]; // most recent memory texts about this person
    followUps: string[]; // unused follow-ups for this person
  }>;
  place?: {
    name: string;
    notes?: string;
    recentMemories: string[];
    followUps: string[];
  };
  styleProfileJson?: string;
};

const RECENT_MEMORY_LIMIT = 8;
const FOLLOW_UP_LIMIT = 6;

export async function suggestPeopleAtPlace(placeId: string, limit = 6): Promise<Person[]> {
  const convs = await db.conversations.where("place_id").equals(placeId).toArray();
  const counts = new Map<string, number>();
  for (const c of convs) {
    for (const pid of c.person_ids ?? []) {
      counts.set(pid, (counts.get(pid) ?? 0) + 1);
    }
  }
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit);
  const people = await db.people.bulkGet(sorted.map(([id]) => id));
  return people.filter((p): p is Person => !!p);
}

async function memoriesForPerson(personId: string): Promise<string[]> {
  const mems = await db.memories
    .where("person_id")
    .equals(personId)
    .reverse()
    .sortBy("created_at");
  return mems
    .filter((m) => m.status !== "hidden")
    .slice(0, RECENT_MEMORY_LIMIT)
    .map((m) => `[${m.kind}] ${m.text}`);
}

async function followUpsForPerson(personId: string): Promise<string[]> {
  const fs = await db.follow_ups
    .where("for_person_id")
    .equals(personId)
    .reverse()
    .sortBy("created_at");
  return fs.filter((f) => !f.used).slice(0, FOLLOW_UP_LIMIT).map((f) => f.text);
}

async function memoriesForPlace(placeId: string): Promise<string[]> {
  const mems = await db.memories
    .where("place_id")
    .equals(placeId)
    .reverse()
    .sortBy("created_at");
  return mems
    .filter((m) => m.status !== "hidden")
    .slice(0, RECENT_MEMORY_LIMIT)
    .map((m) => `[${m.kind}] ${m.text}`);
}

async function followUpsForPlace(placeId: string): Promise<string[]> {
  const fs = await db.follow_ups
    .where("for_place_id")
    .equals(placeId)
    .reverse()
    .sortBy("created_at");
  return fs.filter((f) => !f.used).slice(0, FOLLOW_UP_LIMIT).map((f) => f.text);
}

export async function buildConversationContext(opts: {
  personIds: string[];
  place?: Place;
}): Promise<ConversationContext> {
  const profile = await getJamesProfile();
  const styleProfile = await db.style_profile.get("singleton");

  // Reference documents attached to James's profile — fold into freeform
  // notes so they reach the model without changing the prompt schema.
  const docs = await db.james_documents.orderBy("created_at").toArray();
  const PER_DOC_CHARS = 4000;
  const TOTAL_DOC_CHARS = 16000;
  let docsBlock = "";
  let used = 0;
  for (const d of docs) {
    const remaining = TOTAL_DOC_CHARS - used;
    if (remaining <= 200) break;
    const slice = (d.text ?? "").slice(0, Math.min(PER_DOC_CHARS, remaining));
    if (!slice.trim()) continue;
    docsBlock += `\n\n## Reference document: ${d.name}${d.note ? ` — ${d.note}` : ""}\n${slice}`;
    used += slice.length;
  }
  const freeformCombined = [profile.freeform_notes, docsBlock.trim() ? `Reference documents about James:${docsBlock}` : ""]
    .filter(Boolean)
    .join("\n\n");

  const peopleRows = (await db.people.bulkGet(opts.personIds)).filter(
    (p): p is Person => !!p,
  );
  const people = await Promise.all(
    peopleRows.map(async (p) => ({
      name: p.name,
      relationship: p.relationship,
      interests: p.interests,
      notes: p.notes,
      style_notes: p.style_notes,
      recentMemories: await memoriesForPerson(p.id),
      followUps: await followUpsForPerson(p.id),
    })),
  );

  let place: ConversationContext["place"] | undefined;
  if (opts.place) {
    place = {
      name: opts.place.name,
      notes: opts.place.notes,
      recentMemories: await memoriesForPlace(opts.place.id),
      followUps: await followUpsForPlace(opts.place.id),
    };
  }

  return {
    jamesProfile: {
      name: profile.display_name || "James",
      background: profile.background,
      personality: profile.personality,
      humor: profile.humor_style,
      communication: profile.communication_style,
      topicsLoved: profile.topics_loved,
      topicsAvoided: profile.topics_avoided,
      signaturePhrases: profile.signature_phrases
        ?.split(/\r?\n/)
        .map((s) => s.trim())
        .filter(Boolean),
      currentLifeContext: profile.current_life_context,
      freeform: freeformCombined || undefined,
    },
    people,
    place,
    styleProfileJson: styleProfile?.json,
  };
}