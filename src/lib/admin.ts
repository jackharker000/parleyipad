import { listLocalAccounts } from "@/lib/auth-local";

/**
 * Admin data helpers — ON-DEVICE only.
 *
 * Auth moved off Supabase: accounts now live in IndexedDB on each device.
 * There is no server-side user list and no cross-device aggregation, so the
 * admin dashboard only ever sees accounts created on *this* device.
 *
 * These are plain async client helpers (NOT `createServerFn`). They wrap
 * `listLocalAccounts()` from `@/lib/auth-local`, which reads Dexie and never
 * returns password material. Because Dexie is browser-only, these must be
 * called from the client (in components), never from route loaders (SSR).
 */

export type AdminAccount = {
  id: string;
  email: string;
  is_admin: boolean;
  createdAt: number;
  lastSignInAt: number | null;
};

export async function getAccounts(): Promise<AdminAccount[]> {
  const accounts = await listLocalAccounts();
  return accounts.map((a) => ({
    id: a.id,
    email: a.email,
    is_admin: a.is_admin,
    createdAt: a.createdAt,
    lastSignInAt: a.lastSignInAt,
  }));
}

export async function getAccountById(id: string): Promise<AdminAccount | null> {
  const accounts = await getAccounts();
  return accounts.find((a) => a.id === id) ?? null;
}
