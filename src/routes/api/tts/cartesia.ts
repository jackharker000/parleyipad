import { createFileRoute } from "@tanstack/react-router";

import { corsPreflight, requireClientToken, withCors } from "@/lib/api-cors";
import { meter } from "@/lib/metering";

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

        const start = Date.now();

        const apiKey = process.env.CARTESIA_API_KEY;
        if (!apiKey) return errorResponse(500, "CARTESIA_API_KEY not set on the server", request);

        let body: RequestBody;
        try {
          body = (await request.json()) as RequestBody;
        } catch {
          return errorResponse(400, "Body must be JSON", request);
        }
        if (!body.text) return errorResponse(400, "`text` is required", request);

        const voiceId = body.voiceId?.trim() || process.env.PARLEY_JAMES_VOICE_ID?.trim();
        if (!voiceId) {
          return errorResponse(
            400,
            "No voiceId in body and PARLEY_JAMES_VOICE_ID not set",
            request,
          );
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
          const isTimeout = err instanceof DOMException && err.name === "TimeoutError";
          const status = isTimeout ? 504 : 502;
          await meter(request, {
            kind: "tts",
            provider: "cartesia",
            model: DEFAULT_MODEL,
            characters: body.text.length,
            durationMs: Date.now() - start,
            status,
          });
          if (isTimeout) {
            return errorResponse(504, `Cartesia timed out after ${UPSTREAM_TIMEOUT_MS}ms`, request);
          }
          return errorResponse(
            502,
            `Cartesia request failed: ${(err as Error).message}`,
            request,
          );
        }

        if (!upstream.ok || !upstream.body) {
          const text = await upstream.text();
          // Log upstream body server-side for debuggability, but never echo it
          // to the caller — it can include request ids, billing-org ids, and
          // (on auth errors) substrings of the API key.
          console.warn("[cartesia] upstream", upstream.status, ":", text);
          await meter(request, {
            kind: "tts",
            provider: "cartesia",
            model: DEFAULT_MODEL,
            characters: body.text.length,
            durationMs: Date.now() - start,
            status: upstream.status,
          });
          return errorResponse(upstream.status, `Cartesia returned ${upstream.status}`, request);
        }

        // Tee the upstream audio so we can log usage once the response
        // completes without buffering the bytes. The client gets the original
        // stream; we get a tail-end notification when the body ends.
        const reader = upstream.body.getReader();
        const upstreamStatus = upstream.status;
        const characters = body.text.length;
        const out = new ReadableStream<Uint8Array>({
          async pull(controller) {
            const { done, value } = await reader.read();
            if (done) {
              controller.close();
              await meter(request, {
                kind: "tts",
                provider: "cartesia",
                model: DEFAULT_MODEL,
                characters,
                durationMs: Date.now() - start,
                status: upstreamStatus,
              });
              return;
            }
            if (value) controller.enqueue(value);
          },
          cancel() {
            void reader.cancel().catch(() => {});
            void meter(request, {
              kind: "tts",
              provider: "cartesia",
              model: DEFAULT_MODEL,
              characters,
              durationMs: Date.now() - start,
              status: upstreamStatus,
            });
          },
        });

        return new Response(out, {
          status: 200,
          headers: withCors(
            {
              "content-type": "audio/mpeg",
              "cache-control": "no-cache",
              "x-accel-buffering": "no",
            },
            request,
          ),
        });
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
