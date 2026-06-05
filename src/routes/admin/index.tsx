import { useEffect, useState } from "react";
import { Link, createFileRoute } from "@tanstack/react-router";

import {
  AdminApiError,
  fetchSyncErrorsSummary,
  fetchUsage,
  fetchUsers,
  relativeTime,
} from "@/lib/admin";
import type { AdminUserRecord, UsageAggregate } from "@/lib/admin";

export const Route = createFileRoute("/admin/")({
  component: AdminOverview,
});

function AdminOverview() {
  const [users, setUsers] = useState<AdminUserRecord[] | null>(null);
  const [usage1d, setUsage1d] = useState<UsageAggregate | null>(null);
  const [usage7d, setUsage7d] = useState<UsageAggregate | null>(null);
  const [usage30d, setUsage30d] = useState<UsageAggregate | null>(null);
  const [syncErrorCounts, setSyncErrorCounts] = useState<Record<string, number>>(
    {},
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<AdminApiError | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    // The sync-errors summary is allowed to fail (e.g. missing collection-
    // group index) without taking down the page; we fall back to zero and
    // the stat card shows "0 users".
    Promise.all([
      fetchUsers(),
      fetchUsage(1),
      fetchUsage(7),
      fetchUsage(30),
      fetchSyncErrorsSummary().catch(() => ({}) as Record<string, number>),
    ])
      .then(([list, u1, u7, u30, syncErrors]) => {
        if (!cancelled) {
          setUsers(list);
          setUsage1d(u1);
          setUsage7d(u7);
          setUsage30d(u30);
          setSyncErrorCounts(syncErrors);
          setError(null);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setError(
            err instanceof AdminApiError
              ? err
              : new AdminApiError(0, "Couldn't load admin overview."),
          );
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Live refresh for the "Active now" widget. Polls every 30s, force-bypassing
  // the shared 30s cache so each tick actually hits the server. Cleans up on
  // unmount; the cache TTL elsewhere prevents this from hammering Firestore
  // when multiple admin tabs are open at once.
  useEffect(() => {
    const id = window.setInterval(() => {
      fetchUsage(1, { force: true })
        .then((u) => setUsage1d(u))
        .catch(() => {
          // Stay on the last good snapshot — better than blanking the widget.
        });
    }, 30_000);
    return () => window.clearInterval(id);
  }, []);

  const banner = (
    <div className="mt-6 rounded-2xl bg-[var(--sand-2)] p-4 text-sm text-[var(--ink-soft)]">
      Accounts are managed in Firebase. This dashboard shows every Parley account across all
      devices.
    </div>
  );

  if (loading) {
    return (
      <div className="mx-auto max-w-screen-2xl px-5 py-5">
        <h1 className="text-3xl font-semibold tracking-tight">Overview</h1>
        {banner}
        <div className="mt-6 grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-6">
          {Array.from({ length: 6 }).map((_, i) => (
            <StatSkeleton key={i} />
          ))}
        </div>
        <section className="mt-10">
          <h2 className="text-xl font-semibold tracking-tight">Recent users</h2>
          <div className="mt-3 rounded-2xl border border-[var(--line)] bg-white p-3">
            <RowSkeletons rows={5} />
          </div>
        </section>
      </div>
    );
  }

  if (error) {
    return (
      <div className="mx-auto max-w-screen-2xl px-5 py-5">
        <h1 className="text-3xl font-semibold tracking-tight">Overview</h1>
        {banner}
        <ErrorCard error={error} />
      </div>
    );
  }

  const list = users ?? [];
  const admins = list.filter((u) => u.is_admin).length;
  const activeUsers7d =
    usage7d?.byUser.filter((b) => b.uid && b.events > 0).length ?? 0;
  const spend30dDollars = (usage30d?.totals.millicents ?? 0) / 100_000;
  const activeRecent = usage1d?.activeRecent;
  const activeNowUids = activeRecent?.uids ?? [];
  const activeNowWindow = activeRecent?.minutes ?? 15;
  const emailByUid = new Map<string, string | null>();
  for (const u of list) emailByUid.set(u.uid, u.email);
  const activeNowEmails = activeNowUids
    .map((uid) => emailByUid.get(uid) ?? null)
    .filter((email): email is string => Boolean(email));
  const usersWithSyncErrors = Object.values(syncErrorCounts).filter(
    (n) => n > 0,
  ).length;

  return (
    <div className="mx-auto max-w-screen-2xl px-5 py-5">
      <h1 className="text-3xl font-semibold tracking-tight">Overview</h1>

      {banner}

      <div className="mt-6 grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-6">
        <StatCard label="Total users" value={list.length.toLocaleString()} />
        <StatCard label="Active users (7d)" value={activeUsers7d.toLocaleString()} />
        <StatCard label="Admins" value={admins.toLocaleString()} />
        <StatCard
          label="30d spend ($)"
          value={spend30dDollars.toLocaleString(undefined, {
            style: "currency",
            currency: "USD",
            minimumFractionDigits: 2,
            maximumFractionDigits: 2,
          })}
        />
        <ActiveNowCard
          uids={activeNowUids}
          emails={activeNowEmails}
          windowMinutes={activeNowWindow}
        />
        <SyncErrorsCard count={usersWithSyncErrors} />
      </div>

      <section className="mt-10">
        <div className="flex items-baseline justify-between">
          <h2 className="text-xl font-semibold tracking-tight">Recent users</h2>
          <Link
            to="/admin/users"
            className="text-sm font-medium text-[var(--teal-dark)] hover:underline"
          >
            View all
          </Link>
        </div>
        <div className="mt-3 rounded-2xl border border-[var(--line)] bg-white p-3">
          {list.length === 0 ? (
            <EmptyRow message="No users yet." />
          ) : (
            <RecentUsersTable users={list.slice(0, 10)} />
          )}
        </div>
      </section>
    </div>
  );
}

function ErrorCard({ error }: { error: AdminApiError }) {
  const is503 = error.status === 503;
  return (
    <div className="mt-6 rounded-2xl border border-[var(--line)] bg-white p-6">
      <h2 className="text-base font-semibold">
        {is503 ? "Admin features aren't configured yet" : "Couldn't load users"}
      </h2>
      <p className="mt-2 text-sm text-[var(--ink-soft)]">{error.message}</p>
    </div>
  );
}

function StatCard({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="rounded-2xl border border-[var(--line)] bg-white p-6">
      <div className="text-sm font-medium text-[var(--ink-soft)]">{label}</div>
      <div className="mt-2 text-3xl font-semibold tracking-tight">{value}</div>
      {note ? <p className="mt-2 text-xs italic text-[var(--ink-soft)]">{note}</p> : null}
    </div>
  );
}

/**
 * Live "Active now" card. Refreshes every 30s on the page (see the polling
 * effect in AdminOverview). When nobody is active in the window, falls back
 * to a soft muted message so the card never reads as broken.
 */
function ActiveNowCard({
  uids,
  emails,
  windowMinutes,
}: {
  uids: string[];
  emails: string[];
  windowMinutes: number;
}) {
  const count = uids.length;
  return (
    <div className="rounded-2xl border border-[var(--line)] bg-white p-6">
      <div className="flex items-center justify-between">
        <div className="text-sm font-medium text-[var(--ink-soft)]">Active now</div>
        {count > 0 ? (
          <span
            title={`Active in the last ${windowMinutes} minutes`}
            className="inline-block h-2 w-2 rounded-full bg-[var(--teal)]"
          />
        ) : null}
      </div>
      <div className="mt-2 text-3xl font-semibold tracking-tight">
        {count.toLocaleString()}
      </div>
      {count === 0 ? (
        <p className="mt-2 text-xs italic text-[var(--ink-soft)]">
          Nobody right now.
        </p>
      ) : (
        <p
          className="mt-2 line-clamp-2 text-xs text-[var(--ink-soft)]"
          title={emails.join("\n")}
        >
          {emails.length > 0 ? emails.join(", ") : `${count} unknown`}
        </p>
      )}
    </div>
  );
}

/**
 * Sync error stat — count of distinct users with at least one unrecovered
 * sync error in the last 24h. Click-through deep-links to the Users page
 * with the "Sync issues" filter pre-applied. When the underlying Firestore
 * collection-group index is missing the API returns an empty map, so this
 * card shows "0" rather than erroring — by design, the dashboard never
 * reads as broken just because the index hasn't been provisioned.
 */
function SyncErrorsCard({ count }: { count: number }) {
  return (
    <Link
      to="/admin/users"
      search={{ syncIssues: 1 }}
      className="block rounded-2xl border border-[var(--line)] bg-white p-6 transition hover:border-[var(--coral)]/40"
    >
      <div className="flex items-center justify-between">
        <div className="text-sm font-medium text-[var(--ink-soft)]">
          Users with sync errors (24h)
        </div>
        {count > 0 ? (
          <span
            title="At least one unrecovered sync error logged in the last 24h"
            className="inline-block h-2 w-2 rounded-full bg-[var(--coral)]"
          />
        ) : null}
      </div>
      <div className="mt-2 text-3xl font-semibold tracking-tight">
        {count.toLocaleString()}
      </div>
      {count === 0 ? (
        <p className="mt-2 text-xs italic text-[var(--ink-soft)]">
          Sync is healthy across all users.
        </p>
      ) : (
        <p className="mt-2 text-xs text-[var(--teal-dark)]">
          View affected users →
        </p>
      )}
    </Link>
  );
}

function StatSkeleton() {
  return (
    <div className="h-24 rounded-2xl bg-[var(--sand-2)]/60 animate-pulse" />
  );
}

function RowSkeletons({ rows }: { rows: number }) {
  return (
    <div className="flex flex-col gap-2">
      {Array.from({ length: rows }).map((_, i) => (
        <div
          key={i}
          className="h-12 bg-[var(--sand-2)]/60 rounded-md animate-pulse"
        />
      ))}
    </div>
  );
}

function EmptyRow({ message }: { message: string }) {
  return <p className="px-3 py-6 text-center text-sm text-[var(--ink-soft)]">{message}</p>;
}

function AdminBadge() {
  return (
    <span className="inline-flex items-center rounded-full bg-[var(--teal)]/10 px-2 py-0.5 text-xs font-medium text-[var(--teal-dark)]">
      admin
    </span>
  );
}

function RecentUsersTable({ users }: { users: AdminUserRecord[] }) {
  return (
    <table className="w-full border-separate border-spacing-0 text-sm">
      <thead>
        <tr>
          <Th>Email</Th>
          <Th>Created</Th>
          <Th>Last seen</Th>
          <Th>Admin</Th>
        </tr>
      </thead>
      <tbody>
        {users.map((u) => (
          <tr key={u.uid}>
            <Td>{u.email ?? "—"}</Td>
            <Td>{fmtDate(u.createdAt)}</Td>
            <Td>{relativeTime(u.lastSignInAt)}</Td>
            <Td>{u.is_admin ? <AdminBadge /> : null}</Td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Th({ children }: { children: React.ReactNode }) {
  return (
    <th className="bg-muted/40 text-left font-medium px-3 py-2 border-b border-[var(--line)]">
      {children}
    </th>
  );
}

function Td({ children }: { children: React.ReactNode }) {
  return <td className="px-3 py-2 border-b border-[var(--line)] align-top">{children}</td>;
}

function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}
