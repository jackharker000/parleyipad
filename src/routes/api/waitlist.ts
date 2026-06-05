import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";

import { corsPreflight, requireClientToken, withCors } from "@/lib/api-cors";
import { addWaitlistEntry, isAdminConfigured } from "@/lib/firebase/admin";

/**
 * Waitlist intake endpoint. Validates a name/email/about triple and persists
 * it to Firestore via the Firebase Admin SDK (server-only credential).
 *
 * When the service account isn't configured (e.g. local dev without
 * FIREBASE_SERVICE_ACCOUNT_B64) there's nowhere server-side to write to, so we
 * fall back to validating + acknowledging without persisting, and log a
 * minimal non-PII line. The form still completes either way. See docs/setup.md.
 */

const BodySchema = z.object({
  name: z.string().trim().min(1).max(200),
  email: z.string().trim().email().max(320),
  about: z.string().trim().max(2000).optional().default(""),
});

export const Route = createFileRoute("/api/waitlist")({
  server: {
    handlers: {
      OPTIONS: ({ request }) => corsPreflight(request),
      POST: async ({ request }) => {
        const denied = requireClientToken(request);
        if (denied) return denied;

        let raw: unknown;
        try {
          raw = await request.json();
        } catch {
          return jsonResponse({ ok: false, error: "Invalid body" }, 400, request);
        }

        const parsed = BodySchema.safeParse(raw);
        if (!parsed.success) {
          return jsonResponse({ ok: false, error: "Invalid body" }, 400, request);
        }

        const { name, email, about } = parsed.data;

        // No service account configured (e.g. local dev) — acknowledge without
        // persisting. Log only the email domain so the owner can see interest
        // without capturing PII in server logs.
        if (!isAdminConfigured()) {
          const domain = email.split("@")[1] ?? "unknown";
          console.info(`[api/waitlist] received signup (domain: ${domain})`);
          console.info(
            "[api/waitlist] FIREBASE_SERVICE_ACCOUNT_B64 not set — submission was not persisted",
          );
          return jsonResponse({ ok: true }, 200, request);
        }

        // Persist to Firestore via the REST API (service-account token).
        try {
          await addWaitlistEntry({ name, email, about });
        } catch (err) {
          // Log only the error message — never the request body / PII.
          console.error(
            `[api/waitlist] failed to persist signup: ${(err as Error).message}`,
          );
          return jsonResponse({ ok: false, error: "Couldn't save your request" }, 500, request);
        }

        return jsonResponse({ ok: true }, 200, request);
      },
    },
  },
});

function jsonResponse(body: unknown, status: number, request?: Request): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: withCors({ "content-type": "application/json" }, request),
  });
}
