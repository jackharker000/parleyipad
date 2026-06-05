import { useLiveQuery } from "dexie-react-hooks";
import { useCallback } from "react";

import { DEFAULT_SETTINGS, db, type SettingsRecord } from "@/lib/db";

/**
 * Read-only. Returning DEFAULT_SETTINGS when no row exists keeps this
 * querier valid inside `useLiveQuery` — Dexie throws on any write from a
 * liveQuery context. The singleton row is materialised lazily on first
 * write via `put`, not by seeding here.
 *
 * The stored row is MERGED over DEFAULT_SETTINGS so a partial record can
 * never surface `undefined` for a field the UI assumes is present. This is
 * a real failure mode: a settings row written by an older app version (or
 * restored from an older backup) may be missing fields like
 * `speakerIdAcceptThreshold`, and reading it raw crashed the System tab on
 * `value.toFixed(2)`. Spreading defaults first backfills every gap.
 */
async function readSettings(): Promise<SettingsRecord> {
  const existing = await db().settings.get("singleton");
  return existing ? { ...DEFAULT_SETTINGS, ...existing } : DEFAULT_SETTINGS;
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

/**
 * Imperative patch — merge into the existing row (or DEFAULT_SETTINGS if
 * there isn't one yet) and upsert. Use this from anywhere that needs to
 * change a setting outside React (event handlers, command palette, the
 * "Resume sync" pill in the app shell). React surfaces should prefer
 * `useSetting` so they get the re-render for free.
 */
export async function persistSettings(
  patch: Partial<SettingsRecord>,
): Promise<void> {
  const existing = await db().settings.get("singleton");
  const next: SettingsRecord = {
    ...DEFAULT_SETTINGS,
    ...(existing ?? {}),
    ...patch,
    id: "singleton",
  };
  await db().settings.put(next);
}
