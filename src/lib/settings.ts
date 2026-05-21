import { useLiveQuery } from "dexie-react-hooks";
import { useCallback } from "react";

import { DEFAULT_SETTINGS, db, type SettingsRecord } from "@/lib/db";

async function loadSettings(): Promise<SettingsRecord> {
  const existing = await db().settings.get("singleton");
  if (existing) return existing;
  await db().settings.put(DEFAULT_SETTINGS);
  return DEFAULT_SETTINGS;
}

export function useSettings(): SettingsRecord {
  const value = useLiveQuery(loadSettings, [], DEFAULT_SETTINGS);
  return value ?? DEFAULT_SETTINGS;
}

export function useSetting<K extends keyof SettingsRecord>(
  key: K,
): [SettingsRecord[K], (value: SettingsRecord[K]) => void] {
  const settings = useSettings();
  const update = useCallback(
    (value: SettingsRecord[K]) => {
      void db().settings.update("singleton", { [key]: value } as Partial<SettingsRecord>);
    },
    [key],
  );
  return [settings[key], update];
}

export async function getSettingsSnapshot(): Promise<SettingsRecord> {
  return loadSettings();
}
