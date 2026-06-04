import { createFileRoute } from "@tanstack/react-router";

import { corsPreflight, withCors } from "@/lib/api-cors";
import type { AdminAction, AuditEvent } from "@/lib/audit-types";
import { getAccessToken, getProjectId, isAdminConfigured } from "@/lib/firebase/admin";
import { requireAdmin } from "@/lib/firebase/admin-guard";

/**
 * Admin audit-trail reader. Reads recent `admin_actions` docs (project-root
 * collection, server-write-only — see `docs/setup.md` security rules) and
 * returns them newest-first as a flat list for the dashboard.
 *
 * Admin-only. Mirrors the CORS + 503 pattern of the sibling admin routes.
 * POST body: `{ idToken, targetUid?, limit? }`. When `targetUid` is set, the
 * Firestore query filters on it server-side; otherwise we return the full
 * window, ordered by `createdAt desc`.
 */

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

const KNOWN_ACTIONS: ReadonlySet<AdminAction> = new Set<AdminAction>([
  "user.revoke-admin",
  "user.disable",
  "user.enable",
  "user.delete",
  "waitlist.onboarded",
  "waitlist.archive",
  "waitlist.delete",
  "role.promote-admin",
]);

export type AuditEntry = AuditEvent & { id: string; createdAt: string };

export const Route = createFileRoute("/api/admin/activity")({
  server: {
    handlers: {
      OPTIONS: ({ request }) => corsPreflight(request),
      POST: async ({ request }) => {
        if (!isAdminConfigured()) {
          return json({ error: "Admin features not configured on the server" }, 503);
        }
        const guard = await requireAdmin(request);
        if (guard instanceof Response) return withCorsResponse(guard);

        let targetUid: string | undefined;
        let limit = DEFAULT_LIMIT;
        try {
          const body = (await request.json()) as {
            targetUid?: unknown;
            limit?: unknown;
          };
          if (typeof body.targetUid === "string" && body.targetUid.length > 0) {
            targetUid = body.targetUid;
          }
          if (typeof body.limit === "number" && Number.isFinite(body.limit)) {
            limit = Math.max(1, Math.min(MAX_LIMIT, Math.floor(body.limit)));
          }
        } catch {
          // Empty / non-JSON body is fine — default to the global most-recent feed.
        }

        try {
          const entries = await queryActivity(targetUid, limit);
          return json({ entries }, 200);
        } catch (err) {
          console.error(
            "[api/admin/activity] load failed:",
            err instanceof Error ? err.message : "unknown",
          );
          return json({ error: "Couldn't load activity" }, 500);
        }
      },
    },
  },
});

// --------------------------------------------------------------------------
// Firestore REST runQuery — admin_actions
// --------------------------------------------------------------------------

type RunQueryResult = Array<{
  document?: {
    name?: string;
    fields?: Record<string, FirestoreValue>;
  };
}>;

async function queryActivity(
  targetUid: string | undefined,
  limit: number,
): Promise<AuditEntry[]> {
  const token = await getAccessToken();
  const url = `https://firestore.googleapis.com/v1/projects/${getProjectId()}/databases/(default)/documents:runQuery`;

  const structuredQuery: Record<string, unknown> = {
    from: [{ collectionId: "admin_actions" }],
    orderBy: [
      {
        field: { fieldPath: "createdAt" },
        direction: "DESCENDING",
      },
    ],
    limit,
  };

  if (targetUid) {
    structuredQuery.where = {
      fieldFilter: {
        field: { fieldPath: "targetUid" },
        op: "EQUAL",
        value: { stringValue: targetUid },
      },
    };
  }

  const res = await fetch(url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ structuredQuery }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`runQuery failed: ${res.status} ${text.slice(0, 200)}`);
  }

  const rows = (await res.json()) as RunQueryResult;
  const out: AuditEntry[] = [];
  for (const row of rows) {
    const doc = row.document;
    if (!doc?.fields) continue;
    const decoded = decode(doc.fields);
    const entry = toEntry(docIdFromName(doc.name), decoded);
    if (entry) out.push(entry);
  }
  return out;
}

function toEntry(id: string, row: Record<string, unknown>): AuditEntry | null {
  const action = row.action;
  if (typeof action !== "string" || !KNOWN_ACTIONS.has(action as AdminAction)) {
    // Skip rows from a future schema version we don't recognise — better to
    // hide them than to render a half-broken entry.
    return null;
  }
  const status = row.status;
  const validStatus =
    status === "ok" || status === "partial" || status === "error" ? status : "ok";

  const detail =
    row.detail && typeof row.detail === "object" && !Array.isArray(row.detail)
      ? (row.detail as Record<string, unknown>)
      : undefined;

  const createdAt = typeof row.createdAt === "string" ? row.createdAt : "";

  return {
    id,
    action: action as AdminAction,
    actorUid: typeof row.actorUid === "string" ? row.actorUid : "",
    actorEmail: typeof row.actorEmail === "string" ? row.actorEmail : null,
    targetUid: typeof row.targetUid === "string" ? row.targetUid : null,
    targetEmail: typeof row.targetEmail === "string" ? row.targetEmail : null,
    detail,
    status: validStatus,
    errorMessage:
      typeof row.errorMessage === "string" ? row.errorMessage : null,
    createdAt,
  };
}

function docIdFromName(name: string | undefined): string {
  if (!name) return "";
  const slash = name.lastIndexOf("/");
  return slash >= 0 ? name.slice(slash + 1) : name;
}

// --------------------------------------------------------------------------
// Firestore JSON-form decode — mirrors user-data.ts / waitlist.ts.
// --------------------------------------------------------------------------

type FirestoreValue = {
  nullValue?: null;
  stringValue?: string;
  integerValue?: string;
  doubleValue?: number;
  booleanValue?: boolean;
  timestampValue?: string;
  arrayValue?: { values?: FirestoreValue[] };
  mapValue?: { fields?: Record<string, FirestoreValue> };
};

function decodeValue(v: FirestoreValue): unknown {
  if (v == null) return null;
  if ("nullValue" in v) return null;
  if (typeof v.stringValue === "string") return v.stringValue;
  if (typeof v.booleanValue === "boolean") return v.booleanValue;
  if (typeof v.integerValue === "string") {
    const n = Number(v.integerValue);
    return Number.isFinite(n) ? n : v.integerValue;
  }
  if (typeof v.doubleValue === "number") return v.doubleValue;
  if (typeof v.timestampValue === "string") return v.timestampValue;
  if (v.arrayValue) {
    return (v.arrayValue.values ?? []).map(decodeValue);
  }
  if (v.mapValue) {
    return decode(v.mapValue.fields ?? {});
  }
  return null;
}

function decode(fields: Record<string, FirestoreValue>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields)) {
    out[k] = decodeValue(v);
  }
  return out;
}

// --------------------------------------------------------------------------
// Response helpers — mirror the sibling admin routes verbatim.
// --------------------------------------------------------------------------

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: withCors({ "content-type": "application/json" }),
  });
}

function withCorsResponse(res: Response): Response {
  const headers = withCors({ "content-type": "application/json" });
  for (const [k, v] of Object.entries(headers)) res.headers.set(k, v);
  return res;
}
