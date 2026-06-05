import { createFileRoute } from "@tanstack/react-router";

import { corsPreflight, withCors } from "@/lib/api-cors";
import { getAccessToken, getProjectId, isAdminConfigured } from "@/lib/firebase/admin";
import { requireAdmin } from "@/lib/firebase/admin-guard";

/**
 * Aggregate of unrecovered sync errors per user across the last 24 hours.
 * Drives the "Users with sync errors" widget on /admin and the "Sync issues"
 * filter + column on /admin/users — without it the Users page would have
 * to fan out one fetchUserDataCounts call per visible user, which is too
 * many round trips for a page that shows the full account list.
 *
 * Admin-only. Mirrors the CORS + 503 pattern of the sibling admin routes.
 * POST body: `{ idToken }`. Returns `{ counts: Record<string, number> }`,
 * keyed by uid.
 *
 * Implementation note: this is a Firestore collectionGroup query against
 * the `syncErrors` collection. That requires a collection-group index in
 * the project — see `docs/setup.md`. If the index is missing, Firestore
 * returns FAILED_PRECONDITION; we treat that as "no users have errors"
 * (return empty counts) so the dashboard never reads as broken.
 */

const WINDOW_MS = 24 * 60 * 60 * 1000;

export const Route = createFileRoute("/api/admin/sync-errors-summary")({
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
          const counts = await loadSummary();
          return json({ counts }, 200, request);
        } catch (err) {
          console.error(
            "[api/admin/sync-errors-summary] load failed:",
            err instanceof Error ? err.message : "unknown",
          );
          return json({ error: "Couldn't load sync errors summary" }, 500, request);
        }
      },
    },
  },
});

// --------------------------------------------------------------------------
// Firestore REST — collectionGroup query against `syncErrors`
// --------------------------------------------------------------------------

async function loadSummary(): Promise<Record<string, number>> {
  const token = await getAccessToken();
  const projectId = getProjectId();
  const url = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents:runQuery`;

  const cutoffIso = new Date(Date.now() - WINDOW_MS).toISOString();

  const body = {
    structuredQuery: {
      from: [{ collectionId: "syncErrors", allDescendants: true }],
      where: {
        compositeFilter: {
          op: "AND",
          filters: [
            {
              fieldFilter: {
                field: { fieldPath: "recovered" },
                op: "EQUAL",
                value: { booleanValue: false },
              },
            },
            {
              fieldFilter: {
                field: { fieldPath: "createdAt" },
                op: "GREATER_THAN_OR_EQUAL",
                // SyncError.createdAt is a number (epoch ms) in the local
                // schema; the sync engine writes it as-is, so Firestore
                // stores it as an integer. We compare against a number too.
                value: { integerValue: String(Date.now() - WINDOW_MS) },
              },
            },
          ],
        },
      },
      orderBy: [
        { field: { fieldPath: "createdAt" }, direction: "DESCENDING" },
      ],
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
    // FAILED_PRECONDITION → index isn't built yet. Surface empty counts
    // so the dashboard renders zero rather than an error toast.
    if (res.status === 400 && /FAILED_PRECONDITION|requires an index/i.test(text)) {
      console.warn(
        "[api/admin/sync-errors-summary] missing Firestore index — returning empty counts. " +
          "Create a collection-group index on syncErrors (recovered ASC, createdAt DESC). " +
          "See docs/setup.md.",
      );
      return {};
    }
    throw new Error(`Firestore runQuery failed: ${res.status} ${text.slice(0, 200)}`);
  }

  const rows = (await res.json()) as Array<{
    document?: { name?: string };
  }>;

  // The document path is `projects/<project>/databases/(default)/documents/users/<uid>/syncErrors/<id>`.
  // Pull the uid out and tally.
  const counts: Record<string, number> = {};
  for (const row of rows) {
    const name = row.document?.name;
    if (!name) continue;
    const uid = extractUidFromPath(name);
    if (!uid) continue;
    counts[uid] = (counts[uid] ?? 0) + 1;
  }
  // Defence: cutoff is recomputed for the log line so any clock drift
  // between request start and now doesn't sneak misleading numbers in.
  void cutoffIso;
  return counts;
}

/**
 * `projects/<p>/databases/(default)/documents/users/<uid>/syncErrors/<docId>`
 * → `<uid>` (or null if the path doesn't match the expected shape).
 */
function extractUidFromPath(docPath: string): string | null {
  const marker = "/documents/users/";
  const start = docPath.indexOf(marker);
  if (start < 0) return null;
  const rest = docPath.slice(start + marker.length);
  const slash = rest.indexOf("/");
  if (slash < 0) return null;
  const uid = rest.slice(0, slash);
  return uid.length > 0 ? uid : null;
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
