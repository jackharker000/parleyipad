import { createFileRoute } from "@tanstack/react-router";

import { corsPreflight, withCors } from "@/lib/api-cors";
import { getAccessToken, getProjectId, isAdminConfigured } from "@/lib/firebase/admin";
import { requireAdmin } from "@/lib/firebase/admin-guard";

/**
 * Admin viewer for synced per-user data. Reads a Firestore collection at
 * `users/{uid}/<table>` and returns the decoded rows. The sync engine (other
 * agent) writes each Dexie row's JSON into that path, with Blob fields swapped
 * for a `{ storagePath, sizeBytes }` reference.
 *
 * Admin-only. Mirrors the CORS + 503 pattern of the sibling admin routes.
 * POST body: `{ idToken, uid, table, limit? }`.
 */

const SYNCED_TABLES = new Set<string>([
  "conversations",
  "transcriptSegments",
  "voiceprints",
  "voiceprintContributions",
  "people",
  "places",
  "events",
  "jamesProfile",
  "styleProfile",
  "memories",
  "followUps",
  "suggestionsLog",
  "helperDrafts",
  "manualReplies",
  "syncErrors",
]);

export const Route = createFileRoute("/api/admin/user-data")({
  server: {
    handlers: {
      OPTIONS: ({ request }) => corsPreflight(request),
      POST: async ({ request }) => {
        if (!isAdminConfigured()) {
          return json({ error: "Admin features not configured on the server" }, 503, request);
        }
        const guard = await requireAdmin(request);
        if (guard instanceof Response) return withCorsResponse(guard, request);

        let uid: string | undefined;
        let table: string | undefined;
        let limit = 100;
        try {
          const body = (await request.json()) as {
            uid?: string;
            table?: string;
            limit?: number;
          };
          uid = body.uid;
          table = body.table;
          if (typeof body.limit === "number" && Number.isFinite(body.limit)) {
            limit = Math.max(1, Math.min(500, Math.floor(body.limit)));
          }
        } catch {
          return json({ error: "Invalid body" }, 400, request);
        }

        if (typeof uid !== "string" || uid.length === 0) {
          return json({ error: "Missing uid" }, 400, request);
        }
        if (typeof table !== "string" || !SYNCED_TABLES.has(table)) {
          return json({ error: "Unknown table" }, 400, request);
        }

        try {
          const rows = await listUserDocuments(uid, table, limit);
          return json({ rows }, 200, request);
        } catch (err) {
          console.error(
            "[api/admin/user-data] load failed:",
            err instanceof Error ? err.message : "unknown",
          );
          return json({ error: "Couldn't load synced data" }, 500, request);
        }
      },
    },
  },
});

// --------------------------------------------------------------------------
// Firestore REST — list a sub-collection under users/{uid}/{table}
// --------------------------------------------------------------------------

async function listUserDocuments(
  uid: string,
  table: string,
  limit: number,
): Promise<Array<Record<string, unknown>>> {
  const token = await getAccessToken();
  const base = `https://firestore.googleapis.com/v1/projects/${getProjectId()}/databases/(default)/documents/users/${encodeURIComponent(uid)}/${encodeURIComponent(table)}`;
  const orderedUrl = `${base}?pageSize=${limit}&orderBy=${encodeURIComponent("createdAt desc")}`;

  let res = await fetch(orderedUrl, {
    headers: { authorization: `Bearer ${token}` },
  });

  // Tables without a `createdAt` field reject the orderBy with INVALID_ARGUMENT;
  // fall back to an unordered listing in that case.
  if (!res.ok && res.status === 400) {
    const fallback = `${base}?pageSize=${limit}`;
    res = await fetch(fallback, {
      headers: { authorization: `Bearer ${token}` },
    });
  }

  if (!res.ok) {
    if (res.status === 404) return [];
    const text = await res.text().catch(() => "");
    throw new Error(`Firestore list failed: ${res.status} ${text.slice(0, 200)}`);
  }

  const data = (await res.json()) as {
    documents?: Array<{ name?: string; fields?: Record<string, FirestoreValue> }>;
  };
  const docs = data.documents ?? [];
  return docs.map((doc) => decode(doc.fields ?? {}));
}

// --------------------------------------------------------------------------
// Firestore JSON-form decode (small, only covers the value types we see)
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

function json(body: unknown, status: number, request?: Request): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: withCors({ "content-type": "application/json" }, request),
  });
}

function withCorsResponse(res: Response, request?: Request): Response {
  const headers = withCors({ "content-type": "application/json" }, request);
  for (const [k, v] of Object.entries(headers)) res.headers.set(k, v);
  return res;
}
