import { Link, createFileRoute } from "@tanstack/react-router";
import { useLiveQuery } from "dexie-react-hooks";

import { getAccounts } from "@/lib/admin";
import type { AdminAccount } from "@/lib/admin";

export const Route = createFileRoute("/admin/")({
  component: AdminOverview,
});

function AdminOverview() {
  const accounts = useLiveQuery(() => getAccounts());

  if (accounts === undefined) {
    return (
      <div className="mx-auto max-w-6xl px-5 py-8">
        <h1 className="text-3xl font-semibold tracking-tight">Overview</h1>
        <p className="mt-6 text-sm text-[var(--ink-soft)]">Loading…</p>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-6xl px-5 py-8">
      <h1 className="text-3xl font-semibold tracking-tight">Overview</h1>

      <div className="mt-6 rounded-2xl bg-[var(--sand-2)] p-4 text-sm text-[var(--ink-soft)]">
        Parley accounts are stored on each device. This dashboard shows the accounts on this iPad
        only — there is no central server, so you can&apos;t see users on other devices from here.
      </div>

      <div className="mt-6 grid grid-cols-1 gap-4 md:grid-cols-3">
        <StatCard label="Accounts on this device" value={accounts.length.toLocaleString()} />
        <StatCard
          label="Conversations (last 7 days)"
          value="Not tracked"
          note="Conversation data lives in each account's on-device storage."
        />
        <StatCard
          label="Waitlist"
          value="Not available"
          note="Waitlist needs a backend; not stored on-device."
        />
      </div>

      <section className="mt-10">
        <div className="flex items-baseline justify-between">
          <h2 className="text-xl font-semibold tracking-tight">Accounts on this device</h2>
          <Link
            to="/admin/users"
            className="text-sm font-medium text-[var(--teal-dark)] hover:underline"
          >
            View all
          </Link>
        </div>
        <div className="mt-3 rounded-2xl border border-[var(--line)] bg-white p-3">
          {accounts.length === 0 ? (
            <EmptyRow message="No accounts on this device yet." />
          ) : (
            <AccountsTable accounts={accounts} />
          )}
        </div>
      </section>
    </div>
  );
}

function StatCard({
  label,
  value,
  note,
}: {
  label: string;
  value: string;
  note?: string;
}) {
  return (
    <div className="rounded-2xl border border-[var(--line)] bg-white p-6">
      <div className="text-sm font-medium text-[var(--ink-soft)]">{label}</div>
      <div className="mt-2 text-3xl font-semibold tracking-tight">{value}</div>
      {note ? <p className="mt-2 text-xs italic text-[var(--ink-soft)]">{note}</p> : null}
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

function AccountsTable({ accounts }: { accounts: AdminAccount[] }) {
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
        {accounts.map((a) => (
          <tr key={a.id}>
            <Td>{a.email}</Td>
            <Td>{fmtDate(a.createdAt)}</Td>
            <Td>{fmtDate(a.lastSignInAt)}</Td>
            <Td>{a.is_admin ? <AdminBadge /> : null}</Td>
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
