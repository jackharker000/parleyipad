import { createFileRoute } from "@tanstack/react-router";

import { corsPreflight, withCors } from "@/lib/api-cors";
import { getAccessToken, getProjectId, isAdminConfigured } from "@/lib/firebase/admin";
import { requireAdmin } from "@/lib/firebase/admin-guard";

/**
 * Admin → Waitlist list. Reads the `waitlist` Firestore collection (project
 * root) and returns the decoded entries newest-first.
 *
 * Admin-only. Mirrors `/api/admin/usage` for CORS + the 503-if-not-configured
 * guard. POST so the ID token travels in the body, not the URL.
 *
 * Body: `{ idToken }`.
 */

export const Route = createFileRoute("/api/admin/waitlist")({
  server: {
    handlers: {
      OPTIONS: ({ request }) => corsPreflight(request),
      POST: async ({ request }) => {
        if (!isAdminConfigured()) {
          return json({ error: "Admin features not configured on the server" }, 503, request);
        }
        const guard = await requireAdmin(request);
        if (guard instanceof Response) return withCorsResponse(guard, request);

        try {
          const entries = await queryWaitlist();
          return json({ entries }, 200, request);
        } catch (err) {
          console.error(
            "[api/admin/waitlist] load failed:",
            err instanceof Error ? err.message : "unknown",
          );
          return json({ error: "Couldn't load waitlist" }, 500, request);
        }
      },
    },
  },
});

// --------------------------------------------------------------------------
// Firestore REST runQuery — waitlist
// --------------------------------------------------------------------------

export type WaitlistEntry = {
  id: string;
  name: string;
  email: string;
  about: string;
  createdAt: string | null;
  status: string | null;
  onboardedAt: string | null;
};

type RunQueryResult = Array<{
  document?: {
    name?: string;
    fields?: Record<string, FirestoreValue>;
  };
}>;

async function queryWaitlist(): Promise<WaitlistEntry[]> {
  const token = await getAccessToken();
  const url = `https://firestore.googleapis.com/v1/projects/${getProjectId()}/databases/(default)/documents:runQuery`;
  const body = {
    structuredQuery: {
      from: [{ collectionId: "waitlist" }],
      orderBy: [
        {
          field: { fieldPath: "createdAt" },
          direction: "DESCENDING",
        },
      ],
      limit: 500,
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
    throw new Error(`runQuery failed: ${res.status} ${text.slice(0, 200)}`);
  }

  const rows = (await res.json()) as RunQueryResult;
  const out: WaitlistEntry[] = [];
  for (const row of rows) {
    const doc = row.document;
    if (!doc?.fields) continue;
    const decoded = decode(doc.fields);
    out.push({
      id: docIdFromName(doc.name),
      name: typeof decoded.name === "string" ? decoded.name : "",
      email: typeof decoded.email === "string" ? decoded.email : "",
      about: typeof decoded.about === "string" ? decoded.about : "",
      createdAt:
        typeof decoded.createdAt === "string" ? (decoded.createdAt as string) : null,
      status: typeof decoded.status === "string" ? (decoded.status as string) : null,
      onboardedAt:
        typeof decoded.onboardedAt === "string"
          ? (decoded.onboardedAt as string)
          : null,
    });
  }
  return out;
}

function docIdFromName(name: string | undefined): string {
  if (!name) return "";
  const slash = name.lastIndexOf("/");
  return slash >= 0 ? name.slice(slash + 1) : name;
}

// --------------------------------------------------------------------------
// Firestore JSON-form decode (mirrors user-data.ts — same shapes).
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
