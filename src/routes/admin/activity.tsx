import { useEffect, useState } from "react";
import { Link, createFileRoute } from "@tanstack/react-router";
import { z } from "zod";

import { AdminApiError, fetchActivity, relativeTime } from "@/lib/admin";
import type { AdminAction, AuditEntry } from "@/lib/admin";
import { cn } from "@/lib/cn";

/**
 * Admin → Activity. The audit trail. Every mutating admin action is logged
 * server-side via `logAdminAction` and surfaced here, newest first. Polls
 * every 30s so a fresh action shows up without a hard reload.
 *
 * The route honours `?targetUid=<uid>` so the user-detail page can deep-link
 * into the filtered feed for one account.
 */

const ActivitySearch = z.object({
  targetUid: z.string().optional().catch(undefined),
});

export const Route = createFileRoute("/admin/activity")({
  validateSearch: ActivitySearch,
  component: AdminActivityPage,
});

const POLL_MS = 30_000;

function AdminActivityPage() {
  const search = Route.useSearch();
  const targetUid = search.targetUid;

  const [entries, setEntries] = useState<AuditEntry[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<AdminApiError | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setEntries(null);

    function load(force: boolean) {
      fetchActivity({ targetUid, limit: 200, force })
        .then((data) => {
          if (!cancelled) {
            setEntries(data);
            setError(null);
          }
        })
        .catch((err) => {
          if (!cancelled) {
            setError(
              err instanceof AdminApiError
                ? err
                : new AdminApiError(0, "Couldn't load the activity log."),
            );
          }
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    }

    load(false);
    const id = window.setInterval(() => load(true), POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [targetUid]);

  const header = (
    <div className="flex flex-wrap items-baseline justify-between gap-3">
      <div>
        <h1 className="text-3xl font-semibold tracking-tight">Activity log</h1>
        <p className="mt-2 text-sm text-[var(--ink-soft)]">
          Every admin action, in order.
          {targetUid ? (
            <>
              {" "}
              Filtered to <span className="font-mono text-xs">{targetUid}</span> —{" "}
              <Link
                to="/admin/activity"
                className="font-medium text-[var(--teal-dark)] hover:underline"
              >
                clear filter
              </Link>
              .
            </>
          ) : null}
        </p>
      </div>
    </div>
  );

  if (loading && entries === null) {
    return (
      <div className="mx-auto max-w-screen-2xl px-5 py-5">
        {header}
        <div className="mt-6 rounded-2xl border border-[var(--line)] bg-white p-3">
          <RowSkeletons rows={8} />
        </div>
      </div>
    );
  }

  if (error && entries === null) {
    return (
      <div className="mx-auto max-w-screen-2xl px-5 py-5">
        {header}
        <ErrorCard error={error} />
      </div>
    );
  }

  const list = entries ?? [];

  return (
    <div className="mx-auto max-w-screen-2xl px-5 py-5">
      {header}

      {error ? (
        <div className="mt-4 rounded-2xl border border-[var(--coral)]/40 bg-[var(--coral)]/10 p-4 text-sm text-[var(--ink)]">
          Refresh failed: {error.message}
        </div>
      ) : null}

      <div className="mt-6 rounded-2xl border border-[var(--line)] bg-white p-3">
        {list.length === 0 ? (
          <EmptyState />
        ) : (
          <ActivityTable entries={list} />
        )}
      </div>
    </div>
  );
}

// --------------------------------------------------------------------------
// Sub-components
// --------------------------------------------------------------------------

function ActivityTable({ entries }: { entries: AuditEntry[] }) {
  return (
    <table className="w-full border-separate border-spacing-0 text-sm">
      <thead>
        <tr>
          <Th>When</Th>
          <Th>Actor</Th>
          <Th>Action</Th>
          <Th>Target</Th>
          <Th>Status</Th>
          <Th>Detail</Th>
        </tr>
      </thead>
      <tbody>
        {entries.map((e) => (
          <tr key={e.id}>
            <Td>
              <span title={fmtAbsolute(e.createdAt)} className="cursor-help">
                {relativeTime(e.createdAt)}
              </span>
            </Td>
            <Td>
              {e.actorEmail ?? (
                <span className="font-mono text-xs text-[var(--ink-soft)]">
                  {e.actorUid.slice(0, 8) || "—"}
                  {e.actorUid ? "…" : ""}
                </span>
              )}
            </Td>
            <Td>
              <ActionBadge action={e.action} />
            </Td>
            <Td>
              <TargetCell entry={e} />
            </Td>
            <Td>
              <StatusCell entry={e} />
            </Td>
            <Td className="max-w-[20rem]">
              <DetailCell entry={e} />
            </Td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

type ActionCategory = "destructive" | "promote" | "neutral";

const ACTION_CATEGORY: Record<AdminAction, ActionCategory> = {
  "user.revoke-admin": "destructive",
  "user.disable": "destructive",
  "user.delete": "destructive",
  "waitlist.delete": "destructive",
  "role.promote-admin": "promote",
  "waitlist.onboarded": "promote",
  "user.enable": "neutral",
  "waitlist.archive": "neutral",
};

function ActionBadge({ action }: { action: AdminAction }) {
  const category = ACTION_CATEGORY[action] ?? "neutral";
  const cls =
    category === "destructive"
      ? "bg-[var(--coral)]/10 text-[var(--coral)]"
      : category === "promote"
        ? "bg-[var(--teal)]/10 text-[var(--teal-dark)]"
        : "bg-[var(--sand-2)] text-[var(--ink-soft)]";
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide",
        cls,
      )}
    >
      {action}
    </span>
  );
}

function TargetCell({ entry }: { entry: AuditEntry }) {
  if (entry.targetUid) {
    const label = entry.targetEmail ?? `${entry.targetUid.slice(0, 8)}…`;
    return (
      <Link
        to="/admin/users/$userId"
        params={{ userId: entry.targetUid }}
        className="text-[var(--teal-dark)] hover:underline"
        title={entry.targetUid}
      >
        {label}
      </Link>
    );
  }
  if (entry.targetEmail) {
    return <span>{entry.targetEmail}</span>;
  }
  return <span className="text-[var(--ink-soft)]">—</span>;
}

function StatusCell({ entry }: { entry: AuditEntry }) {
  if (entry.status === "ok") {
    return (
      <span className="inline-flex items-center rounded-full bg-[var(--teal)]/10 px-2 py-0.5 text-xs font-medium text-[var(--teal-dark)]">
        ok
      </span>
    );
  }
  if (entry.status === "partial") {
    return (
      <span
        className="inline-flex items-center rounded-full bg-[var(--sun)]/30 px-2 py-0.5 text-xs font-medium text-[var(--ink)]"
        title="The action partially succeeded — see server logs."
      >
        partial
      </span>
    );
  }
  // error
  return (
    <div className="flex flex-col gap-1">
      <span className="inline-flex w-fit items-center rounded-full bg-[var(--coral)]/10 px-2 py-0.5 text-xs font-medium text-[var(--coral)]">
        error
      </span>
      {entry.errorMessage ? (
        <span
          className="line-clamp-2 max-w-[18rem] text-xs text-[var(--ink-soft)]"
          title={entry.errorMessage}
        >
          {entry.errorMessage}
        </span>
      ) : null}
    </div>
  );
}

function DetailCell({ entry }: { entry: AuditEntry }) {
  const detail = entry.detail;
  if (!detail || Object.keys(detail).length === 0) {
    return <span className="text-[var(--ink-soft)]">—</span>;
  }
  const pieces = Object.entries(detail).map(([k, v]) => `${k}: ${fmtDetailValue(v)}`);
  const text = pieces.join(" · ");
  return (
    <span
      className="line-clamp-2 break-words text-xs text-[var(--ink-soft)]"
      title={text}
    >
      {text}
    </span>
  );
}

function fmtDetailValue(v: unknown): string {
  if (v == null) return "—";
  if (typeof v === "string") return v;
  if (typeof v === "boolean" || typeof v === "number") return String(v);
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

function EmptyState() {
  return (
    <div className="py-12 text-center">
      <p className="text-sm font-medium">No admin actions logged yet.</p>
      <p className="mt-2 text-sm text-[var(--ink-soft)]">
        They'll appear here once you take an action in /admin/users or /admin/waitlist.
      </p>
    </div>
  );
}

function ErrorCard({ error }: { error: AdminApiError }) {
  const is503 = error.status === 503;
  return (
    <div className="mt-6 rounded-2xl border border-[var(--line)] bg-white p-6">
      <h2 className="text-base font-semibold">
        {is503 ? "Admin features aren't configured yet" : "Couldn't load the activity log"}
      </h2>
      <p className="mt-2 text-sm text-[var(--ink-soft)]">{error.message}</p>
    </div>
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

function Th({ children }: { children: React.ReactNode }) {
  return (
    <th className="bg-muted/40 text-left font-medium px-3 py-2 border-b border-[var(--line)]">
      {children}
    </th>
  );
}

function Td({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <td className={`px-3 py-2 border-b border-[var(--line)] align-top ${className ?? ""}`}>
      {children}
    </td>
  );
}

function fmtAbsolute(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}
