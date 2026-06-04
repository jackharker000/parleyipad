import { useEffect, useMemo, useState } from "react";
import { Link, createFileRoute, useNavigate } from "@tanstack/react-router";
import { z } from "zod";

import { AdminApiError, fetchUsage, fetchUsers } from "@/lib/admin";
import type { AdminUserRecord, UsageAggregate, UsageUserBucket } from "@/lib/admin";

/**
 * Admin → Usage. Reads aggregated `usage_events` from `/api/admin/usage`
 * (Firestore) and renders a four-card summary plus per-user, per-kind, and
 * per-provider breakdowns. The day window (7 / 30 / 90) lives in the URL
 * (`?days=`) so it survives reloads and links.
 */

const DAY_CHOICES = [7, 30, 90] as const;
type DayChoice = (typeof DAY_CHOICES)[number];

const UsageSearch = z.object({
  days: z
    .union([z.literal(7), z.literal(30), z.literal(90)])
    .optional()
    .catch(30),
  // Deep-link target for the per-user usage detail view. Parsed but not yet
  // used to filter the breakdown (the user-detail page builds this URL today).
  uid: z.string().optional().catch(undefined),
});

export const Route = createFileRoute("/admin/usage")({
  validateSearch: UsageSearch,
  component: AdminUsagePage,
});

