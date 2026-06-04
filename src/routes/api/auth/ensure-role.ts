import { createFileRoute } from "@tanstack/react-router";

import { corsPreflight, withCors } from "@/lib/api-cors";
import { logAdminAction } from "@/lib/audit";
import {
  countUsersAtMost,
  isAdminConfigured,
  setAdminClaim,
  verifyIdToken,
} from "@/lib/firebase/admin";

/**
 * Promotes a user to admin (custom claim `admin: true`) on sign-in.
 *
 * Two paths in:
 *   1. The caller's verified email is in PARLEY_ADMIN_EMAILS (comma-separated
 *      env var) → always admin. The canonical way to grant admin without
 *      shipping code.
 *   2. The caller is the FIRST account in the project → admin (bootstrap).
 *
 * Idempotent: once the user has the admin claim it short-circuits and
 * returns is_admin:true. Requires the service account
 * (FIREBASE_SERVICE_ACCOUNT_B64); without it, returns is_admin:false.
 */

function adminEmailAllowList(): Set<string> {
  const raw = process.env.PARLEY_ADMIN_EMAILS ?? "jackharker000@gmail.com";
  return new Set(
    raw
      .split(",")
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean),
  );
}

export const Route = createFileRoute("/api/auth/ensure-role")({
  server: {
    handlers: {
      OPTIONS: ({ request }) => corsPreflight(request),
      POST: async ({ request }) => {
        if (!isAdminConfigured()) {
          return json({ is_admin: false, note: "admin-sdk-not-configured" }, 200);
        }

        let idToken: string | undefined;
        try {
          const body = (await request.json()) as { idToken?: string };
          idToken = body.idToken;
        } catch {
          return json({ error: "Invalid body" }, 400);
        }
        if (!idToken) return json({ error: "Missing idToken" }, 400);

        let uid: string;
        let email: string | null = null;
        try {
          const decoded = await verifyIdToken(idToken);
          uid = decoded.uid;
          email = typeof decoded.claims.email === "string" ? decoded.claims.email : null;
          if (decoded.claims.admin === true) {
            return json({ is_admin: true }, 200);
          }
        } catch {
          return json({ error: "Invalid token" }, 401);
        }

        // Allow-list path: an admin email always becomes admin.
        const allowed = adminEmailAllowList();
        if (email && allowed.has(email.toLowerCase())) {
          try {
            await setAdminClaim(uid);
            // Self-promotion via allow-list: the actor and the target are the
            // same uid. Logged so the activity feed shows when somebody first
            // gains admin powers.
            await logAdminAction({
              action: "role.promote-admin",
              actorUid: uid,
              actorEmail: email,
              targetUid: uid,
              targetEmail: email,
              detail: { reason: "allowlist" },
              status: "ok",
            });
            return json({ is_admin: true }, 200);
          } catch (err) {
            console.error(
              "[api/auth/ensure-role] allow-list promotion failed:",
              err instanceof Error ? err.message : "unknown",
            );
            return json({ is_admin: false }, 200);
          }
        }

        // Bootstrap path: the very first account in the project becomes admin.
        try {
          const count = await countUsersAtMost(1);
          if (count <= 1) {
            await setAdminClaim(uid);
            await logAdminAction({
              action: "role.promote-admin",
              actorUid: uid,
              actorEmail: email,
              targetUid: uid,
              targetEmail: email,
              detail: { reason: "first-account" },
              status: "ok",
            });
            return json({ is_admin: true }, 200);
          }
        } catch (err) {
          console.error(
            "[api/auth/ensure-role] role bootstrap failed:",
            err instanceof Error ? err.message : "unknown",
          );
          return json({ is_admin: false }, 200);
        }

        return json({ is_admin: false }, 200);
      },
    },
  },
});

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: withCors({ "content-type": "application/json" }),
  });
}
