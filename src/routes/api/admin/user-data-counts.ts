import { createFileRoute } from "@tanstack/react-router";

import { corsPreflight, withCors } from "@/lib/api-cors";
import { getAccessToken, getProjectId, isAdminConfigured } from "@/lib/firebase/admin";
import { requireAdmin } from "@/lib/firebase/admin-guard";

/**
 * Per-user counts of every synced Firestore sub-collection under
 * `users/{uid}/<table>`. Powers the chip badges on the admin user-detail
 * Synced data section so the operator sees how much is in each table without
 * loading the rows.
 *
 * Admin-only. Mirrors the CORS + 503 pattern of the sibling admin routes.
 * POST body: `{ idToken, uid }`. Returns `{ counts: Record<string, number> }`.
 *
 * Strategy: Firestore `runAggregationQuery` with a COUNT() aggregation per
 * collection. One HTTP call per table, run in parallel.
 */

const SYNCED_TABLES = [
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
] as const;

export const Route = createFileRoute("/api/admin/user-data-counts")({
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
        try {
          const body = (await request.json()) as { uid?: string };
          uid = body.uid;
        } catch {
          return json({ error: "Invalid body" }, 400, request);
        }
        if (typeof uid !== "string" || uid.length === 0) {
          return json({ error: "Missing uid" }, 400, request);
        }

        try {
          const counts = await loadCounts(uid);
          return json({ counts }, 200, request);
        } catch (err) {
          console.error(
            "[api/admin/user-data-counts] load failed:",
            err instanceof Error ? err.message : "unknown",
          );
          return json({ error: "Couldn't load counts" }, 500, request);
        }
      },
    },
  },
});

// --------------------------------------------------------------------------
// Per-table COUNT via Firestore `runAggregationQuery`
// --------------------------------------------------------------------------

async function loadCounts(uid: string): Promise<Record<string, number>> {
  const token = await getAccessToken();
  if (!token) throw new Error("Couldn't mint a Firestore access token");

  const projectId = getProjectId();
  // Aggregation queries run against the parent document path; the collection
  // it counts is identified by the structuredAggregationQuery's `from`.
  const parent = `projects/${projectId}/databases/(default)/documents/users/${encodeURIComponent(uid)}`;
  const url = `https://firestore.googleapis.com/v1/${parent}:runAggregationQuery`;

  const results = await Promise.all(
    SYNCED_TABLES.map(async (table) => {
      const body = {
        structuredAggregationQuery: {
          structuredQuery: {
            from: [{ collectionId: table }],
          },
          aggregations: [{ alias: "count", count: {} }],
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
        // Treat per-table failures as zero so one missing collection doesn't
        // tank the whole response. Surface a server-log line for debugging.
        const text = await res.text().catch(() => "");
        console.warn(
          `[api/admin/user-data-counts] ${table} count failed: ${res.status} ${text.slice(0, 200)}`,
        );
        return [table, 0] as const;
      }
      const data = (await res.json()) as Array<{
        result?: {
          aggregateFields?: Record<string, { integerValue?: string; doubleValue?: number }>;
        };
      }>;
      let n = 0;
      for (const row of data) {
        const cf = row.result?.aggregateFields?.count;
        if (cf) {
          if (typeof cf.integerValue === "string") {
            const parsed = Number(cf.integerValue);
            if (Number.isFinite(parsed)) n = parsed;
          } else if (typeof cf.doubleValue === "number") {
            n = Math.round(cf.doubleValue);
          }
        }
      }
      return [table, n] as const;
    }),
  );

  const out: Record<string, number> = {};
  for (const [table, n] of results) out[table] = n;
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
