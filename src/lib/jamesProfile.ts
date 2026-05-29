import { useLiveQuery } from "dexie-react-hooks";

import { DEFAULT_JAMES_PROFILE, db, type JamesProfile } from "@/lib/db";

/**
 * Singleton-row helpers for `db.jamesProfile`. Same pattern as
 * `src/lib/settings.ts` — the row is materialised lazily on the first write
 * via `put`, not seeded on read.
 */

async function readJamesProfile(): Promise<JamesProfile> {
  const existing = await db().jamesProfile.get("singleton");
  return existing ?? DEFAULT_JAMES_PROFILE;
}

export function useJamesProfile(): JamesProfile {
  const value = useLiveQuery(readJamesProfile, [], DEFAULT_JAMES_PROFILE);
  return value ?? DEFAULT_JAMES_PROFILE;
}

export async function getJamesProfile(): Promise<JamesProfile> {
  return readJamesProfile();
}

export async function updateJamesProfile(patch: Partial<JamesProfile>): Promise<void> {
  const current = await readJamesProfile();
  await db().jamesProfile.put({
    ...current,
    ...patch,
    id: "singleton",
    updatedAt: Date.now(),
  });
}