function AdminUsagePage() {
  const navigate = useNavigate({ from: "/admin/usage" });
  const search = Route.useSearch();
  const days: DayChoice = (search.days ?? 30) as DayChoice;

  const [aggregate, setAggregate] = useState<UsageAggregate | null>(null);
  const [users, setUsers] = useState<AdminUserRecord[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<AdminApiError | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    Promise.all([fetchUsage(days), fetchUsers()])
      .then(([agg, usersList]) => {
        if (!cancelled) {
          setAggregate(agg);
          setUsers(usersList);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setAggregate(null);
          setError(
            err instanceof AdminApiError ? err : new AdminApiError(0, "Couldn't load usage."),
          );
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [days]);

  const emailByUid = useMemo(() => {
    const map = new Map<string, string | null>();
    for (const u of users ?? []) map.set(u.uid, u.email);
    return map;
  }, [users]);

  const header = (
    <div className="flex flex-wrap items-baseline justify-between gap-3">
      <h1 className="text-3xl font-semibold tracking-tight">Usage</h1>
      <div className="flex items-center gap-2">
        <DayChips current={days} onPick={(d) => navigate({ search: { days: d } })} />
        <button
          type="button"
          onClick={() => {
            if (!aggregate) return;
            downloadUsageCsv(aggregate, emailByUid, days);
          }}
          disabled={!aggregate || aggregate.byUser.length === 0}
          className="rounded-md border border-[var(--line)] bg-white px-3 py-1.5 text-sm font-medium hover:bg-[var(--sand-2)] disabled:opacity-50"
        >
          Export CSV
        </button>
      </div>
    </div>
  );

  if (loading) {
    return (
      <div className="mx-auto max-w-screen-2xl px-5 py-5">
        {header}
        <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <StatSkeleton key={i} />
          ))}
        </div>
        <div className="mt-10 rounded-2xl border border-[var(--line)] bg-white p-3">
          <RowSkeletons rows={5} />
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="mx-auto max-w-screen-2xl px-5 py-5">
        {header}
        <ErrorCard error={error} />
      </div>
    );
  }

  const agg = aggregate;
  if (!agg) {
    return (
      <div className="mx-auto max-w-screen-2xl px-5 py-5">
        {header}
        <p className="mt-6 text-sm text-[var(--ink-soft)]">No data.</p>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-screen-2xl px-5 py-5">
      {header}
      <p className="mt-2 text-sm text-[var(--ink-soft)]">
        Last {agg.days} days · {fmtRange(agg.rangeFrom, agg.rangeTo)}
      </p>

      <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Total events" value={agg.totals.events.toLocaleString()} />
        <StatCard
          label="Total spend"
          value={fmtUsd(agg.totals.millicents)}
          note="Based on current provider list prices."
        />
        <StatCard
          label="Tokens (in / out)"
          value={`${fmtCompact(agg.totals.tokensIn)} / ${fmtCompact(agg.totals.tokensOut)}`}
        />
        <StatCard label="TTS characters" value={agg.totals.characters.toLocaleString()} />
      </div>

      <Section title="By user">
        {agg.byUser.length === 0 ? (
          <EmptyRow message="No usage events in this window. New accounts won't show usage until they make their first AI call." />
        ) : (
          <ByUserTable rows={agg.byUser} emailByUid={emailByUid} />
        )}
      </Section>

      <Section title="By kind">
        {agg.byKind.length === 0 ? (
          <EmptyRow message="No usage in this window." />
        ) : (
          <BarTable
            rows={agg.byKind.map((r) => ({
              label: r.kind,
              events: r.events,
              millicents: r.millicents,
            }))}
            labelHeader="Kind"
          />
        )}
      </Section>

      <Section title="By provider">
        {agg.byProvider.length === 0 ? (
          <EmptyRow message="No usage in this window." />
        ) : (
          <BarTable
            rows={agg.byProvider.map((r) => ({
              label: r.provider,
              events: r.events,
              millicents: r.millicents,
            }))}
            labelHeader="Provider"
          />
        )}
      </Section>
    </div>
  );
}

// --------------------------------------------------------------------------
// Sub-components
// --------------------------------------------------------------------------

function DayChips({ current, onPick }: { current: DayChoice; onPick: (d: DayChoice) => void }) {
  return (
    <div className="inline-flex rounded-full border border-[var(--line)] bg-white p-1 text-sm">
      {DAY_CHOICES.map((d) => {
        const active = d === current;
        return (
          <button
            key={d}
            type="button"
            onClick={() => onPick(d)}
            className={
              active
                ? "rounded-full bg-[var(--teal)] px-3 py-1 font-medium text-white"
                : "rounded-full px-3 py-1 font-medium text-[var(--ink-soft)] hover:text-foreground"
            }
            aria-pressed={active}
          >
            {d} days
          </button>
        );
      })}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mt-10">
      <h2 className="text-xl font-semibold tracking-tight">{title}</h2>
      <div className="mt-3 rounded-2xl border border-[var(--line)] bg-white p-3">{children}</div>
    </section>
  );
}

function ByUserTable({
  rows,
  emailByUid,
}: {
  rows: UsageUserBucket[];
  emailByUid: Map<string, string | null>;
}) {
  return (
    <table className="w-full border-separate border-spacing-0 text-sm">
      <thead>
        <tr>
          <Th>User</Th>
          <Th>Events</Th>
          <Th>Tokens in</Th>
          <Th>Tokens out</Th>
          <Th>Spend</Th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.uid ?? "__anon__"}>
            <Td>
              <UserCell uid={r.uid} emailByUid={emailByUid} />
            </Td>
            <Td>{r.events.toLocaleString()}</Td>
            <Td>{r.tokensIn.toLocaleString()}</Td>
            <Td>{r.tokensOut.toLocaleString()}</Td>
            <Td>{fmtUsd(r.millicents)}</Td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function UserCell({
  uid,
  emailByUid,
}: {
  uid: string | null;
  emailByUid: Map<string, string | null>;
}) {
  if (!uid) {
    return <span className="text-[var(--ink-soft)]">unauthenticated</span>;
  }
  const email = emailByUid.get(uid);
  if (email) {
    return (
      <Link
        to="/admin/users/$userId"
        params={{ userId: uid }}
        className="text-[var(--teal-dark)] hover:underline"
      >
        {email}
      </Link>
    );
  }
  return (
    <Link
      to="/admin/users/$userId"
      params={{ userId: uid }}
      className="font-mono text-xs text-[var(--ink-soft)] hover:underline"
      title={uid}
    >
      {uid.slice(0, 8)}…
    </Link>
  );
}

type BarRow = { label: string; events: number; millicents: number };

function BarTable({ rows, labelHeader }: { rows: BarRow[]; labelHeader: string }) {
  const max = rows.reduce((acc, r) => Math.max(acc, r.millicents), 0);
  return (
    <table className="w-full border-separate border-spacing-0 text-sm">
      <thead>
        <tr>
          <Th>{labelHeader}</Th>
          <Th>Events</Th>
          <Th>Spend</Th>
          <Th>Share</Th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => {
          const pct = max > 0 ? Math.round((r.millicents / max) * 100) : 0;
          return (
            <tr key={r.label}>
              <Td>{r.label}</Td>
              <Td>{r.events.toLocaleString()}</Td>
              <Td>{fmtUsd(r.millicents)}</Td>
              <Td>
                <div className="flex items-center gap-2">
                  <div className="h-2 w-32 overflow-hidden rounded-full bg-[var(--sand-2)]">
                    <div className="h-full bg-[var(--teal)]" style={{ width: `${pct}%` }} />
                  </div>
                  <span className="text-xs text-[var(--ink-soft)]">{pct}%</span>
                </div>
              </Td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function ErrorCard({ error }: { error: AdminApiError }) {
  const is503 = error.status === 503;
  return (
    <div className="mt-6 rounded-2xl border border-[var(--line)] bg-white p-6">
      <h2 className="text-base font-semibold">
        {is503 ? "Admin features aren't configured yet" : "Couldn't load usage"}
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

function EmptyRow({ message }: { message: string }) {
  return <p className="px-3 py-6 text-center text-sm text-[var(--ink-soft)]">{message}</p>;
}

function StatSkeleton() {
  return <div className="h-24 rounded-2xl bg-[var(--sand-2)]/60 animate-pulse" />;
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

// --------------------------------------------------------------------------
// Formatters
// --------------------------------------------------------------------------

function fmtUsd(millicents: number): string {
  // millicents → dollars: 100_000 millicents = $1.00
  const dollars = millicents / 100_000;
  return dollars.toLocaleString(undefined, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function fmtCompact(n: number): string {
  if (n < 1000) return n.toLocaleString();
  if (n < 1_000_000) return `${(n / 1_000).toFixed(1)}k`;
  if (n < 1_000_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  return `${(n / 1_000_000_000).toFixed(2)}B`;
}

function fmtRange(fromIso: string, toIso: string): string {
  const from = new Date(fromIso);
  const to = new Date(toIso);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) return "";
  const opts: Intl.DateTimeFormatOptions = {
    year: "numeric",
    month: "short",
    day: "numeric",
  };
  return `${from.toLocaleDateString(undefined, opts)} → ${to.toLocaleDateString(undefined, opts)}`;
}

// --------------------------------------------------------------------------
// CSV export — quick, no-dependency builder for the byUser breakdown.
// --------------------------------------------------------------------------

function escapeCsv(value: string): string {
  // Double-quote fields that contain a quote, comma, or newline; double-up
  // embedded quotes per RFC 4180.
  if (/[",\n\r]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

function downloadUsageCsv(
  agg: UsageAggregate,
  emailByUid: Map<string, string | null>,
  days: number,
): void {
  const header = [
    "uid",
    "email",
    "events",
    "tokensIn",
    "tokensOut",
    "characters",
    "audioBytes",
    "spend_usd",
  ];
  const lines = [header.join(",")];
  for (const r of agg.byUser) {
    const uid = r.uid ?? "__anon__";
    const email = (r.uid ? emailByUid.get(r.uid) : null) ?? "";
    const spend = (r.millicents / 100_000).toFixed(2);
    lines.push(
      [
        escapeCsv(uid),
        escapeCsv(email),
        String(r.events),
        String(r.tokensIn),
        String(r.tokensOut),
        String(r.characters),
        String(r.audioBytes),
        spend,
      ].join(","),
    );
  }
  const csv = lines.join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `parley-usage-${days}d.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // Give the browser a moment to start the download before revoking.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
