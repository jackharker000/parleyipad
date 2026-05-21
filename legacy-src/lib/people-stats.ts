import { db, type Conversation, type Memory, type Place } from "./db";

export type PersonStats = {
  conversationCount: number;
  lastSeenAt?: number;
  commonPlaces: { place: Place; count: number }[];
  recentMemories: Memory[];
  followUps: string[];
};

export async function getPersonStats(personId: string): Promise<PersonStats> {
  const allConvs = await db.conversations.toArray();
  const convs = allConvs.filter((c) => c.person_ids?.includes(personId));
  const placeCounts = new Map<string, number>();
  let lastSeen = 0;
  for (const c of convs) {
    if (c.started_at > lastSeen) lastSeen = c.started_at;
    if (c.place_id) {
      placeCounts.set(c.place_id, (placeCounts.get(c.place_id) ?? 0) + 1);
    }
  }
  const placeIds = [...placeCounts.keys()];
  const places = (await db.places.bulkGet(placeIds)).filter(
    (p): p is Place => !!p,
  );
  const commonPlaces = places
    .map((p) => ({ place: p, count: placeCounts.get(p.id) ?? 0 }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 4);

  const memories = await db.memories
    .where("person_id")
    .equals(personId)
    .reverse()
    .sortBy("created_at");
  const recentMemories = memories
    .filter((m) => m.status !== "hidden")
    .slice(0, 12);

  const followUps = (
    await db.follow_ups.where("for_person_id").equals(personId).toArray()
  )
    .filter((f) => !f.used)
    .sort((a, b) => b.created_at - a.created_at)
    .slice(0, 6)
    .map((f) => f.text);

  return {
    conversationCount: convs.length,
    lastSeenAt: lastSeen || undefined,
    commonPlaces,
    recentMemories,
    followUps,
  };
}

export function summarizeRelationship(
  recentMemoryTexts: string[],
): { facts: string[]; preferences: string[]; events: string[]; todos: string[] } {
  return { facts: [], preferences: [], events: [], todos: [] };
}

/** Group memories by kind for display. */
export function groupMemories(memories: Memory[]) {
  const groups: Record<Memory["kind"], Memory[]> = {
    fact: [],
	preference: [],
    event: [],
    todo: [],
  };
  for (const m of memories) groups[m.kind].push(m);
  return groups;
}