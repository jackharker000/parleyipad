import { useLiveQuery } from "dexie-react-hooks";
import { useCallback } from "react";

import { DEFAULT_SETTINGS, db, type SettingsRecord } from "@/lib/db";

/**
 * Read-only. Returning DEFAULT_SETTINGS when no row exists keeps this
 * querier valid inside `useLiveQuery` — Dexie throws on any write from a
 * liveQuery context. The singleton row is materialised lazily on first
 * write via `put`, not by seeding here.
 */
async function readSettings(): Promise<SettingsRecord> {
  const existing = await db().settings.get("singleton");
  return existing ?? DEFAULT_SETTINGS;
}

export function useSettings(): SettingsRecord {
  const value = useLiveQuery(readSettings, [], DEFAULT_SETTINGS);
  return value ?? DEFAULT_SETTINGS;
}

export function useSetting<K extends keyof SettingsRecord>(
  key: K,
): [SettingsRecord[K], (value: SettingsRecord[K]) => void] {
  const settings = useSettings();
  const update = useCallback(
    (value: SettingsRecord[K]) => {
      // Upsert the full merged record so the singleton row gets created on
      // first write. `db.settings.update` would fail if the row doesn't yet
      // exist; `put` doesn't care.
      void db().settings.put({ ...settings, [key]: value });
    },
    [key, settings],
  );
  return [settings[key], update];
}

export async function getSettingsSnapshot(): Promise<SettingsRecord> {
  return readSettings();
}
