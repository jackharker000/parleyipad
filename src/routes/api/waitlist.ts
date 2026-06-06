import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";

import { corsPreflight, requireClientToken, withCors } from "@/lib/api-cors";

/**
 * Waitlist intake. Forwards each signup to the operator's inbox
 * (jackharker000@gmail.com) via Resend's HTTP API. No database; no
 * client-side persistence. The form completes either way — if
 * RESEND_API_KEY isn't set (local dev) we log a non-PII line and return
 * ok so the marketing flow stays unblocked.
 *
 * Env vars:
 *   RESEND_API_KEY     server-only. Get one from https://resend.com.
 *   RESEND_FROM_EMAIL  server-only. From-address on Resend's verified
 *                      domain. Defaults to "Parley <hello@parley.help>"
 *                      so a working setup with the parley.help domain
 *                      verified in Resend needs no extra config.
 *
 * Only place the recipient ever appears is this file — change it here
 * if the operator changes hands.
 */

const RECIPIENT = "jackharker000@gmail.com";
const DEFAULT_FROM = "Parley <hello@parley.help>";

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
          // Surface a field-specific message instead of the opaque "Invalid
          // body" — the most common failure is a malformed email, and the
          // user needs to know what to fix.
          return jsonResponse(
            { ok: false, error: firstValidationMessage(parsed.error) },
            400,
            request,
          );
        }

        const { name, email, about } = parsed.data;

        const apiKey = process.env.RESEND_API_KEY;
        if (!apiKey) {
          // Local dev path — log the domain (not PII) so the operator can
          // see traffic without persisting anything, and acknowledge the
          // submission so the form completes normally.
          const domain = email.split("@")[1] ?? "unknown";
          console.info(`[api/waitlist] received signup (domain: ${domain})`);
          console.info(
            "[api/waitlist] RESEND_API_KEY not set — submission was not emailed",
          );
          return jsonResponse({ ok: true }, 200, request);
        }

        try {
          await sendViaResend({
            apiKey,
            from: process.env.RESEND_FROM_EMAIL ?? DEFAULT_FROM,
            to: RECIPIENT,
            // The submitter's email goes on Reply-To so a single tap from
            // the inbox opens a reply straight back to them.
            replyTo: email,
            subject: `New Parley waitlist signup — ${name}`,
            html: renderHtml({ name, email, about }),
            text: renderText({ name, email, about }),
          });
        } catch (err) {
          // Log only the error message — never the request body.
          console.error(
            `[api/waitlist] resend send failed: ${(err as Error).message}`,
          );
          return jsonResponse(
            { ok: false, error: "Couldn't send your request" },
            500,
            request,
          );
        }

        return jsonResponse({ ok: true }, 200, request);
      },
    },
  },
});

async function sendViaResend(opts: {
  apiKey: string;
  from: string;
  to: string;
  replyTo: string;
  subject: string;
  html: string;
  text: string;
}): Promise<void> {
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      authorization: `Bearer ${opts.apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      from: opts.from,
      to: [opts.to],
      reply_to: opts.replyTo,
      subject: opts.subject,
      html: opts.html,
      text: opts.text,
    }),
  });
  if (!res.ok) {
    let detail = "";
    try {
      const body = (await res.json()) as { message?: string };
      detail = body.message ? `: ${body.message}` : "";
    } catch {
      /* ignore non-JSON error bodies */
    }
    throw new Error(`Resend HTTP ${res.status}${detail}`);
  }
}

function renderText(opts: { name: string; email: string; about: string }): string {
  const aboutBlock = opts.about ? `\n\nAbout:\n${opts.about}` : "";
  return `New Parley waitlist signup\n\nName: ${opts.name}\nEmail: ${opts.email}${aboutBlock}\n\nReply to this email to write back to them.\n`;
}

function renderHtml(opts: { name: string; email: string; about: string }): string {
  const safeName = escapeHtml(opts.name);
  const safeEmail = escapeHtml(opts.email);
  const aboutBlock = opts.about
    ? `<p style="margin: 16px 0 0;"><strong>About:</strong></p><pre style="white-space: pre-wrap; font-family: inherit; margin: 6px 0 0;">${escapeHtml(opts.about)}</pre>`
    : "";
  return `<!doctype html><html><body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; color: #222; line-height: 1.5;">
  <p style="margin: 0 0 12px;"><strong>New Parley waitlist signup</strong></p>
  <p style="margin: 0;"><strong>Name:</strong> ${safeName}</p>
  <p style="margin: 4px 0 0;"><strong>Email:</strong> <a href="mailto:${safeEmail}">${safeEmail}</a></p>
  ${aboutBlock}
  <p style="margin: 24px 0 0; color: #555; font-size: 13px;">Reply to this email to write back to them.</p>
</body></html>`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Map the first Zod validation issue to a friendly, field-specific message.
 * The form only has three fields, so the mapping is tiny and explicit.
 */
function firstValidationMessage(error: z.ZodError): string {
  const issue = error.issues[0];
  const field = issue?.path?.[0];
  if (field === "email") return "Please enter a valid email address.";
  if (field === "name") return "Please enter your name.";
  if (field === "about") return "That message is too long — please shorten it.";
  return "Please check the form and try again.";
}

function jsonResponse(body: unknown, status: number, request?: Request): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: withCors({ "content-type": "application/json" }, request),
  });
}
