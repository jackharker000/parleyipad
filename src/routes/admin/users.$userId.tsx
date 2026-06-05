import { useEffect, useMemo, useRef, useState } from "react";
import { Link, createFileRoute } from "@tanstack/react-router";
import { toast } from "sonner";

import { ConfirmDialog } from "@/components/ConfirmDialog";
import { Button } from "@/components/ui/button";
import {
  AdminApiError,
  fetchActivity,
  fetchUsage,
  fetchUser,
  fetchUserData,
  fetchUserDataCounts,
  performUserAction,
  playAudioFromAdminUrl,
  relativeTime,
  stopAdminAudio,
} from "@/lib/admin";
import type {
  AdminAction,
  AdminUserAction,
  AdminUserRecord,
  AuditEntry,
  UsageUserBucket,
} from "@/lib/admin";
import { cn } from "@/lib/cn";

export const Route = createFileRoute("/admin/users/$userId")({
  component: AdminUserDetailPage,
});

function AdminUserDetailPage() {
  const { userId } = Route.useParams();
  const [user, setUser] = useState<AdminUserRecord | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<AdminApiError | null>(null);

  // Bumped after destructive Danger-zone actions complete to force a fresh
  // /api/admin/user fetch and re-render the card with the new state.
  const [refreshKey, setRefreshKey] = useState(0);
  const refreshUser = () => setRefreshKey((k) => k + 1);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetchUser(userId, refreshKey > 0 ? { force: true } : undefined)
      .then((data) => {
        if (!cancelled) {
          setUser(data);
          setError(null);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setError(
            err instanceof AdminApiError
              ? err
              : new AdminApiError(0, "Couldn't load this user."),
          );
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [userId, refreshKey]);

  // Stop any in-flight audio playback when navigating away from this page.
  useEffect(() => {
    return () => {
      stopAdminAudio();
    };
  }, []);

  return (
    <div className="mx-auto max-w-screen-2xl px-5 py-5">
      <Link
        to="/admin/users"
        className="text-sm font-medium text-[var(--teal-dark)] hover:underline"
      >
        ← Back to users
      </Link>

      {loading ? (
        <div className="mt-6 grid grid-cols-1 gap-4 lg:grid-cols-2">
          <div className="h-48 rounded-2xl bg-[var(--sand-2)]/60 animate-pulse" />
          <div className="h-48 rounded-2xl bg-[var(--sand-2)]/60 animate-pulse" />
        </div>
      ) : error ? (
        <ErrorCard error={error} />
      ) : user === null ? (
        <>
          <h1 className="mt-2 text-3xl font-semibold tracking-tight">User</h1>
          <p className="mt-6 text-sm text-[var(--ink-soft)]">User not found.</p>
        </>
      ) : (
        <>
          <h1 className="mt-2 text-3xl font-semibold tracking-tight">
            {user.email ?? user.uid}
          </h1>
          <div className="mt-6 grid grid-cols-1 gap-4 lg:grid-cols-2">
            <InfoCard user={user} />
            <UsageCard uid={user.uid} />
          </div>
          <SyncedDataSection uid={user.uid} />
          <ActionHistorySection uid={user.uid} refreshKey={refreshKey} />
          <DangerZone user={user} onChanged={refreshUser} />
        </>
      )}
    </div>
  );
}

function ErrorCard({ error }: { error: AdminApiError }) {
  const is503 = error.status === 503;
  return (
    <div className="mt-6 rounded-2xl border border-[var(--line)] bg-white p-6">
      <h2 className="text-base font-semibold">
        {is503 ? "Admin features aren't configured yet" : "Couldn't load this user"}
      </h2>
      <p className="mt-2 text-sm text-[var(--ink-soft)]">{error.message}</p>
    </div>
  );
}

function UsageCard({ uid }: { uid: string }) {
  type State =
    | { kind: "loading" }
    | { kind: "error"; error: AdminApiError }
    | { kind: "none" }
    | { kind: "ready"; bucket: UsageUserBucket };
  const [state, setState] = useState<State>({ kind: "loading" });

  useEffect(() => {
    let cancelled = false;
    setState({ kind: "loading" });
    fetchUsage(30)
      .then((agg) => {
        if (cancelled) return;
        const found = agg.byUser.find((b) => b.uid === uid);
        setState(found ? { kind: "ready", bucket: found } : { kind: "none" });
      })
      .catch((err) => {
        if (cancelled) return;
        const error =
          err instanceof AdminApiError
            ? err
            : new AdminApiError(0, "Couldn't load usage.");
        setState({ kind: "error", error });
      });
    return () => {
      cancelled = true;
    };
  }, [uid]);

  return (
    <div className="rounded-2xl border border-[var(--line)] bg-white p-6">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-base font-semibold">Usage (30d)</h2>
        <Link
          to="/admin/usage"
          search={{ days: 30, uid }}
          className="text-xs font-medium text-[var(--teal-dark)] hover:underline"
        >
          See 30-day usage details →
        </Link>
      </div>
      {state.kind === "loading" ? (
        <div className="mt-4 h-24 rounded-md bg-[var(--sand-2)]/60 animate-pulse" />
      ) : state.kind === "error" ? (
        <p className="mt-4 text-sm text-[var(--coral)]">{state.error.message}</p>
      ) : state.kind === "none" ? (
        <p className="mt-4 text-sm text-[var(--ink-soft)]">
          No usage events for this user in the last 30 days. New accounts won't show usage
          until they make their first AI call.
        </p>
      ) : (
        <dl className="mt-4 grid grid-cols-[140px_1fr] gap-y-2 text-sm">
          <Dt>30d events</Dt>
          <Dd>{state.bucket.events.toLocaleString()}</Dd>

          <Dt>30d spend</Dt>
          <Dd>{fmtUsd(state.bucket.millicents)}</Dd>

          <Dt>Tokens (in / out)</Dt>
          <Dd>
            {state.bucket.tokensIn.toLocaleString()} / {state.bucket.tokensOut.toLocaleString()}
          </Dd>

          <Dt>TTS characters</Dt>
          <Dd>{state.bucket.characters.toLocaleString()}</Dd>

          <Dt>Audio</Dt>
          <Dd>{state.bucket.audioBytes > 0 ? fmtBytes(state.bucket.audioBytes) : "—"}</Dd>
        </dl>
      )}
    </div>
  );
}

function fmtUsd(millicents: number): string {
  return (millicents / 100_000).toLocaleString(undefined, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function InfoCard({ user }: { user: AdminUserRecord }) {
  return (
    <div className="rounded-2xl border border-[var(--line)] bg-white p-6">
      <h2 className="text-base font-semibold">Account</h2>
      <dl className="mt-4 grid grid-cols-[140px_1fr] gap-y-2 text-sm">
        <Dt>UID</Dt>
        <Dd className="font-mono text-xs">{user.uid}</Dd>

        <Dt>Email</Dt>
        <Dd>{user.email ?? "—"}</Dd>

        <Dt>Display name</Dt>
        <Dd>{user.displayName ?? "—"}</Dd>

        <Dt>Provider</Dt>
        <Dd>{user.provider ?? "—"}</Dd>

        <Dt>Created</Dt>
        <Dd>{fmtDateTime(user.createdAt)}</Dd>

        <Dt>Last sign in</Dt>
        <Dd>{fmtDateTime(user.lastSignInAt)}</Dd>

        <Dt>Admin</Dt>
        <Dd>
          {user.is_admin ? (
            <span className="inline-flex items-center rounded-full bg-[var(--teal)]/10 px-2 py-0.5 text-xs font-medium text-[var(--teal-dark)]">
              admin
            </span>
          ) : (
            <span className="text-[var(--ink-soft)]">no</span>
          )}
        </Dd>

        <Dt>Disabled</Dt>
        <Dd>{user.disabled ? "Yes" : "No"}</Dd>

        <Dt>Last synced</Dt>
        <Dd>
          <SyncHealthRow uid={user.uid} />
        </Dd>
      </dl>
    </div>
  );
}

// --------------------------------------------------------------------------
// Sync health — peeks at the most-recent row across a few key synced tables
// and shows the max updatedAt. Cheap "is this user's cloud sync alive?" tell.
// --------------------------------------------------------------------------

const SYNC_HEALTH_TABLES = [
  "conversations",
  "transcriptSegments",
  "jamesProfile",
  "settings",
] as const;

function SyncHealthRow({ uid }: { uid: string }) {
  type State =
    | { kind: "loading" }
    | { kind: "ready"; latestIso: string | null }
    | { kind: "error" };
  const [state, setState] = useState<State>({ kind: "loading" });

  useEffect(() => {
    let cancelled = false;
    setState({ kind: "loading" });
    // Fetch the most-recent row from each table in parallel; the first row of
    // an ordered-by-createdAt-desc listing is the latest. settled-style
    // handling so a 404/empty table doesn't tank the whole row.
    Promise.allSettled(
      SYNC_HEALTH_TABLES.map((t) => fetchUserData(uid, t, 1)),
    )
      .then((results) => {
        if (cancelled) return;
        let latest: number | null = null;
        for (const r of results) {
          if (r.status !== "fulfilled") continue;
          const row = r.value[0];
          if (!row) continue;
          const candidates = [row.updatedAt, row.endedAt, row.startedAt, row.createdAt];
          for (const c of candidates) {
            if (typeof c !== "string") continue;
            const t = new Date(c).getTime();
            if (Number.isFinite(t) && (latest === null || t > latest)) {
              latest = t;
            }
          }
        }
        setState({
          kind: "ready",
          latestIso: latest !== null ? new Date(latest).toISOString() : null,
        });
      })
      .catch(() => {
        if (!cancelled) setState({ kind: "error" });
      });
    return () => {
      cancelled = true;
    };
  }, [uid]);

  if (state.kind === "loading") {
    return (
      <span className="inline-block h-4 w-32 rounded bg-[var(--sand-2)]/60 animate-pulse" />
    );
  }
  if (state.kind === "error") {
    return <span className="text-[var(--ink-soft)]">—</span>;
  }
  if (state.latestIso === null) {
    return (
      <span className="text-[var(--ink-soft)]">No synced data yet.</span>
    );
  }
  return (
    <span title={fmtDateTime(state.latestIso)}>
      {relativeTime(state.latestIso)}
    </span>
  );
}

// --------------------------------------------------------------------------
// Synced data viewer — four most-useful tables, picked by a small chip group.
// --------------------------------------------------------------------------

type SyncedTab = {
  key: string;
  label: string;
  table: string;
  limit?: number;
};

const SYNCED_TABS: SyncedTab[] = [
  { key: "conversations", label: "Conversations", table: "conversations" },
  {
    key: "transcriptSegments",
    label: "Transcript segments",
    table: "transcriptSegments",
    limit: 100,
  },
  { key: "voiceprints", label: "Voiceprints", table: "voiceprints" },
  {
    key: "voiceprintContributions",
    label: "Voiceprint contributions",
    table: "voiceprintContributions",
  },
  { key: "people", label: "People", table: "people" },
  { key: "places", label: "Places", table: "places" },
  { key: "events", label: "Events", table: "events" },
  { key: "memories", label: "Memories", table: "memories" },
  { key: "suggestionsLog", label: "Suggestions log", table: "suggestionsLog" },
  { key: "syncErrors", label: "Sync errors", table: "syncErrors" },
];

function SyncedDataSection({ uid }: { uid: string }) {
  const [activeKey, setActiveKey] = useState<string>(SYNCED_TABS[0].key);
  const active = SYNCED_TABS.find((t) => t.key === activeKey) ?? SYNCED_TABS[0];

  // Per-table document counts for the chip badges. Loaded once per user;
  // the 30s cache in fetchUserDataCounts handles bounce-around navigation.
  const [counts, setCounts] = useState<Record<string, number> | null>(null);
  useEffect(() => {
    let cancelled = false;
    setCounts(null);
    fetchUserDataCounts(uid)
      .then((c) => {
        if (!cancelled) setCounts(c);
      })
      .catch(() => {
        // best-effort — the chips render without a badge if the count fails.
        if (!cancelled) setCounts({});
      });
    return () => {
      cancelled = true;
    };
  }, [uid]);

  // People rows are looked up by personId in several tabs (contributions,
  // memories, suggestions), so fetch them once on first use.
  const [people, setPeople] = useState<Array<Record<string, unknown>> | null>(null);
  useEffect(() => {
    const needsPeople =
      activeKey === "voiceprintContributions" ||
      activeKey === "memories" ||
      activeKey === "suggestionsLog" ||
      activeKey === "voiceprints" ||
      activeKey === "events";
    if (!needsPeople) return;
    if (people !== null) return;
    let cancelled = false;
    fetchUserData(uid, "people", 500)
      .then((rows) => {
        if (!cancelled) setPeople(rows);
      })
      .catch(() => {
        // best-effort; the section still renders without person names
        if (!cancelled) setPeople([]);
      });
    return () => {
      cancelled = true;
    };
  }, [activeKey, uid, people]);

  const peopleById = useMemo(() => {
    const map = new Map<string, string>();
    for (const p of people ?? []) {
      const id = typeof p.id === "string" ? p.id : null;
      const name = typeof p.name === "string" ? p.name : null;
      if (id && name) map.set(id, name);
    }
    return map;
  }, [people]);

  return (
    <section className="mt-10">
      <h2 className="text-xl font-semibold tracking-tight">Synced data</h2>
      <p className="mt-1 text-sm text-[var(--ink-soft)]">
        A peek at what this user has uploaded to Firestore + Storage.
      </p>

      <div className="mt-4 inline-flex flex-wrap gap-2 rounded-full border border-[var(--line)] bg-white p-1 text-sm">
        {SYNCED_TABS.map((t) => {
          const isActive = t.key === activeKey;
          const n = counts?.[t.table];
          // The sync-errors chip gets a coral dot whenever there's any
          // logged error, because telling unrecovered-vs-recovered apart
          // from up here would require a second query. The chip view
          // itself (SyncErrorsTable) shows the per-row status.
          const isSyncErrors = t.key === "syncErrors";
          const showWarn = isSyncErrors && typeof n === "number" && n > 0;
          return (
            <button
              key={t.key}
              type="button"
              onClick={() => setActiveKey(t.key)}
              aria-pressed={isActive}
              className={
                isActive
                  ? "inline-flex items-center gap-1.5 rounded-full bg-[var(--teal)] px-3 py-1 font-medium text-white"
                  : "inline-flex items-center gap-1.5 rounded-full px-3 py-1 font-medium text-[var(--ink-soft)] hover:text-foreground"
              }
            >
              {showWarn ? (
                <span
                  aria-hidden="true"
                  title="This user has sync errors logged"
                  className={cn(
                    "inline-block h-1.5 w-1.5 rounded-full",
                    isActive ? "bg-white" : "bg-[var(--coral)]",
                  )}
                />
              ) : null}
              <span>{t.label}</span>
              {typeof n === "number" ? (
                <span
                  className={
                    isActive
                      ? "rounded-full bg-white/20 px-1.5 py-0.5 text-[10px] font-semibold tabular-nums"
                      : "rounded-full bg-[var(--sand-2)] px-1.5 py-0.5 text-[10px] font-semibold tabular-nums text-[var(--ink-soft)]"
                  }
                >
                  {n.toLocaleString()}
                </span>
              ) : null}
            </button>
          );
        })}
      </div>

      <div className="mt-4 rounded-2xl border border-[var(--line)] bg-white p-3">
        <SyncedTableView
          uid={uid}
          table={active.table}
          limit={active.limit}
          tableKey={active.key}
          peopleById={peopleById}
        />
      </div>
    </section>
  );
}

function SyncedTableView({
  uid,
  table,
  limit,
  tableKey,
  peopleById,
}: {
  uid: string;
  table: string;
  limit?: number;
  tableKey: string;
  peopleById: Map<string, string>;
}) {
  const [rows, setRows] = useState<Array<Record<string, unknown>> | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<AdminApiError | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setRows(null);
    fetchUserData(uid, table, limit)
      .then((data) => {
        if (!cancelled) setRows(data);
      })
      .catch((err) => {
        if (!cancelled) {
          setError(
            err instanceof AdminApiError
              ? err
              : new AdminApiError(0, "Couldn't load synced data."),
          );
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [uid, table, limit]);

  if (loading) {
    return (
      <div className="flex flex-col gap-2 p-2">
        {Array.from({ length: 5 }).map((_, i) => (
          <div
            key={i}
            className="h-12 bg-[var(--sand-2)]/60 rounded-md animate-pulse"
          />
        ))}
      </div>
    );
  }
  if (error) {
    return (
      <p className="px-3 py-6 text-center text-sm text-[var(--coral)]">
        {error.message}
      </p>
    );
  }
  if (!rows || rows.length === 0) {
    if (tableKey === "syncErrors") {
      return (
        <p className="px-3 py-6 text-center text-sm text-[var(--ink-soft)]">
          No sync errors recorded yet. The engine retries quietly and only logs
          an error after it&apos;s stuck for several attempts.
        </p>
      );
    }
    return (
      <p className="px-3 py-6 text-center text-sm text-[var(--ink-soft)]">
        Nothing in this table yet. New accounts have empty data until they start using
        Parley, or until cloud sync has run once.
      </p>
    );
  }

  if (tableKey === "voiceprintContributions") {
    return <ContributionsTable rows={rows} peopleById={peopleById} />;
  }
  if (tableKey === "conversations") {
    return <ConversationsTable rows={rows} uid={uid} />;
  }
  if (tableKey === "voiceprints") {
    return <VoiceprintsTable rows={rows} peopleById={peopleById} />;
  }
  if (tableKey === "transcriptSegments") {
    return <SegmentsTable rows={rows} />;
  }
  if (tableKey === "people") {
    return <PeopleTable rows={rows} />;
  }
  if (tableKey === "places") {
    return <PlacesTable rows={rows} />;
  }
  if (tableKey === "events") {
    return <EventsTable rows={rows} />;
  }
  if (tableKey === "memories") {
    return <MemoriesTable rows={rows} peopleById={peopleById} />;
  }
  if (tableKey === "suggestionsLog") {
    return <SuggestionsLogTable rows={rows} peopleById={peopleById} />;
  }
  if (tableKey === "syncErrors") {
    return <SyncErrorsTable rows={rows} />;
  }

  return <GenericTable rows={rows} />;
}

// --------------------------------------------------------------------------
// Per-table renderers — keep them compact and forgiving (Firestore is loose).
// --------------------------------------------------------------------------

function ConversationsTable({
  rows,
  uid,
}: {
  rows: Array<Record<string, unknown>>;
  uid: string;
}) {
  return (
    <table className="w-full border-separate border-spacing-0 text-sm">
      <thead>
        <tr>
          <Th>Started</Th>
          <Th>Title</Th>
          <Th>Place</Th>
          <Th>ID</Th>
          <Th>{""}</Th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r, i) => (
          <ConversationRow key={readString(r.id) ?? `row-${i}`} row={r} uid={uid} />
        ))}
      </tbody>
    </table>
  );
}

function ConversationRow({ row, uid }: { row: Record<string, unknown>; uid: string }) {
  const id = readString(row.id);
  const summary = readString(row.summary);
  return (
    <>
      <tr className="hover:bg-[var(--sand-2)]/40">
        <Td>{fmtMaybeDate(row.createdAt ?? row.startedAt)}</Td>
        <Td>{readString(row.title) ?? <Muted>—</Muted>}</Td>
        <Td>{readString(row.placeId) ?? <Muted>—</Muted>}</Td>
        <Td className="font-mono text-xs text-[var(--ink-soft)]">
          {id ?? <Muted>—</Muted>}
        </Td>
        <Td>
          {id ? (
            <Link
              to="/admin/users/$userId/conversations/$conversationId"
              params={{ userId: uid, conversationId: id }}
              className="text-xs font-medium text-[var(--teal-dark)] hover:underline"
            >
              View →
            </Link>
          ) : (
            <Muted>—</Muted>
          )}
        </Td>
      </tr>
      {summary ? (
        <tr>
          <td
            colSpan={5}
            className="border-b border-[var(--line)] bg-[var(--sand)]/30 px-3 py-1.5 text-xs italic text-[var(--ink-soft)]"
          >
            <span className="line-clamp-1">{summary}</span>
          </td>
        </tr>
      ) : null}
    </>
  );
}

function SegmentsTable({ rows }: { rows: Array<Record<string, unknown>> }) {
  return (
    <table className="w-full border-separate border-spacing-0 text-sm">
      <thead>
        <tr>
          <Th>Time</Th>
          <Th>Speaker</Th>
          <Th>Text</Th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r, i) => (
          <tr key={readString(r.id) ?? i}>
            <Td>{fmtMaybeDate(r.createdAt ?? r.startedAt)}</Td>
            <Td>{readString(r.speakerLabel) ?? readString(r.personId) ?? <Muted>—</Muted>}</Td>
            <Td className="max-w-[28rem]">
              <div className="line-clamp-3">
                {readString(r.text) ?? <Muted>—</Muted>}
              </div>
            </Td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function VoiceprintsTable({
  rows,
  peopleById,
}: {
  rows: Array<Record<string, unknown>>;
  peopleById: Map<string, string>;
}) {
  return (
    <table className="w-full border-separate border-spacing-0 text-sm">
      <thead>
        <tr>
          <Th>Updated</Th>
          <Th>Person</Th>
          <Th>Contributions</Th>
          <Th>ID</Th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r, i) => {
          const personId = readString(r.personId);
          const personName = personId ? peopleById.get(personId) ?? null : null;
          return (
            <tr key={readString(r.id) ?? i}>
              <Td>{fmtMaybeDate(r.updatedAt ?? r.createdAt)}</Td>
              <Td>{personName ?? personId ?? <Muted>—</Muted>}</Td>
              <Td>{readNumber(r.numContributions ?? r.contributionCount) ?? <Muted>—</Muted>}</Td>
              <Td className="font-mono text-xs text-[var(--ink-soft)]">
                {readString(r.id) ?? <Muted>—</Muted>}
              </Td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function ContributionsTable({
  rows,
  peopleById,
}: {
  rows: Array<Record<string, unknown>>;
  peopleById: Map<string, string>;
}) {
  return (
    <ul className="flex flex-col divide-y divide-[var(--line)]">
      {rows.map((r, i) => {
        const personId = readString(r.personId);
        const personName = personId ? peopleById.get(personId) ?? null : null;
        const audio = readAudioRef(r);
        const source = readString(r.source);
        const duration = readNumber(r.durationSec);
        const previewText = readString(r.previewText);
        const createdAt = readString(r.createdAt);
        return (
          <li key={readString(r.id) ?? i} className="px-2 py-3">
            <div className="flex flex-wrap items-baseline gap-2">
              <span className="font-medium text-[var(--ink)]">
                {personName ?? personId ?? "Unknown person"}
              </span>
              {source ? <SourceBadge source={source} /> : null}
            </div>
            <div className="mt-0.5 text-xs text-[var(--ink-soft)]">
              {duration != null ? `${duration.toFixed(1)}s · ` : null}
              {audio ? `${fmtBytes(audio.sizeBytes)}` : "no audio"}
              {createdAt ? ` · ${relativeTime(createdAt)}` : null}
            </div>
            {previewText ? (
              <p className="mt-1.5 max-w-3xl truncate text-sm italic text-[var(--ink-soft)]">
                “{previewText}”
              </p>
            ) : null}
            <div className="mt-2">
              {audio?.storagePath ? (
                <ListenButton storagePath={audio.storagePath} durationSec={duration} />
              ) : (
                <Muted>No audio</Muted>
              )}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

/** Color-coded source badge — keeps enrolment vs conversation vs rediarize visually distinct. */
function SourceBadge({ source }: { source: string }) {
  const palette: Record<string, string> = {
    enrollment: "bg-[#3b82f6]/10 text-[#1d4ed8]",
    conversation: "bg-[var(--sand-2)] text-[var(--ink-soft)]",
    rediarize: "bg-[var(--teal)]/10 text-[var(--teal-dark)]",
  };
  const cls = palette[source] ?? "bg-[var(--sand-2)] text-[var(--ink-soft)]";
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${cls}`}
    >
      {source}
    </span>
  );
}

function PeopleTable({ rows }: { rows: Array<Record<string, unknown>> }) {
  return (
    <table className="w-full border-separate border-spacing-0 text-sm">
      <thead>
        <tr>
          <Th>Name</Th>
          <Th>Relationship</Th>
          <Th>Status</Th>
          <Th>Interests</Th>
          <Th>Created</Th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r, i) => {
          const interests = Array.isArray(r.interests) ? r.interests.length : null;
          return (
            <tr key={readString(r.id) ?? i}>
              <Td>{readString(r.name) ?? <Muted>—</Muted>}</Td>
              <Td>{readString(r.relationship) ?? <Muted>—</Muted>}</Td>
              <Td>{readString(r.status) ?? <Muted>—</Muted>}</Td>
              <Td>
                {interests != null ? (
                  `${interests} interest${interests === 1 ? "" : "s"}`
                ) : (
                  <Muted>—</Muted>
                )}
              </Td>
              <Td>{fmtMaybeDate(r.createdAt)}</Td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function PlacesTable({ rows }: { rows: Array<Record<string, unknown>> }) {
  return (
    <table className="w-full border-separate border-spacing-0 text-sm">
      <thead>
        <tr>
          <Th>Name</Th>
          <Th>Coordinates</Th>
          <Th>People</Th>
          <Th>Notes</Th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r, i) => {
          const lat = readNumber(r.lat);
          const lng = readNumber(r.lng);
          const people = Array.isArray(r.personIds)
            ? r.personIds.length
            : Array.isArray(r.peopleIds)
              ? r.peopleIds.length
              : null;
          return (
            <tr key={readString(r.id) ?? i}>
              <Td>{readString(r.name) ?? <Muted>—</Muted>}</Td>
              <Td>
                {lat != null && lng != null ? (
                  <span className="font-mono text-xs">
                    {lat.toFixed(4)}, {lng.toFixed(4)}
                  </span>
                ) : (
                  <Muted>—</Muted>
                )}
              </Td>
              <Td>
                {people != null ? (
                  `${people} associated`
                ) : (
                  <Muted>—</Muted>
                )}
              </Td>
              <Td className="max-w-[28rem]">
                <div className="line-clamp-2">
                  {readString(r.notes) ?? <Muted>—</Muted>}
                </div>
              </Td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function EventsTable({ rows }: { rows: Array<Record<string, unknown>> }) {
  return (
    <table className="w-full border-separate border-spacing-0 text-sm">
      <thead>
        <tr>
          <Th>Name</Th>
          <Th>When</Th>
          <Th>Place</Th>
          <Th>Attendees</Th>
          <Th>Key info</Th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r, i) => {
          const attendees = Array.isArray(r.attendeeIds)
            ? r.attendeeIds.length
            : Array.isArray(r.personIds)
              ? r.personIds.length
              : null;
          return (
            <tr key={readString(r.id) ?? i}>
              <Td>{readString(r.name) ?? readString(r.title) ?? <Muted>—</Muted>}</Td>
              <Td>{fmtMaybeDate(r.when ?? r.startsAt ?? r.startAt)}</Td>
              <Td>{readString(r.placeId) ?? <Muted>—</Muted>}</Td>
              <Td>{attendees != null ? attendees.toLocaleString() : <Muted>—</Muted>}</Td>
              <Td className="max-w-[24rem]">
                <div className="line-clamp-2">
                  {readString(r.keyInfo) ?? <Muted>—</Muted>}
                </div>
              </Td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function MemoriesTable({
  rows,
  peopleById,
}: {
  rows: Array<Record<string, unknown>>;
  peopleById: Map<string, string>;
}) {
  return (
    <table className="w-full border-separate border-spacing-0 text-sm">
      <thead>
        <tr>
          <Th>Date</Th>
          <Th>Memory</Th>
          <Th>Tag</Th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r, i) => {
          const personId = readString(r.personId);
          const placeId = readString(r.placeId);
          const tag = personId
            ? peopleById.get(personId) ?? personId
            : placeId ?? null;
          return (
            <tr key={readString(r.id) ?? i}>
              <Td>{fmtMaybeDate(r.createdAt ?? r.date)}</Td>
              <Td className="max-w-[36rem]">
                <div className="line-clamp-3">
                  {readString(r.text) ?? <Muted>—</Muted>}
                </div>
              </Td>
              <Td>
                {tag ? (
                  <span className="inline-flex items-center rounded-full bg-[var(--sand-2)] px-2 py-0.5 text-xs font-medium text-[var(--ink-soft)]">
                    {tag}
                  </span>
                ) : (
                  <Muted>—</Muted>
                )}
              </Td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function SuggestionsLogTable({
  rows,
  peopleById,
}: {
  rows: Array<Record<string, unknown>>;
  peopleById: Map<string, string>;
}) {
  return (
    <table className="w-full border-separate border-spacing-0 text-sm">
      <thead>
        <tr>
          <Th>Date</Th>
          <Th>Category</Th>
          <Th>Text</Th>
          <Th>Selected</Th>
          <Th>Person</Th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r, i) => {
          const personId = readString(r.personId);
          const selected =
            typeof r.selected === "boolean" ? r.selected : Boolean(r.wasSelected);
          return (
            <tr key={readString(r.id) ?? i}>
              <Td>{fmtMaybeDate(r.createdAt)}</Td>
              <Td>{readString(r.category) ?? <Muted>—</Muted>}</Td>
              <Td className="max-w-[28rem]">
                <div className="line-clamp-2">
                  {readString(r.text) ?? <Muted>—</Muted>}
                </div>
              </Td>
              <Td>
                {selected ? (
                  <span className="inline-flex items-center rounded-full bg-[var(--teal)]/10 px-2 py-0.5 text-xs font-medium text-[var(--teal-dark)]">
                    yes
                  </span>
                ) : (
                  <Muted>—</Muted>
                )}
              </Td>
              <Td>
                {personId ? (peopleById.get(personId) ?? personId) : <Muted>—</Muted>}
              </Td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

/**
 * Sync error log renderer — surfaces per-row failures recorded by the
 * write-behind engine after MAX_RETRIES_BEFORE_LOG attempts. Rows that
 * eventually went through are flagged "recovered" so the admin can tell
 * "broke once, healed itself" from "currently broken".
 */
function SyncErrorsTable({ rows }: { rows: Array<Record<string, unknown>> }) {
  // Toggling open shows the full (untrimmed) message — Firestore-stored
  // SyncError.message is already capped to 500 chars by the engine, so
  // "full" here just means past the table's per-row 80-char preview.
  const [openId, setOpenId] = useState<string | null>(null);

  return (
    <table className="w-full border-separate border-spacing-0 text-sm">
      <thead>
        <tr>
          <Th>When</Th>
          <Th>Table</Th>
          <Th>Row id</Th>
          <Th>Kind</Th>
          <Th>Retries</Th>
          <Th>Status</Th>
          <Th>Message</Th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r, i) => {
          const id = readString(r.id) ?? `row-${i}`;
          const isOpen = openId === id;
          const rowId = readString(r.rowId);
          const message = readString(r.message);
          const recovered =
            typeof r.recovered === "boolean" ? r.recovered : false;
          const rawKind = readString(r.kind);
          const kind: "text" | "blob" | "unknown" =
            rawKind === "text" || rawKind === "blob"
              ? rawKind
              : "unknown";
          const retries = readNumber(r.retries) ?? 0;
          const table = readString(r.table);
          const createdAt = readString(r.createdAt) ?? readNumber(r.createdAt);
          return (
            <tr key={id}>
              <Td>
                <span title={fmtMaybeDateText(createdAt)}>
                  {relativeTime(typeof createdAt === "number" ? createdAt : createdAt ?? null)}
                </span>
              </Td>
              <Td>
                {table ? (
                  <span className="font-mono text-xs">{table}</span>
                ) : (
                  <Muted>—</Muted>
                )}
              </Td>
              <Td>
                {rowId ? (
                  <span
                    title={rowId}
                    className="font-mono text-xs text-[var(--ink-soft)]"
                  >
                    {rowId.length > 8 ? `${rowId.slice(0, 8)}…` : rowId}
                  </span>
                ) : (
                  <Muted>—</Muted>
                )}
              </Td>
              <Td>
                <SyncErrorKindBadge kind={kind} />
              </Td>
              <Td className="tabular-nums">{retries.toLocaleString()}</Td>
              <Td>
                <SyncErrorStatusBadge recovered={recovered} />
              </Td>
              <Td className="max-w-[28rem]">
                <button
                  type="button"
                  onClick={() => setOpenId(isOpen ? null : id)}
                  className="text-left text-xs text-[var(--ink-soft)] hover:text-foreground"
                  aria-expanded={isOpen}
                >
                  {message ? (
                    isOpen ? (
                      <span className="whitespace-pre-wrap break-words">
                        {message}
                      </span>
                    ) : (
                      <span className="line-clamp-1">
                        {message.length > 80
                          ? `${message.slice(0, 80)}…`
                          : message}
                      </span>
                    )
                  ) : (
                    <Muted>—</Muted>
                  )}
                </button>
              </Td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

/** Kind badge — colour by which part of the sync stack is suspected. */
function SyncErrorKindBadge({ kind }: { kind: "text" | "blob" | "unknown" }) {
  const cls =
    kind === "blob"
      ? "bg-[var(--teal)]/10 text-[var(--teal-dark)]"
      : kind === "unknown"
        ? "bg-[var(--sun)]/30 text-[var(--ink)]"
        : "bg-[var(--sand-2)] text-[var(--ink-soft)]";
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide",
        cls,
      )}
    >
      {kind}
    </span>
  );
}

function SyncErrorStatusBadge({ recovered }: { recovered: boolean }) {
  if (recovered) {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-[var(--teal)]/10 px-2 py-0.5 text-xs font-medium text-[var(--teal-dark)]">
        <span aria-hidden="true">✓</span>
        Recovered
      </span>
    );
  }
  return (
    <span className="inline-flex items-center rounded-full bg-[var(--coral)]/10 px-2 py-0.5 text-xs font-medium text-[var(--coral)]">
      Failing
    </span>
  );
}

/** String form of a timestamp for tooltip purposes — falls back to a dash. */
function fmtMaybeDateText(v: unknown): string {
  if (v == null) return "—";
  if (typeof v === "string") {
    const d = new Date(v);
    if (!Number.isNaN(d.getTime())) return d.toLocaleString();
    return v;
  }
  if (typeof v === "number" && Number.isFinite(v)) {
    const d = new Date(v);
    if (!Number.isNaN(d.getTime())) return d.toLocaleString();
  }
  return "—";
}

function GenericTable({ rows }: { rows: Array<Record<string, unknown>> }) {
  return (
    <table className="w-full border-separate border-spacing-0 text-sm">
      <thead>
        <tr>
          <Th>ID</Th>
          <Th>Row</Th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r, i) => (
          <tr key={readString(r.id) ?? i}>
            <Td className="font-mono text-xs text-[var(--ink-soft)]">
              {readString(r.id) ?? `#${i + 1}`}
            </Td>
            <Td>
              <pre className="max-h-32 overflow-auto whitespace-pre-wrap break-words text-xs text-[var(--ink-soft)]">
                {JSON.stringify(r, null, 2)}
              </pre>
            </Td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// --------------------------------------------------------------------------
// Listen button — toggles a single shared <audio> element.
// --------------------------------------------------------------------------

function ListenButton({
  storagePath,
  durationSec,
}: {
  storagePath: string;
  durationSec: number | null;
}) {
  const [state, setState] = useState<"idle" | "loading" | "playing" | "error">("idle");
  // Tracked from the shared HTMLAudioElement during playback so the label can
  // show "Pause · 0:02/0:04" and the progress bar can fill.
  const [position, setPosition] = useState(0);
  const [duration, setDuration] = useState<number>(durationSec ?? 0);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  // Make sure the audio element forgets us when we leave the row.
  useEffect(() => {
    return () => {
      audioRef.current?.pause();
      audioRef.current = null;
    };
  }, []);

  async function onClick() {
    if (state === "playing") {
      audioRef.current?.pause();
      audioRef.current = null;
      setState("idle");
      return;
    }
    setState("loading");
    try {
      const audio = await playAudioFromAdminUrl(storagePath);
      audioRef.current = audio;
      setState("playing");
      setPosition(audio.currentTime || 0);
      if (Number.isFinite(audio.duration) && audio.duration > 0) {
        setDuration(audio.duration);
      }
      const onTime = () => {
        if (audioRef.current === audio) setPosition(audio.currentTime);
      };
      const onMeta = () => {
        if (audioRef.current === audio && Number.isFinite(audio.duration)) {
          setDuration(audio.duration);
        }
      };
      audio.addEventListener("timeupdate", onTime);
      audio.addEventListener("loadedmetadata", onMeta);
      audio.addEventListener("ended", () => {
        if (audioRef.current === audio) {
          audioRef.current = null;
          setState("idle");
          setPosition(0);
        }
      });
      audio.addEventListener("pause", () => {
        if (audioRef.current === audio && !audio.ended) {
          setState("idle");
        }
      });
    } catch (err) {
      console.error("[admin/users] audio playback failed", err);
      setState("error");
    }
  }

  const totalLabel = duration > 0 ? fmtClock(duration) : null;
  const playingLabel =
    state === "playing"
      ? `Pause · ${fmtClock(position)}${totalLabel ? `/${totalLabel}` : ""}`
      : state === "loading"
        ? "Loading…"
        : state === "error"
          ? "Try again"
          : `Listen${totalLabel ? ` · ${totalLabel}` : ""}`;

  const progressPct =
    duration > 0 ? Math.min(100, (position / duration) * 100) : 0;

  return (
    <div className="flex flex-col gap-1">
      <button
        type="button"
        onClick={onClick}
        disabled={state === "loading"}
        className="inline-flex w-fit items-center rounded-md border border-[var(--line)] px-2 py-1 text-xs font-medium hover:bg-[var(--sand-2)] disabled:opacity-50"
      >
        {playingLabel}
      </button>
      <div
        className="h-1 w-40 overflow-hidden rounded-full bg-[var(--sand-2)]"
        aria-hidden="true"
      >
        <div
          className="h-full bg-[var(--teal)] transition-[width] duration-100 ease-linear"
          style={{ width: `${progressPct}%` }}
        />
      </div>
    </div>
  );
}

function fmtClock(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const total = Math.floor(seconds);
  const mins = Math.floor(total / 60);
  const secs = total % 60;
  return `${mins}:${secs.toString().padStart(2, "0")}`;
}

// --------------------------------------------------------------------------
// Small typed read helpers (Firestore decode is loose)
// --------------------------------------------------------------------------

function readString(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

function readNumber(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function readAudioRef(row: Record<string, unknown>): {
  storagePath: string;
  sizeBytes: number | null;
} | null {
  // The sync engine swaps Blob fields for `{ storagePath, sizeBytes }`. The
  // contribution row carries that under `audio` (the on-device field name).
  const audio = row.audio;
  if (audio && typeof audio === "object") {
    const storagePath = readString((audio as Record<string, unknown>).storagePath);
    if (storagePath) {
      return {
        storagePath,
        sizeBytes: readNumber((audio as Record<string, unknown>).sizeBytes),
      };
    }
  }
  // Defence-in-depth: some rows may inline storagePath at the top level.
  const topPath = readString(row.storagePath);
  if (topPath) {
    return { storagePath: topPath, sizeBytes: readNumber(row.sizeBytes) };
  }
  return null;
}

// --------------------------------------------------------------------------
// Action history — last 10 audit entries for this user, with a "See all"
// link out to the filtered /admin/activity feed.
// --------------------------------------------------------------------------

function ActionHistorySection({
  uid,
  refreshKey,
}: {
  uid: string;
  refreshKey: number;
}) {
  const [entries, setEntries] = useState<AuditEntry[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<AdminApiError | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setEntries(null);
    fetchActivity({ targetUid: uid, limit: 10, force: refreshKey > 0 })
      .then((data) => {
        if (!cancelled) setEntries(data);
      })
      .catch((err) => {
        if (!cancelled) {
          setError(
            err instanceof AdminApiError
              ? err
              : new AdminApiError(0, "Couldn't load action history."),
          );
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [uid, refreshKey]);

  const list = entries ?? [];
  const trimmed = list.slice(0, 10);

  return (
    <section className="mt-10">
      <div className="flex items-baseline justify-between">
        <h2 className="text-xl font-semibold tracking-tight">Action history</h2>
        <Link
          to="/admin/activity"
          search={{ targetUid: uid }}
          className="text-sm font-medium text-[var(--teal-dark)] hover:underline"
        >
          See all →
        </Link>
      </div>
      <div className="mt-3 rounded-2xl border border-[var(--line)] bg-white p-3">
        {loading ? (
          <div className="flex flex-col gap-2 p-2">
            {Array.from({ length: 4 }).map((_, i) => (
              <div
                key={i}
                className="h-10 bg-[var(--sand-2)]/60 rounded-md animate-pulse"
              />
            ))}
          </div>
        ) : error ? (
          <p className="px-3 py-6 text-center text-sm text-[var(--coral)]">
            {error.message}
          </p>
        ) : trimmed.length === 0 ? (
          <p className="px-3 py-6 text-center text-sm text-[var(--ink-soft)]">
            No admin actions logged for this user yet.
          </p>
        ) : (
          <table className="w-full border-separate border-spacing-0 text-sm">
            <thead>
              <tr>
                <Th>When</Th>
                <Th>Actor</Th>
                <Th>Action</Th>
                <Th>Status</Th>
              </tr>
            </thead>
            <tbody>
              {trimmed.map((e) => (
                <tr key={e.id}>
                  <Td>
                    <span title={fmtDateTime(e.createdAt)} className="cursor-help">
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
                    <StatusBadge entry={e} />
                  </Td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </section>
  );
}

const ACTION_CATEGORY: Record<AdminAction, "destructive" | "promote" | "neutral"> = {
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

function StatusBadge({ entry }: { entry: AuditEntry }) {
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
        title="The action partially succeeded — see /admin/activity for the full row."
      >
        partial
      </span>
    );
  }
  return (
    <span
      className="inline-flex items-center rounded-full bg-[var(--coral)]/10 px-2 py-0.5 text-xs font-medium text-[var(--coral)]"
      title={entry.errorMessage ?? undefined}
    >
      error
    </span>
  );
}

type DialogState =
  | { kind: "closed" }
  | { kind: "revoke-admin" }
  | { kind: "disable" }
  | { kind: "enable" }
  | { kind: "delete-step1" } // type email
  | { kind: "delete-step2" }; // type DELETE

function DangerZone({
  user,
  onChanged,
}: {
  user: AdminUserRecord;
  onChanged: () => void;
}) {
  const [dialog, setDialog] = useState<DialogState>({ kind: "closed" });
  const [busy, setBusy] = useState(false);

  // The email is the "type to confirm" string for both revoke-admin and the
  // first delete step. Fall back to the uid if the account somehow has no
  // email (shouldn't happen for Parley accounts, but defence in depth).
  const confirmIdentity = user.email ?? user.uid;

  async function run(action: AdminUserAction, successMessage: string) {
    setBusy(true);
    try {
      const result = await performUserAction(user.uid, action);
      toast.success(successMessage);
      if (result.partial) {
        toast.warning(
          "Auth account deleted, but the Firestore/Storage wipe didn't fully complete. Check server logs.",
        );
      }
      onChanged();
    } catch (err) {
      const message =
        err instanceof AdminApiError ? err.message : "Action failed.";
      toast.error(message);
    } finally {
      setBusy(false);
      setDialog({ kind: "closed" });
    }
  }

  return (
    <div className="mt-10 rounded-2xl border border-[var(--line)] bg-white p-6">
      <h2 className="text-base font-semibold text-[var(--coral)]">Danger zone</h2>
      <p className="mt-1 text-sm text-[var(--ink-soft)]">
        Destructive actions. Each requires an extra confirm step — typing the account email or
        the word DELETE — so a stray tap can't wipe data.
      </p>
      <div className="mt-4 flex flex-wrap gap-3">
        {user.is_admin ? (
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => setDialog({ kind: "revoke-admin" })}
          >
            Revoke admin
          </Button>
        ) : null}
        {user.disabled ? (
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => setDialog({ kind: "enable" })}
          >
            Enable account
          </Button>
        ) : (
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => setDialog({ kind: "disable" })}
          >
            Disable account
          </Button>
        )}
        <Button
          variant="destructive"
          disabled={busy}
          onClick={() => setDialog({ kind: "delete-step1" })}
        >
          Delete account
        </Button>
      </div>

      {/* Revoke admin — typed email confirm */}
      <ConfirmDialog
        open={dialog.kind === "revoke-admin"}
        onOpenChange={(o) => !o && setDialog({ kind: "closed" })}
        title="Revoke admin?"
        description={`Clears the admin custom claim from ${confirmIdentity}. They'll lose access to /admin on their next ID-token refresh.`}
        confirmLabel="Revoke admin"
        destructive
        requireTypedText={confirmIdentity}
        typedTextLabel={`Type "${confirmIdentity}" to confirm`}
        onConfirm={() => run("revoke-admin", "Admin revoked.")}
      />

      {/* Disable account — simple confirm */}
      <ConfirmDialog
        open={dialog.kind === "disable"}
        onOpenChange={(o) => !o && setDialog({ kind: "closed" })}
        title="Disable this account?"
        description={`${confirmIdentity} won't be able to sign in until the account is enabled again. Their data stays in Firestore + Storage.`}
        confirmLabel="Disable account"
        destructive
        onConfirm={() => run("disable", "Account disabled.")}
      />

      {/* Enable account — simple, neutral confirm */}
      <ConfirmDialog
        open={dialog.kind === "enable"}
        onOpenChange={(o) => !o && setDialog({ kind: "closed" })}
        title="Re-enable this account?"
        description={`${confirmIdentity} will be able to sign in again on their next attempt.`}
        confirmLabel="Enable account"
        onConfirm={() => run("enable", "Account enabled.")}
      />

      {/* Delete step 1 — type the email */}
      <ConfirmDialog
        open={dialog.kind === "delete-step1"}
        onOpenChange={(o) => !o && setDialog({ kind: "closed" })}
        title="Delete this account?"
        description={`This permanently removes the Firebase Auth account for ${confirmIdentity} and best-effort wipes their Firestore + Storage data. There is no undo.`}
        confirmLabel="Continue"
        destructive
        requireTypedText={confirmIdentity}
        typedTextLabel={`Type "${confirmIdentity}" to continue`}
        onConfirm={() => setDialog({ kind: "delete-step2" })}
      />

      {/* Delete step 2 — type DELETE */}
      <ConfirmDialog
        open={dialog.kind === "delete-step2"}
        onOpenChange={(o) => !o && setDialog({ kind: "closed" })}
        title="Final confirmation"
        description={`Last chance. Type DELETE to wipe ${confirmIdentity} and their synced data.`}
        confirmLabel="Delete account"
        destructive
        requireTypedText="DELETE"
        typedTextLabel='Type "DELETE" (uppercase) to confirm'
        onConfirm={() => run("delete", "Account deleted.")}
      />
    </div>
  );
}

function Dt({ children }: { children: React.ReactNode }) {
  return <dt className="font-medium text-[var(--ink-soft)]">{children}</dt>;
}

function Dd({ children, className }: { children: React.ReactNode; className?: string }) {
  return <dd className={className ?? ""}>{children}</dd>;
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

function Muted({ children }: { children: React.ReactNode }) {
  return <span className="text-[var(--ink-soft)]">{children}</span>;
}

function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString();
}

function fmtMaybeDate(v: unknown): React.ReactNode {
  if (v == null) return <Muted>—</Muted>;
  if (typeof v === "string") {
    const d = new Date(v);
    if (!Number.isNaN(d.getTime())) return d.toLocaleString();
    return v;
  }
  if (typeof v === "number" && Number.isFinite(v)) {
    const d = new Date(v);
    if (!Number.isNaN(d.getTime())) return d.toLocaleString();
  }
  return <Muted>—</Muted>;
}

function fmtBytes(n: number | null): string {
  if (n == null || !Number.isFinite(n)) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}
