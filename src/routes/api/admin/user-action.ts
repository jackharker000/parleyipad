import { createFileRoute } from "@tanstack/react-router";

import { corsPreflight, withCors } from "@/lib/api-cors";
import { logAdminAction } from "@/lib/audit";
import type { AdminAction } from "@/lib/audit-types";
import {
  getAccessToken,
  getProjectId,
  getStorageBucket,
  isAdminConfigured,
  verifyIdToken,
} from "@/lib/firebase/admin";
import { requireAdmin } from "@/lib/firebase/admin-guard";

/**
 * Destructive admin operations against a Firebase Auth account.
 *
 *   revoke-admin → clears the `admin` custom claim
 *   disable      → marks the account disabled (login refused)
 *   enable       → un-marks it
 *   delete       → deletes the auth account + best-effort wipes the user's
 *                  Firestore subtree and Storage prefix
 *
 * Admin-only. Mirrors the CORS + 503 pattern of the sibling admin routes.
 * Self-protection: the caller cannot delete their own account through this
 * endpoint (the UI would also catch this, but the server is the trust
 * boundary).
 *
 * POST body: `{ idToken, uid, action }`.
 * Returns: `{ ok: true, partial?: boolean }` — `partial` is true on `delete`
 * when the auth account was removed but the Firestore/Storage wipe didn't
 * fully complete.
 */

type Action = "revoke-admin" | "disable" | "enable" | "delete";

const VALID_ACTIONS: ReadonlySet<Action> = new Set([
  "revoke-admin",
  "disable",
  "enable",
  "delete",
]);

