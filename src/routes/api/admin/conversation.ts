import { createFileRoute } from "@tanstack/react-router";

import { corsPreflight, withCors } from "@/lib/api-cors";
import { getAccessToken, getProjectId, isAdminConfigured } from "@/lib/firebase/admin";
import { requireAdmin } from "@/lib/firebase/admin-guard";

/**
 * Admin viewer — full bundle for a single conversation under a single user.
 *
 * Reads, in parallel:
 *   1. The conversation doc itself (`users/{uid}/conversations/{id}`).
 *   2. All `transcriptSegments` rows where `conversationId == id`.
 *   3. All `suggestionsLog` rows where `conversationId == id`.
 *   4. All `voiceprintContributions` rows where `conversationId == id`.
 *   5. All `people` rows (so the client can resolve `personId` → name).
 *
 * The point: the admin needs to reconstruct what actually happened in a
 * conversation — who said what, what suggestions Parley offered, which were
 * tapped. Five separate `/api/admin/user-data` calls would hammer the network
 * and require ad-hoc filtering on the client; this rolls them into one.
 *
 * Admin-only. Mirrors the CORS + 503 pattern of the sibling admin routes.
 * POST body: `{ idToken, uid, conversationId }`.
 */

const SEGMENTS_LIMIT = 2000;
const SUGGESTIONS_LIMIT = 1000;
const CONTRIBUTIONS_LIMIT = 200;
const PEOPLE_LIMIT = 500;

export const Route = createFileRoute("/api/admin/conversation")({
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
        let conversationId: string | undefined;
        try {
          const body = (await request.json()) as {
            uid?: string;
            conversationId?: string;
          };
          uid = body.uid;
          conversationId = body.conversationId;
        } catch {
          return json({ error: "Invalid body" }, 400, request);
        }

        if (typeof uid !== "string" || uid.length === 0) {
          return json({ error: "Missing uid" }, 400, request);
        }
        if (typeof conversationId !== "string" || conversationId.length === 0) {
          return json({ error: "Missing conversationId" }, 400, request);
        }

        try {
          const [conversation, segments, suggestions, contributions, people] = await Promise.all([
            getConversation(uid, conversationId),
            queryByConversation(uid, "transcriptSegments", conversationId, SEGMENTS_LIMIT),
            queryByConversation(uid, "suggestionsLog", conversationId, SUGGESTIONS_LIMIT),
            queryByConversation(
              uid,
              "voiceprintContributions",
              conversationId,
              CONTRIBUTIONS_LIMIT,
            ),
            listAll(uid, "people", PEOPLE_LIMIT),
          ]);

          if (!conversation) {
            return json({ error: "Conversation not found" }, 404, request);
          }

          segments.sort(byNumber("startedAt"));
          suggestions.sort(byNumber("createdAt"));

          return json(
            {
              conversation,
              segments,
              suggestions,
              contributions,
              people,
            },
            200,
            request,
          );
        } catch (err) {
          console.error(
            "[api/admin/conversation] load failed:",
            err instanceof Error ? err.message : "unknown",
          );
          return json({ error: "Couldn't load conversation" }, 500, request);
        }
      },
    },
  },
});

// --------------------------------------------------------------------------
// Firestore reads — single GET for the conversation doc, runQuery for each
// child collection (so we can filter by conversationId server-side).
// --------------------------------------------------------------------------

async function getConversation(
  uid: string,
  conversationId: string,
): Promise<Record<string, unknown> | null> {
  const token = await getAccessToken();
  const url = `https://firestore.googleapis.com/v1/projects/${getProjectId()}/databases/(default)/documents/users/${encodeURIComponent(uid)}/conversations/${encodeURIComponent(conversationId)}`;
  const res = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
  if (res.status === 404) return null;
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Firestore GET failed: ${res.status} ${text.slice(0, 200)}`);
  }
  const data = (await res.json()) as { fields?: Record<string, FirestoreValue> };
  return decode(data.fields ?? {});
}

async function queryByConversation(
  uid: string,
  collectionId: string,
  conversationId: string,
  limit: number,
): Promise<Array<Record<string, unknown>>> {
  const token = await getAccessToken();
  const parent = `projects/${getProjectId()}/databases/(default)/documents/users/${encodeURIComponent(uid)}`;
  const url = `https://firestore.googleapis.com/v1/${parent}:runQuery`;
  const body = {
    structuredQuery: {
      from: [{ collectionId }],
      where: {
        fieldFilter: {
          field: { fieldPath: "conversationId" },
          op: "EQUAL",
          value: { stringValue: conversationId },
        },
      },
      limit,
    },
  };

  const res = await fetch(url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`runQuery ${collectionId} failed: ${res.status} ${text.slice(0, 200)}`);
  }

  const rows = (await res.json()) as RunQueryResult;
  const out: Array<Record<string, unknown>> = [];
  for (const row of rows) {
    const doc = row.document;
    if (!doc?.fields) continue;
    out.push(decode(doc.fields));
  }
  return out;
}

async function listAll(
  uid: string,
  collectionId: string,
  limit: number,
): Promise<Array<Record<string, unknown>>> {
  const token = await getAccessToken();
  const base = `https://firestore.googleapis.com/v1/projects/${getProjectId()}/databases/(default)/documents/users/${encodeURIComponent(uid)}/${encodeURIComponent(collectionId)}`;
  const url = `${base}?pageSize=${limit}`;
  const res = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
  if (!res.ok) {
    if (res.status === 404) return [];
    const text = await res.text().catch(() => "");
    throw new Error(`Firestore list ${collectionId} failed: ${res.status} ${text.slice(0, 200)}`);
  }
  const data = (await res.json()) as {
    documents?: Array<{ name?: string; fields?: Record<string, FirestoreValue> }>;
  };
  const docs = data.documents ?? [];
  return docs.map((doc) => decode(doc.fields ?? {}));
}

// --------------------------------------------------------------------------
// Sorting — tolerant of strings, numbers, and missing fields.
// --------------------------------------------------------------------------

function byNumber(
  field: string,
): (a: Record<string, unknown>, b: Record<string, unknown>) => number {
  return (a, b) => {
    const av = toNumber(a[field]);
    const bv = toNumber(b[field]);
    if (av == null && bv == null) return 0;
    if (av == null) return 1;
    if (bv == null) return -1;
    return av - bv;
  };
}

function toNumber(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    // Timestamps may arrive as ISO strings — coerce them.
    const n = Date.parse(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
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

type RunQueryResult = Array<{
  document?: {
    name?: string;
    fields?: Record<string, FirestoreValue>;
  };
}>;

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
