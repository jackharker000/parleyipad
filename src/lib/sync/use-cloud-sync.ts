import { useEffect, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";

import { db } from "@/lib/db";
import { useSession } from "@/lib/auth";
import { useSettings } from "@/lib/settings";
import { isFirebaseConfigured } from "@/lib/firebase/client";

import { getSyncStatus, startCloudSync, subscribeSyncStatus } from "./engine";

/**
 * React surface for the write-behind sync engine.
 *
 * - Starts the engine when (signed-in) AND (cloudSyncEnabled) AND
 *   (Firebase is configured).
 * - Tears it down when those conditions stop holding.
 * - Exposes live status (last-flush, last-error) for the Settings panel.
 *
 * Mount once, near the top of the protected app tree. Calling
 * `startCloudSync` again with the same uid is a no-op, so this hook
 * is safe to use anywhere in the app — but mounting it twice would
 * still install two effects that both call stop on unmount, so prefer
 * one top-level mount.
 */
export function useCloudSync(): {
  running: boolean;
  enabled: boolean;
  pendingCount: number;
  lastFlushAt: number | null;
  lastError: string | null;
} {
  const { user } = useSession();
  const settings = useSettings();
  const enabled = settings.cloudSyncEnabled !== false; // undefined = on

  const [status, setStatus] = useState(() => getSyncStatus());

  // Subscribe to engine status events. The subscriber is cheap so we
  // attach it unconditionally; the engine emits nothing while idle.
  useEffect(() => {
    return subscribeSyncStatus(setStatus);
  }, []);

  // Start/stop the engine in response to user + settings. Always go
  // through the dispose returned by startCloudSync — calling
  // stopCloudSync() unconditionally tears the engine down regardless
  // of refcount, which would break a hypothetical second consumer
  // (Settings panel + app layout currently share one engine via
  // refcounting; the contract has to hold both ways).
  useEffect(() => {
    if (!user || !enabled || !isFirebaseConfigured()) {
      return;
    }
    const dispose = startCloudSync(user.id);
    return () => dispose();
  }, [user, enabled]);

  // Live pending count for the Settings panel.
  const pendingCount = useLiveQuery(
    async () => {
      // Subtract the cursor row (id="cursor") if it exists. Counting
      // and then filtering is cheaper than scanning the whole store.
      const total = await db().syncOutbox.count();
      const cursor = await db().syncOutbox.get("cursor");
      return Math.max(0, total - (cursor ? 1 : 0));
    },
    [],
    0,
  );

  return {
    running: status.running,
    enabled,
    pendingCount: pendingCount ?? 0,
    lastFlushAt: status.lastFlushAt,
    lastError: status.lastError,
  };
}