const DATA_TABLES = [
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

export const Route = createFileRoute("/api/admin/user-action")({
  server: {
    handlers: {
      OPTIONS: ({ request }) => corsPreflight(request),
      POST: async ({ request }) => {
        if (!isAdminConfigured()) {
          return json({ error: "Admin features not configured on the server" }, 503, request);
        }

        // Pull the caller's email from their verified ID token BEFORE
        // requireAdmin so we can log it on success and on failure. requireAdmin
        // re-verifies independently — the duplicated parse is cheap and keeps
        // the guard contract unchanged.
        const actorClaims = await readActorClaims(request);

        const guard = await requireAdmin(request);
        if (guard instanceof Response) return withCorsResponse(guard, request);
        const callerUid = guard.uid;
        const actorUid = actorClaims?.uid ?? callerUid;
        const actorEmail = actorClaims?.email ?? null;

        let uid: string | undefined;
        let action: Action | undefined;
        try {
          const body = (await request.json()) as { uid?: string; action?: string };
          uid = body.uid;
          if (body.action && VALID_ACTIONS.has(body.action as Action)) {
            action = body.action as Action;
          }
        } catch {
          return json({ error: "Invalid body" }, 400, request);
        }
        if (typeof uid !== "string" || uid.length === 0) {
          return json({ error: "Missing uid" }, 400, request);
        }
        if (!action) {
          return json({ error: "Unknown action" }, 400, request);
        }
        if (action === "delete" && uid === callerUid) {
          return json({ error: "Refusing to delete your own account" }, 400, request);
        }
        // Self-protection for the other destructive actions too — same
        // shape as delete. Revoke-admin would lock the operator out of
        // /admin/* until a re-promotion via PARLEY_ADMIN_EMAILS;
        // disable would lock them out of sign-in entirely.
        if (action === "revoke-admin" && uid === callerUid) {
          return json({ error: "Refusing to revoke your own admin claim" }, 400, request);
        }
        if (action === "disable" && uid === callerUid) {
          return json({ error: "Refusing to disable your own account" }, 400, request);
        }

        // Look up the target's email upfront so we can log it even after a
        // delete (which removes the account). Best-effort — a missing email
        // is fine, the log still carries the uid.
        const targetEmail = await lookupEmail(uid);

        try {
          if (action === "revoke-admin") {
            await accountsUpdate({ localId: uid, customAttributes: "{}" });
            await logAdminAction({
              action: "user.revoke-admin",
              actorUid,
              actorEmail,
              targetUid: uid,
              targetEmail,
              status: "ok",
            });
            return json({ ok: true }, 200, request);
          }
          if (action === "disable") {
            await accountsUpdate({ localId: uid, disableUser: true });
            await logAdminAction({
              action: "user.disable",
              actorUid,
              actorEmail,
              targetUid: uid,
              targetEmail,
              status: "ok",
            });
            return json({ ok: true }, 200, request);
          }
          if (action === "enable") {
            await accountsUpdate({ localId: uid, disableUser: false });
            await logAdminAction({
              action: "user.enable",
              actorUid,
              actorEmail,
              targetUid: uid,
              targetEmail,
              status: "ok",
            });
            return json({ ok: true }, 200, request);
          }
          // delete: auth first, then best-effort data wipe.
          await accountsDelete(uid);
          const dataOk = await bestEffortWipeUserData(uid);
          await logAdminAction({
            action: "user.delete",
            actorUid,
            actorEmail,
            targetUid: uid,
            targetEmail,
            status: dataOk ? "ok" : "partial",
            detail: dataOk ? undefined : { partial: true },
          });
          return json({ ok: true, partial: !dataOk }, 200, request);
        } catch (err) {
          const errorMessage = err instanceof Error ? err.message : "unknown";
          console.error("[api/admin/user-action] failed:", errorMessage);
          await logAdminAction({
            action: mapAction(action),
            actorUid,
            actorEmail,
            targetUid: uid,
            targetEmail,
            status: "error",
            errorMessage: errorMessage.slice(0, 500),
          });
          return json({ error: "Action failed" }, 500, request);
        }
      },
    },
  },
});

// --------------------------------------------------------------------------
// Audit-trail helpers — read the actor's ID-token claims so we can log who
// did what, and translate the route's internal action union to the audit
// AdminAction shape.
// --------------------------------------------------------------------------

/**
 * Decode the caller's ID token a second time so we can capture their email
 * for the audit log. requireAdmin doesn't expose the decoded claims and we
 * don't want to change its contract. Returns null on any failure so the
 * audit log just records the uid (which requireAdmin already gives us).
 */
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

/**
 * Best-effort email lookup for the target uid. Returns null on any failure
 * so the audit log just carries the uid (the uid is the primary key — the
 * email is decoration).
 */
async function lookupEmail(uid: string): Promise<string | null> {
  try {
    const res = await authed(`${idToolkitBase()}/accounts:lookup`, {
      localId: [uid],
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { users?: Array<{ email?: string }> };
    const email = data.users?.[0]?.email;
    return typeof email === "string" && email.length > 0 ? email : null;
  } catch {
    return null;
  }
}

function mapAction(action: Action): AdminAction {
  switch (action) {
    case "revoke-admin":
      return "user.revoke-admin";
    case "disable":
      return "user.disable";
    case "enable":
      return "user.enable";
    case "delete":
      return "user.delete";
  }
}

// --------------------------------------------------------------------------
// Identity Toolkit (account ops)
// --------------------------------------------------------------------------

function idToolkitBase(): string {
  return `https://identitytoolkit.googleapis.com/v1/projects/${getProjectId()}`;
}

async function authed(url: string, body: unknown): Promise<Response> {
  const token = await getAccessToken();
  return fetch(url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

async function accountsUpdate(body: Record<string, unknown>): Promise<void> {
  const res = await authed(`${idToolkitBase()}/accounts:update`, {
    ...body,
    returnSecureToken: false,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`accounts:update failed: ${res.status} ${text.slice(0, 200)}`);
  }
}

async function accountsDelete(uid: string): Promise<void> {
  const res = await authed(`${idToolkitBase()}/accounts:delete`, { localId: uid });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`accounts:delete failed: ${res.status} ${text.slice(0, 200)}`);
  }
}

// --------------------------------------------------------------------------
// Best-effort Firestore + Storage wipe for users/{uid}/**
// --------------------------------------------------------------------------

/**
 * Best-effort delete of the user's data. Returns true if everything was wiped
 * cleanly, false if any sub-step errored (so callers can mark the response
 * `partial`). Never throws — the auth account is already gone, so a partial
 * wipe is better than 500-ing.
 */
async function bestEffortWipeUserData(uid: string): Promise<boolean> {
  let ok = true;
  try {
    const docCleanOk = await deleteFirestoreSubtree(uid);
    if (!docCleanOk) ok = false;
  } catch (err) {
    console.warn(
      "[api/admin/user-action] firestore wipe error:",
      err instanceof Error ? err.message : "unknown",
    );
    ok = false;
  }
  try {
    const storageOk = await deleteStoragePrefix(uid);
    if (!storageOk) ok = false;
  } catch (err) {
    console.warn(
      "[api/admin/user-action] storage wipe error:",
      err instanceof Error ? err.message : "unknown",
    );
    ok = false;
  }
  return ok;
}

async function deleteFirestoreSubtree(uid: string): Promise<boolean> {
  const token = await getAccessToken();
  const projectId = getProjectId();
  const base = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents`;
  let allOk = true;

  for (const table of DATA_TABLES) {
    let pageToken: string | undefined;
    // Page through the collection; delete each doc by name.
    // Capped at a sane number of iterations to avoid runaway loops.
    for (let i = 0; i < 50; i += 1) {
      const url = new URL(
        `${base}/users/${encodeURIComponent(uid)}/${encodeURIComponent(table)}`,
      );
      url.searchParams.set("pageSize", "300");
      if (pageToken) url.searchParams.set("pageToken", pageToken);
      const res = await fetch(url.toString(), {
        headers: { authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        if (res.status === 404) break;
        allOk = false;
        break;
      }
      const data = (await res.json()) as {
        documents?: Array<{ name?: string }>;
        nextPageToken?: string;
      };
      const docs = data.documents ?? [];
      if (docs.length === 0) break;
      await Promise.all(
        docs.map(async (doc) => {
          if (!doc.name) return;
          const delRes = await fetch(`https://firestore.googleapis.com/v1/${doc.name}`, {
            method: "DELETE",
            headers: { authorization: `Bearer ${token}` },
          });
          if (!delRes.ok && delRes.status !== 404) allOk = false;
        }),
      );
      pageToken = data.nextPageToken;
      if (!pageToken) break;
    }
  }

  // Finally, delete the parent users/{uid} doc itself (it's effectively empty
  // once the sub-collections are gone, but Firestore lets us hit it directly).
  try {
    const parentRes = await fetch(
      `${base}/users/${encodeURIComponent(uid)}`,
      {
        method: "DELETE",
        headers: { authorization: `Bearer ${token}` },
      },
    );
    if (!parentRes.ok && parentRes.status !== 404) allOk = false;
  } catch {
    allOk = false;
  }

  return allOk;
}

