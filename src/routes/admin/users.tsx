import { Link, createFileRoute } from "@tanstack/react-router";
import { useLiveQuery } from "dexie-react-hooks";

import { Button } from "@/components/ui/button";
import { getAccounts } from "@/lib/admin";
import type { AdminAccount } from "@/lib/admin";

export const Route = createFileRoute("/admin/users")({
  component: AdminUsersPage,
});

function AdminUsersPage() {
  const accounts = useLiveQuery(() => getAccounts());

  if (accounts === undefined) {
    return (
      <div className="mx-auto max-w-6xl px-5 py-8">
        <h1 className="text-3xl font-semibold tracking-tight">Users</h1>
        <p className="mt-6 text-sm text-[var(--ink-soft)]">Loading…</p>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-6xl px-5 py-8">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h1 className="text-3xl font-semibold tracking-tight">Users</h1>
        <p className="text-sm text-[var(--ink-soft)]">
          {accounts.length === 0
            ? "No accounts to show"
            : `${accounts.length.toLocaleString()} on this device`}
        </p>
      </div>

      <div className="mt-6 rounded-2xl border border-[var(--line)] bg-white p-3">
        {accounts.length === 0 ? (
          <EmptyState />
        ) : (
          <AccountsTable accounts={accounts} />
        )}
      </div>
    </div>
  );
}

function EmptyState() {
  return (
    <div className="py-12 text-center">
      <p className="text-sm font-medium">No accounts on this device yet.</p>
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

function AccountsTable({ accounts }: { accounts: AdminAccount[] }) {
  return (
    <table className="w-full border-separate border-spacing-0 text-sm">
      <thead>
        <tr>
          <Th>Email</Th>
          <Th>Created</Th>
          <Th>Last seen</Th>
          <Th>Admin</Th>
          <Th>Actions</Th>
        </tr>
      </thead>
      <tbody>
        {accounts.map((a) => (
          <tr key={a.id}>
            <Td>{a.email}</Td>
            <Td>{fmtDate(a.createdAt)}</Td>
            <Td>{fmtDate(a.lastSignInAt)}</Td>
            <Td>{a.is_admin ? <AdminBadge /> : null}</Td>
            <Td>
              <Link to="/admin/users/$userId" params={{ userId: a.id }}>
                <Button variant="outline" size="sm">
                  View
                </Button>
              </Link>
            </Td>
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

function fmtDate(ts: number | null | undefined): string {
  if (ts == null) return "—";
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}
