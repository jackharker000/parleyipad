import { createFileRoute } from "@tanstack/react-router";

import { corsPreflight, withCors } from "@/lib/api-cors";
import { logAdminAction } from "@/lib/audit";
import type { AdminAction } from "@/lib/audit-types";
import {
  getAccessToken,
  getProjectId,
  isAdminConfigured,
  verifyIdToken,
} from "@/lib/firebase/admin";
import { requireAdmin } from "@/lib/firebase/admin-guard";

/**
 * Admin → Waitlist action. Mutates a single waitlist entry via Firestore REST.
 *
 *   action: "onboarded" → PATCH status="onboarded", onboardedAt=now
 *   action: "archive"   → PATCH status="archived"
 *   action: "delete"    → DELETE the doc
 *
 * Admin-only. Mirrors the CORS + 503 pattern of the sibling admin routes.
 * Body: `{ idToken, id, action }`.
 */

type Action = "onboarded" | "archive" | "delete";

export const Route = createFileRoute("/api/admin/waitlist-action")({
  server: {
    handlers: {
      OPTIONS: ({ request }) => corsPreflight(request),
      POST: async ({ request }) => {
        if (!isAdminConfigured()) {
          return json({ error: "Admin features not configured on the server" }, 503);
        }

        // Decode the actor's ID token before the guard so we can log who did
        // what even when the action itself throws. requireAdmin re-verifies
        // — the duplicated parse is cheap.
        const actorClaims = await readActorClaims(request);

        const guard = await requireAdmin(request);
        if (guard instanceof Response) return withCorsResponse(guard);
        const actorUid = actorClaims?.uid ?? guard.uid;
        const actorEmail = actorClaims?.email ?? null;

        let id: string | undefined;
        let action: Action | undefined;
        try {
          const body = (await request.json()) as { id?: string; action?: string };
          id = body.id;
          if (
            body.action === "onboarded" ||
            body.action === "archive" ||
            body.action === "delete"
          ) {
            action = body.action;
          }
        } catch {
          return json({ error: "Invalid body" }, 400);
        }

        if (typeof id !== "string" || id.length === 0) {
          return json({ error: "Missing id" }, 400);
        }
        if (!action) {
          return json({ error: "Unknown action" }, 400);
        }

        try {
          await applyAction(id, action);
          await logAdminAction({
            action: mapAction(action),
            actorUid,
            actorEmail,
            targetUid: null,
            detail: { waitlistId: id, action },
            status: "ok",
          });
          return json({ ok: true }, 200);
        } catch (err) {
          const errorMessage = err instanceof Error ? err.message : "unknown";
          console.error("[api/admin/waitlist-action] failed:", errorMessage);
          await logAdminAction({
            action: mapAction(action),
            actorUid,
            actorEmail,
            targetUid: null,
            detail: { waitlistId: id, action },
            status: "error",
            errorMessage: errorMessage.slice(0, 500),
          });
          return json({ error: "Couldn't update waitlist entry" }, 500);
        }
      },
    },
  },
});

// --------------------------------------------------------------------------
// Audit helpers — same pattern as user-action.ts so the actor's email shows
// up in /admin/activity for every waitlist mutation.
// --------------------------------------------------------------------------

async function readActorClaims(
  request: Request,
): Promise<{ uid: string; email: string | null } | null> {
  let idToken: string | undefined;
  try {
    const body = (await request.clone().json()) as { idToken?: string };
    idToken = body.idToken;
  } catch {
    idToken = undefined;
  }
  if (!idToken) {
    const authz = request.headers.get("authorization");
    if (authz?.startsWith("Bearer ")) idToken = authz.slice(7);
  }
  if (!idToken) return null;
  try {
    const decoded = await verifyIdToken(idToken);
    const email =
      typeof decoded.claims.email === "string" ? decoded.claims.email : null;
    return { uid: decoded.uid, email };
  } catch {
    return null;
  }
}

function mapAction(action: Action): AdminAction {
  switch (action) {
    case "onboarded":
      return "waitlist.onboarded";
    case "archive":
      return "waitlist.archive";
    case "delete":
      return "waitlist.delete";
  }
}

async function applyAction(id: string, action: Action): Promise<void> {
  const token = await getAccessToken();
  const docUrl = `https://firestore.googleapis.com/v1/projects/${getProjectId()}/databases/(default)/documents/waitlist/${encodeURIComponent(id)}`;

  if (action === "delete") {
    const res = await fetch(docUrl, {
      method: "DELETE",
      headers: { authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Firestore delete failed: ${res.status} ${text.slice(0, 200)}`);
    }
    return;
  }

  // PATCH with updateMask so we only touch the fields we name.
  const status = action === "onboarded" ? "onboarded" : "archived";
  const fields: Record<string, { stringValue?: string; timestampValue?: string }> = {
    status: { stringValue: status },
  };
  const maskParams = new URLSearchParams();
  maskParams.append("updateMask.fieldPaths", "status");
  if (action === "onboarded") {
    fields.onboardedAt = { timestampValue: new Date().toISOString() };
    maskParams.append("updateMask.fieldPaths", "onboardedAt");
  }

  const url = `${docUrl}?${maskParams.toString()}`;
  const res = await fetch(url, {
    method: "PATCH",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ fields }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Firestore patch failed: ${res.status} ${text.slice(0, 200)}`);
  }
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
