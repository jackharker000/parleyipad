import { Link, createFileRoute } from "@tanstack/react-router";
import { useLiveQuery } from "dexie-react-hooks";

import { Button } from "@/components/ui/button";
import { getAccountById } from "@/lib/admin";
import type { AdminAccount } from "@/lib/admin";

export const Route = createFileRoute("/admin/users/$userId")({
  component: AdminUserDetailPage,
});

function AdminUserDetailPage() {
  const { userId } = Route.useParams();
  const account = useLiveQuery(() => getAccountById(userId), [userId]);

  return (
    <div className="mx-auto max-w-6xl px-5 py-8">
      <Link
        to="/admin/users"
        className="text-sm font-medium text-[var(--teal-dark)] hover:underline"
      >
        ← Back to users
      </Link>

      {account === undefined ? (
        <p className="mt-6 text-sm text-[var(--ink-soft)]">Loading…</p>
      ) : account === null ? (
        <>
          <h1 className="mt-2 text-3xl font-semibold tracking-tight">Account</h1>
          <p className="mt-6 text-sm text-[var(--ink-soft)]">Account not found.</p>
        </>
      ) : (
        <>
          <h1 className="mt-2 text-3xl font-semibold tracking-tight">{account.email}</h1>
          <div className="mt-6 grid grid-cols-1 gap-4 lg:grid-cols-2">
            <InfoCard account={account} />
          </div>
          <DangerZone />
        </>
      )}
    </div>
  );
}

function InfoCard({ account }: { account: AdminAccount }) {
  return (
    <div className="rounded-2xl border border-[var(--line)] bg-white p-6">
      <h2 className="text-base font-semibold">Account</h2>
      <dl className="mt-4 grid grid-cols-[140px_1fr] gap-y-2 text-sm">
        <Dt>ID</Dt>
        <Dd className="font-mono text-xs">{account.id}</Dd>

        <Dt>Email</Dt>
        <Dd>{account.email}</Dd>

        <Dt>Created</Dt>
        <Dd>{fmtDateTime(account.createdAt)}</Dd>

        <Dt>Last sign in</Dt>
        <Dd>{fmtDateTime(account.lastSignInAt)}</Dd>

        <Dt>Admin</Dt>
        <Dd>
          {account.is_admin ? (
            <span className="inline-flex items-center rounded-full bg-[var(--teal)]/10 px-2 py-0.5 text-xs font-medium text-[var(--teal-dark)]">
              admin
            </span>
          ) : (
            <span className="text-[var(--ink-soft)]">no</span>
          )}
        </Dd>
      </dl>
    </div>
  );
}

function DangerZone() {
  return (
    <div className="mt-6 rounded-2xl border border-[var(--line)] bg-white p-6">
      <h2 className="text-base font-semibold text-[var(--coral)]">Danger zone</h2>
      <p className="mt-1 text-sm text-[var(--ink-soft)]">
        Destructive actions — not yet wired up. The buttons are visible so the affordance is
        obvious, but they do nothing.
      </p>
      <div className="mt-4 flex flex-wrap gap-3">
        <Button variant="outline" disabled title="Not implemented">
          Revoke admin
        </Button>
        <Button variant="destructive" disabled title="Not implemented">
          Delete account
        </Button>
      </div>
    </div>
  );
}

function Dt({ children }: { children: React.ReactNode }) {
  return <dt className="font-medium text-[var(--ink-soft)]">{children}</dt>;
}

function Dd({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return <dd className={className ?? ""}>{children}</dd>;
}

function fmtDateTime(ts: number | null | undefined): string {
  if (ts == null) return "—";
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString();
}