async function deleteStoragePrefix(uid: string): Promise<boolean> {
  const token = await getAccessToken();
  const bucket = getStorageBucket();
  const prefix = `users/${uid}/`;
  let allOk = true;
  let pageToken: string | undefined;

  // List + delete in chunks. Cap iterations as a safety net.
  for (let i = 0; i < 50; i += 1) {
    const url = new URL(
      `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(bucket)}/o`,
    );
    url.searchParams.set("prefix", prefix);
    url.searchParams.set("maxResults", "500");
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    const res = await fetch(url.toString(), {
      headers: { authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      if (res.status === 404) break;
      allOk = false;
      break;
    }
    const data = (await res.json()) as {
      items?: Array<{ name?: string }>;
      nextPageToken?: string;
    };
    const items = data.items ?? [];
    if (items.length === 0) break;
    await Promise.all(
      items.map(async (item) => {
        if (!item.name) return;
        const delRes = await fetch(
          `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(bucket)}/o/${encodeURIComponent(item.name)}`,
          {
            method: "DELETE",
            headers: { authorization: `Bearer ${token}` },
          },
        );
        if (!delRes.ok && delRes.status !== 404) allOk = false;
      }),
    );
    pageToken = data.nextPageToken;
    if (!pageToken) break;
  }

  return allOk;
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
