import { createFileRoute } from "@tanstack/react-router";

import { corsPreflight, withCors } from "@/lib/api-cors";
import { getUserByUid, isAdminConfigured } from "@/lib/firebase/admin";
import { requireAdmin } from "@/lib/firebase/admin-guard";

/**
 * Returns a single account by uid (cross-device). Admin-only. POST body:
 * `{ idToken, uid }`.
 */

export const Route = createFileRoute("/api/admin/user")({
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
        if (!uid) return json({ error: "Missing uid" }, 400, request);

        try {
          const user = await getUserByUid(uid);
          if (!user) return json({ error: "User not found" }, 404, request);
          return json({ user }, 200, request);
        } catch {
          return json({ error: "User not found" }, 404, request);
        }
      },
    },
  },
});

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
