import { createFileRoute } from "@tanstack/react-router";

import { corsPreflight, requireClientToken, withCors } from "@/lib/api-cors";
import { meter } from "@/lib/metering";

/**
 * ElevenLabs Flash v2.5 streaming TTS proxy. The browser POSTs
 * `{ text, voiceId? }` and we stream MP3 chunks back as soon as
 * ElevenLabs produces them. The client decodes + plays as it streams.
 *
 * Falls back to a known public voice when no voiceId is provided
 * (and no PARLEY_JAMES_VOICE_ID is set on the server) so the cockpit
 * still works before James's clone is uploaded.
 */

const DEFAULT_VOICE_ID = "pNInz6obpgDQGcFmaJgB"; // "Adam" — ElevenLabs public sample voice
const MODEL_ID = "eleven_flash_v2_5";

// Upstream timeout. Bounds both the connect and the whole streamed body — a
// single spoken suggestion is short, so a stream still open after 15s is hung.
// When it fires mid-stream the abort propagates to the forwarded body and the
// client's reader errors, so the TTSPlayer catch runs instead of hanging James
// on a half-spoken phrase.
const UPSTREAM_TIMEOUT_MS = 15_000;

type RequestBody = {
  text: string;
  voiceId?: string;
};

export const Route = createFileRoute("/api/tts/elevenlabs")({
  server: {
    handlers: {
      OPTIONS: ({ request }) => corsPreflight(request),
      POST: async ({ request }) => {
        const denied = requireClientToken(request);
        if (denied) return denied;

        const start = Date.now();

        const apiKey = process.env.ELEVENLABS_API_KEY;
        if (!apiKey) return errorResponse(500, "ELEVENLABS_API_KEY not set on the server", request);

        let body: RequestBody;
        try {
          body = (await request.json()) as RequestBody;
        } catch {
          return errorResponse(400, "Body must be JSON", request);
        }

        if (!body.text || typeof body.text !== "string") {
          return errorResponse(400, "`text` is required", request);
        }

        const voiceId =
          body.voiceId?.trim() || process.env.PARLEY_JAMES_VOICE_ID?.trim() || DEFAULT_VOICE_ID;

        let upstream: Response;
        try {
          upstream = await fetch(
            `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream?output_format=mp3_44100_128`,
            {
              method: "POST",
              headers: {
                "xi-api-key": apiKey,
                "content-type": "application/json",
                accept: "audio/mpeg",
              },
              body: JSON.stringify({
                text: body.text,
                model_id: MODEL_ID,
                voice_settings: { stability: 0.5, similarity_boost: 0.75 },
              }),
              signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
            },
          );
        } catch (err) {
          const isTimeout = err instanceof DOMException && err.name === "TimeoutError";
          const status = isTimeout ? 504 : 502;
          await meter(request, {
            kind: "tts",
            provider: "elevenlabs",
            model: MODEL_ID,
            characters: body.text.length,
            durationMs: Date.now() - start,
            status,
          });
          if (isTimeout) {
            return errorResponse(
              504,
              `Flash TTS timed out after ${UPSTREAM_TIMEOUT_MS}ms`,
              request,
            );
          }
          return errorResponse(
            502,
            `Flash TTS request failed: ${(err as Error).message}`,
            request,
          );
        }

        if (!upstream.ok || !upstream.body) {
          const text = await upstream.text();
          // Log upstream body server-side for debuggability, but never echo it
          // to the caller — it can include request ids, billing-org ids, and
          // (on auth errors) substrings of the API key.
          console.warn("[elevenlabs-tts] upstream", upstream.status, ":", text);
          await meter(request, {
            kind: "tts",
            provider: "elevenlabs",
            model: MODEL_ID,
            characters: body.text.length,
            durationMs: Date.now() - start,
            status: upstream.status,
          });
          return errorResponse(upstream.status, `Flash TTS returned ${upstream.status}`, request);
        }

        // Tee the upstream audio so we can log usage once the response
        // completes without buffering the bytes. The client gets the original
        // stream; we get a tail-end notification via the second branch.
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
                provider: "elevenlabs",
                model: MODEL_ID,
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
              provider: "elevenlabs",
              model: MODEL_ID,
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
