import { createFileRoute } from "@tanstack/react-router";

import { corsPreflight, withCors } from "@/lib/api-cors";
import { isAdminConfigured, listAllUsers } from "@/lib/firebase/admin";
import { requireAdmin } from "@/lib/firebase/admin-guard";

/**
 * Lists every account in the Firebase project (cross-device). Admin-only:
 * verifies the caller's ID token carries the `admin` claim before returning
 * anything. POST so the ID token travels in the body, not the URL.
 */

export const Route = createFileRoute("/api/admin/users")({
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
          const users = await listAllUsers();
          return json({ users }, 200, request);
        } catch (err) {
          console.error(
            "[api/admin/users] list failed:",
            err instanceof Error ? err.message : "unknown",
          );
          return json({ error: "Couldn't list users" }, 500, request);
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
