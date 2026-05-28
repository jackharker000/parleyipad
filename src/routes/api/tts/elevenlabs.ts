import { createFileRoute } from "@tanstack/react-router";

import { corsPreflight, withCors } from "@/lib/api-cors";

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

type RequestBody = {
  text: string;
  voiceId?: string;
};

export const Route = createFileRoute("/api/tts/elevenlabs")({
  server: {
    handlers: {
      OPTIONS: corsPreflight,
      POST: async ({ request }) => {
        const apiKey = process.env.ELEVENLABS_API_KEY;
        if (!apiKey) return errorResponse(500, "ELEVENLABS_API_KEY not set on the server");

        let body: RequestBody;
        try {
          body = (await request.json()) as RequestBody;
        } catch {
          return errorResponse(400, "Body must be JSON");
        }

        if (!body.text || typeof body.text !== "string") {
          return errorResponse(400, "`text` is required");
        }

        const voiceId =
          body.voiceId?.trim() || process.env.PARLEY_JAMES_VOICE_ID?.trim() || DEFAULT_VOICE_ID;

        const upstream = await fetch(
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
          },
        );

        if (!upstream.ok || !upstream.body) {
          const text = await upstream.text();
          return errorResponse(upstream.status, `Flash TTS ${upstream.status}: ${text}`);
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
