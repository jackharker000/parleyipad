import { createFileRoute } from "@tanstack/react-router";

import { corsPreflight, requireClientToken, withCors } from "@/lib/api-cors";

/**
 * Cartesia Sonic 3 streaming TTS proxy — the latency fallback to
 * ElevenLabs Flash. Same browser-facing contract as the ElevenLabs
 * route so the TTSProvider swap is a one-line settings change.
 *
 * Cartesia's REST streaming endpoint returns raw audio chunks; we
 * forward them straight through.
 */

const CARTESIA_URL = "https://api.cartesia.ai/tts/bytes";
const CARTESIA_VERSION = "2024-11-13";
const DEFAULT_MODEL = "sonic-3";

// Upstream timeout — mirrors the ElevenLabs TTS route. Bounds connect + the
// whole streamed body so a hung Cartesia stream errors the client reader
// instead of leaving James on a half-spoken phrase.
const UPSTREAM_TIMEOUT_MS = 15_000;

type RequestBody = {
  text: string;
  voiceId?: string;
};

export const Route = createFileRoute("/api/tts/cartesia")({
  server: {
    handlers: {
      OPTIONS: ({ request }) => corsPreflight(request),
      POST: async ({ request }) => {
        const denied = requireClientToken(request);
        if (denied) return denied;

        const apiKey = process.env.CARTESIA_API_KEY;
        if (!apiKey) return errorResponse(500, "CARTESIA_API_KEY not set on the server");

        let body: RequestBody;
        try {
          body = (await request.json()) as RequestBody;
        } catch {
          return errorResponse(400, "Body must be JSON");
        }
        if (!body.text) return errorResponse(400, "`text` is required");

        const voiceId = body.voiceId?.trim() || process.env.PARLEY_JAMES_VOICE_ID?.trim();
        if (!voiceId) {
          return errorResponse(400, "No voiceId in body and PARLEY_JAMES_VOICE_ID not set");
        }

        let upstream: Response;
        try {
          upstream = await fetch(CARTESIA_URL, {
            method: "POST",
            headers: {
              "x-api-key": apiKey,
              "cartesia-version": CARTESIA_VERSION,
              "content-type": "application/json",
              accept: "audio/mp3",
            },
            body: JSON.stringify({
              model_id: DEFAULT_MODEL,
              transcript: body.text,
              voice: { mode: "id", id: voiceId },
              output_format: { container: "mp3", sample_rate: 44100, bit_rate: 128000 },
            }),
            signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
          });
        } catch (err) {
          if (err instanceof DOMException && err.name === "TimeoutError") {
            return errorResponse(504, `Cartesia timed out after ${UPSTREAM_TIMEOUT_MS}ms`);
          }
          return errorResponse(502, `Cartesia request failed: ${(err as Error).message}`);
        }

        if (!upstream.ok || !upstream.body) {
          const text = await upstream.text();
          return errorResponse(upstream.status, `Cartesia ${upstream.status}: ${text}`);
        }

        return new Response(upstream.body, {
          status: 200,
          headers: withCors({
            "content-type": "audio/mpeg",
            "cache-control": "no-cache",
            "x-accel-buffering": "no",
          }),
        });
      },
    },
  },
});

function errorResponse(status: number, error: string): Response {
  return new Response(JSON.stringify({ error }), {
    status,
    headers: withCors({ "content-type": "application/json" }),
  });
}
