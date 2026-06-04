import { useEffect, useMemo, useState } from "react";
import { Link, createFileRoute } from "@tanstack/react-router";

import { Button } from "@/components/ui/button";
import {
  AdminApiError,
  fetchUsage,
  fetchUsers,
  relativeTime,
} from "@/lib/admin";
import type { AdminUserRecord, UsageAggregate } from "@/lib/admin";

export const Route = createFileRoute("/admin/users")({
  component: AdminUsersPage,
});

type SortKey = "lastSignInDesc" | "emailAsc" | "createdDesc";

function AdminUsersPage() {
  const [users, setUsers] = useState<AdminUserRecord[] | null>(null);
  const [usage7d, setUsage7d] = useState<UsageAggregate | null>(null);
  const [usage30d, setUsage30d] = useState<UsageAggregate | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<AdminApiError | null>(null);

  // Filter / sort UI state. Email search is debounced separately below.
  const [emailQueryRaw, setEmailQueryRaw] = useState("");
  const [emailQuery, setEmailQuery] = useState("");
  const [adminsOnly, setAdminsOnly] = useState(false);
  const [activeOnly, setActiveOnly] = useState(false);
  const [sortKey, setSortKey] = useState<SortKey>("lastSignInDesc");

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    Promise.all([fetchUsers(), fetchUsage(7), fetchUsage(30)])
      .then(([usersList, u7, u30]) => {
        if (!cancelled) {
          setUsers(usersList);
          setUsage7d(u7);
          setUsage30d(u30);
          setError(null);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setError(
            err instanceof AdminApiError
              ? err
              : new AdminApiError(0, "Couldn't load users."),
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

  // 200ms debounce on the email search box so each keystroke doesn't re-sort.
  useEffect(() => {
    const t = window.setTimeout(() => setEmailQuery(emailQueryRaw.trim()), 200);
    return () => window.clearTimeout(t);
  }, [emailQueryRaw]);

  const activeUidSet7d = useMemo(() => {
    const s = new Set<string>();
    for (const b of usage7d?.byUser ?? []) {
      if (b.uid && b.events > 0) s.add(b.uid);
    }
    return s;
  }, [usage7d]);

  const spendByUid30d = useMemo(() => {
    const m = new Map<string, number>();
    for (const b of usage30d?.byUser ?? []) {
      if (b.uid) m.set(b.uid, b.millicents);
    }
    return m;
  }, [usage30d]);

  const visibleUsers = useMemo(() => {
    let list = users ?? [];
    if (emailQuery) {
      const q = emailQuery.toLowerCase();
      list = list.filter((u) => (u.email ?? "").toLowerCase().includes(q));
    }
    if (adminsOnly) list = list.filter((u) => u.is_admin);
    if (activeOnly) list = list.filter((u) => activeUidSet7d.has(u.uid));

    const sorted = [...list];
    sorted.sort((a, b) => {
      if (sortKey === "emailAsc") {
        return (a.email ?? "").localeCompare(b.email ?? "");
      }
      if (sortKey === "createdDesc") {
        return dateMs(b.createdAt) - dateMs(a.createdAt);
      }
      // default: last sign-in desc
      return dateMs(b.lastSignInAt) - dateMs(a.lastSignInAt);
    });
    return sorted;
  }, [users, emailQuery, adminsOnly, activeOnly, sortKey, activeUidSet7d]);

  if (loading) {
    return (
      <div className="mx-auto max-w-screen-2xl px-5 py-5">
        <h1 className="text-3xl font-semibold tracking-tight">Users</h1>
        <div className="mt-6 rounded-2xl border border-[var(--line)] bg-white p-3">
          <RowSkeletons rows={5} />
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="mx-auto max-w-screen-2xl px-5 py-5">
        <h1 className="text-3xl font-semibold tracking-tight">Users</h1>
        <ErrorCard error={error} />
      </div>
    );
  }

  const list = users ?? [];
  const showing = visibleUsers.length;
  const total = list.length;

  return (
    <div className="mx-auto max-w-screen-2xl px-5 py-5">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h1 className="text-3xl font-semibold tracking-tight">Users</h1>
        <p className="text-sm text-[var(--ink-soft)]">
          {total === 0
            ? "No users to show"
            : showing === total
              ? `${total.toLocaleString()} total`
              : `${showing.toLocaleString()} of ${total.toLocaleString()}`}
        </p>
      </div>

      {/* Sticky filter bar */}
      <div className="sticky top-[57px] z-10 mt-4 -mx-5 border-y border-[var(--line)] bg-background/95 px-5 py-3 backdrop-blur">
        <div className="flex flex-wrap items-center gap-3">
          <input
            type="search"
            value={emailQueryRaw}
            onChange={(e) => setEmailQueryRaw(e.target.value)}
            placeholder="Search by email"
            className="w-64 rounded-md border border-[var(--line)] bg-white px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-[var(--teal)]"
          />
          <label className="inline-flex cursor-pointer items-center gap-2 text-sm text-[var(--ink-soft)]">
            <input
              type="checkbox"
              checked={adminsOnly}
              onChange={(e) => setAdminsOnly(e.target.checked)}
            />
            Admins only
          </label>
          <label className="inline-flex cursor-pointer items-center gap-2 text-sm text-[var(--ink-soft)]">
            <input
              type="checkbox"
              checked={activeOnly}
              onChange={(e) => setActiveOnly(e.target.checked)}
            />
            Active in last 7d
          </label>
          <div className="ml-auto inline-flex items-center gap-2 text-sm text-[var(--ink-soft)]">
            <label htmlFor="users-sort">Sort</label>
            <select
              id="users-sort"
              value={sortKey}
              onChange={(e) => setSortKey(e.target.value as SortKey)}
              className="rounded-md border border-[var(--line)] bg-white px-2 py-1.5 text-sm"
            >
              <option value="lastSignInDesc">By last sign-in</option>
              <option value="emailAsc">By email</option>
              <option value="createdDesc">By created</option>
            </select>
          </div>
        </div>
      </div>

      <div className="mt-4 rounded-2xl border border-[var(--line)] bg-white p-3">
        {total === 0 ? (
          <EmptyState />
        ) : showing === 0 ? (
          <EmptyRow message="No users match these filters." />
        ) : (
          <UsersTable
            users={visibleUsers}
            activeUidSet7d={activeUidSet7d}
            spendByUid30d={spendByUid30d}
          />
        )}
      </div>
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

function EmptyState() {
  return (
    <div className="py-12 text-center">
      <p className="text-sm font-medium">No users yet.</p>
    </div>
  );
}

function EmptyRow({ message }: { message: string }) {
  return <p className="px-3 py-6 text-center text-sm text-[var(--ink-soft)]">{message}</p>;
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

function AdminBadge() {
  return (
    <span className="inline-flex items-center rounded-full bg-[var(--teal)]/10 px-2 py-0.5 text-xs font-medium text-[var(--teal-dark)]">
      admin
    </span>
  );
}

function ActiveDot() {
  return (
    <span
      title="Active in the last 7 days"
      className="inline-block h-2 w-2 rounded-full bg-[var(--teal)]"
    />
  );
}

function UsersTable({
  users,
  activeUidSet7d,
  spendByUid30d,
}: {
  users: AdminUserRecord[];
  activeUidSet7d: Set<string>;
  spendByUid30d: Map<string, number>;
}) {
  return (
    <table className="w-full border-separate border-spacing-0 text-sm">
      <thead>
        <tr>
          <Th>Email</Th>
          <Th>Provider</Th>
          <Th>Created</Th>
          <Th>Last sign-in</Th>
          <Th>Last active</Th>
          <Th>30d spend</Th>
          <Th>Admin</Th>
          <Th>Disabled</Th>
          <Th>Actions</Th>
        </tr>
      </thead>
      <tbody>
        {users.map((u) => {
          const active = activeUidSet7d.has(u.uid);
          const spend = spendByUid30d.get(u.uid) ?? 0;
          return (
            <tr key={u.uid}>
              <Td>
                <div className="flex items-center gap-2">
                  {active ? <ActiveDot /> : null}
                  <span>{u.email ?? "—"}</span>
                </div>
              </Td>
              <Td>{u.provider ?? "—"}</Td>
              <Td>{fmtDate(u.createdAt)}</Td>
              <Td>{fmtDate(u.lastSignInAt)}</Td>
              <Td>{relativeTime(u.lastSignInAt)}</Td>
              <Td>{spend > 0 ? fmtSpend(spend) : <Muted>—</Muted>}</Td>
              <Td>{u.is_admin ? <AdminBadge /> : null}</Td>
              <Td>{u.disabled ? "Yes" : "No"}</Td>
              <Td>
                <Link to="/admin/users/$userId" params={{ userId: u.uid }}>
                  <Button variant="outline" size="sm">
                    View
                  </Button>
                </Link>
              </Td>
            </tr>
          );
        })}
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

function Muted({ children }: { children: React.ReactNode }) {
  return <span className="text-[var(--ink-soft)]">{children}</span>;
}

function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

function fmtSpend(millicents: number): string {
  return (millicents / 100_000).toLocaleString(undefined, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function dateMs(iso: string | null | undefined): number {
  if (!iso) return 0;
  const t = new Date(iso).getTime();
  return Number.isFinite(t) ? t : 0;
}

