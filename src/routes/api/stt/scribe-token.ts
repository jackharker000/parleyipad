import { createFileRoute } from "@tanstack/react-router";

import { corsPreflight, requireClientToken, withCors } from "@/lib/api-cors";

/**
 * Mints a single-use ElevenLabs Scribe-realtime token. The browser then opens
 * `wss://api.elevenlabs.io/v1/speech-to-text/realtime?token=<token>&…` and
 * the real `xi-api-key` never leaves the server. This is the official
 * key-hiding mechanism for the browser — confirmed in the @elevenlabs/client
 * source and used by the legacy `@elevenlabs/react` `useScribe` hook.
 *
 * The endpoint is intentionally a thin proxy: validate the server has a key,
 * post to ElevenLabs's `/v1/single-use-token/realtime_scribe`, return the
 * one-shot token. Tokens are short-lived and bound to a single WS upgrade.
 */

const TOKEN_URL = "https://api.elevenlabs.io/v1/single-use-token/realtime_scribe";

export const Route = createFileRoute("/api/stt/scribe-token")({
  server: {
    handlers: {
      OPTIONS: ({ request }) => corsPreflight(request),
      POST: async ({ request }) => {
        const denied = requireClientToken(request);
        if (denied) return denied;

        const apiKey = process.env.ELEVENLABS_API_KEY;
        if (!apiKey) {
          return errorResponse(500, "ELEVENLABS_API_KEY not set on the server", request);
        }

        const upstream = await fetch(TOKEN_URL, {
          method: "POST",
          headers: {
            "xi-api-key": apiKey,
            "content-type": "application/json",
          },
          // The endpoint accepts an empty body. Posting `{}` keeps Content-Length
          // sane on proxies that dislike zero-byte POSTs.
          body: "{}",
        });

        if (!upstream.ok) {
          const text = await upstream.text();
          // Log upstream body server-side for debuggability, but never echo it
          // to the caller — it can include request ids, billing-org ids, and
          // (on auth errors) substrings of the API key.
          console.warn("[scribe-token] upstream", upstream.status, ":", text);
          return errorResponse(
            upstream.status,
            `Scribe token returned ${upstream.status}`,
            request,
          );
        }

        const data = (await upstream.json()) as { token?: string };
        if (!data.token) {
          return errorResponse(502, "Scribe token endpoint returned no token", request);
        }

        return Response.json({ token: data.token }, { headers: withCors({}, request) });
      },
    },
  },
});

function errorResponse(status: number, error: string, request?: Request): Response {
  return new Response(JSON.stringify({ error }), {
    status,
    headers: withCors({ "content-type": "application/json" }, request),
  });
}
