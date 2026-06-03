import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";

import { corsPreflight, requireClientToken, withCors } from "@/lib/api-cors";

/**
 * Waitlist intake endpoint. Validates a name/email/about triple and ACKs it.
 *
 * There is no third-party backend in this build (auth + app data are all
 * on-device), so there is nowhere server-side to persist a public visitor's
 * submission. We validate, log a minimal non-PII line, and return success so
 * the form completes. Wiring this to a real store (email forward, a managed
 * DB, etc.) is a separate, future piece of work — see docs/setup.md.
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
          return jsonResponse({ ok: false, error: "Invalid body" }, 400);
        }

        const parsed = BodySchema.safeParse(raw);
        if (!parsed.success) {
          return jsonResponse({ ok: false, error: "Invalid body" }, 400);
        }

        // No backend store in this build — acknowledge without persisting.
        // Log only the email domain so the owner can see interest without
        // capturing PII in server logs.
        const domain = parsed.data.email.split("@")[1] ?? "unknown";
        console.info(`[api/waitlist] received signup (domain: ${domain})`);

        return jsonResponse({ ok: true }, 200);
      },
    },
  },
});

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: withCors({ "content-type": "application/json" }),
  });
}
