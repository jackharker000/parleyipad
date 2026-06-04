import { useEffect, useMemo, useRef, useState } from "react";
import { Link, createFileRoute } from "@tanstack/react-router";

import { Button } from "@/components/ui/button";
import {
  AdminApiError,
  fetchUsage,
  fetchUser,
  fetchUserData,
  playAudioFromAdminUrl,
  stopAdminAudio,
} from "@/lib/admin";
import type { AdminUserRecord, UsageUserBucket } from "@/lib/admin";

export const Route = createFileRoute("/admin/users/$userId")({
  component: AdminUserDetailPage,
});

function AdminUserDetailPage() {
  const { userId } = Route.useParams();
  const [user, setUser] = useState<AdminUserRecord | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<AdminApiError | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetchUser(userId)
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
  }, [userId]);

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
          <DangerZone />
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
      </dl>
    </div>
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
];

function SyncedDataSection({ uid }: { uid: string }) {
  const [activeKey, setActiveKey] = useState<string>(SYNCED_TABS[0].key);
  const active = SYNCED_TABS.find((t) => t.key === activeKey) ?? SYNCED_TABS[0];

  // People rows for voiceprintContributions are looked up by personId, so we
  // fetch them once when the contributions tab is active.
  const [people, setPeople] = useState<Array<Record<string, unknown>> | null>(null);
  useEffect(() => {
    if (activeKey !== "voiceprintContributions") return;
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
          return (
            <button
              key={t.key}
              type="button"
              onClick={() => setActiveKey(t.key)}
              aria-pressed={isActive}
              className={
                isActive
                  ? "rounded-full bg-[var(--teal)] px-3 py-1 font-medium text-white"
                  : "rounded-full px-3 py-1 font-medium text-[var(--ink-soft)] hover:text-foreground"
              }
            >
              {t.label}
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
    return <ConversationsTable rows={rows} />;
  }
  if (tableKey === "voiceprints") {
    return <VoiceprintsTable rows={rows} peopleById={peopleById} />;
  }
  if (tableKey === "transcriptSegments") {
    return <SegmentsTable rows={rows} />;
  }

  return <GenericTable rows={rows} />;
}

// --------------------------------------------------------------------------
// Per-table renderers — keep them compact and forgiving (Firestore is loose).
// --------------------------------------------------------------------------

function ConversationsTable({ rows }: { rows: Array<Record<string, unknown>> }) {
  return (
    <table className="w-full border-separate border-spacing-0 text-sm">
      <thead>
        <tr>
          <Th>Started</Th>
          <Th>Title</Th>
          <Th>Place</Th>
          <Th>ID</Th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r, i) => (
          <tr key={readString(r.id) ?? i}>
            <Td>{fmtMaybeDate(r.createdAt ?? r.startedAt)}</Td>
            <Td>{readString(r.title) ?? <Muted>—</Muted>}</Td>
            <Td>{readString(r.placeId) ?? <Muted>—</Muted>}</Td>
            <Td className="font-mono text-xs text-[var(--ink-soft)]">
              {readString(r.id) ?? <Muted>—</Muted>}
            </Td>
          </tr>
        ))}
      </tbody>
    </table>
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
    <table className="w-full border-separate border-spacing-0 text-sm">
      <thead>
        <tr>
          <Th>Created</Th>
          <Th>Person</Th>
          <Th>Source</Th>
          <Th>Size</Th>
          <Th>Listen</Th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r, i) => {
          const personId = readString(r.personId);
          const personName = personId ? peopleById.get(personId) ?? null : null;
          const audio = readAudioRef(r);
          return (
            <tr key={readString(r.id) ?? i}>
              <Td>{fmtMaybeDate(r.createdAt)}</Td>
              <Td>{personName ?? personId ?? <Muted>—</Muted>}</Td>
              <Td>{readString(r.source) ?? <Muted>—</Muted>}</Td>
              <Td>{audio ? fmtBytes(audio.sizeBytes) : <Muted>—</Muted>}</Td>
              <Td>
                {audio?.storagePath ? (
                  <ListenButton storagePath={audio.storagePath} />
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

function ListenButton({ storagePath }: { storagePath: string }) {
  const [state, setState] = useState<"idle" | "loading" | "playing" | "error">("idle");
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
      audio.addEventListener("ended", () => {
        if (audioRef.current === audio) {
          audioRef.current = null;
          setState("idle");
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

  const label =
    state === "playing"
      ? "Pause"
      : state === "loading"
        ? "Loading…"
        : state === "error"
          ? "Try again"
          : "Listen";

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={state === "loading"}
      className="inline-flex items-center rounded-md border border-[var(--line)] px-2 py-1 text-xs font-medium hover:bg-[var(--sand-2)] disabled:opacity-50"
    >
      {label}
    </button>
  );
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

function DangerZone() {
  return (
    <div className="mt-10 rounded-2xl border border-[var(--line)] bg-white p-6">
      <h2 className="text-base font-semibold text-[var(--coral)]">Danger zone</h2>
      <p className="mt-1 text-sm text-[var(--ink-soft)]">
        Destructive actions — not yet wired up. The buttons are visible so the affordance is
        obvious, but they do nothing.
      </p>
      <div className="mt-4 flex flex-wrap gap-3">
        <Button variant="outline" disabled title="Not implemented">
          Revoke admin
        </Button>
        <Button variant="outline" disabled title="Not implemented">
          Disable account
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
