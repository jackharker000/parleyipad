import { createFileRoute } from "@tanstack/react-router";

import { corsPreflight, requireClientToken, withCors } from "@/lib/api-cors";

/**
 * ElevenLabs Voice Design previews proxy. Caller posts a free-text voice
 * description (and optionally a sample-text utterance the previews speak);
 * we forward to ElevenLabs's text-to-voice/create-previews endpoint and
 * return the array of generated preview voices. The API key never leaves
 * the server.
 *
 * Expected upstream shape:
 *   POST https://api.elevenlabs.io/v1/text-to-voice/create-previews
 *   { voice_description, text }
 *   -> { previews: [{ generated_voice_id, audio_base_64, media_type }] }
 */

const UPSTREAM_URL =
  "https://api.elevenlabs.io/v1/text-to-voice/create-previews?output_format=mp3_44100_128";
const UPSTREAM_TIMEOUT_MS = 30_000;
const MIN_DESCRIPTION_CHARS = 20;
const MAX_DESCRIPTION_CHARS = 1000;
const MAX_SAMPLE_CHARS = 1000;

const DEFAULT_SAMPLE_TEXT =
  "Hello, it's good to see you again. I was just thinking about our last chat — how have things been with you this week? Take your time, I'm in no rush. There's a lot I want to catch up on, but let's start with whatever is on your mind first.";

type RequestBody = {
  description: string;
  sampleText?: string;
};

export type DesignPreview = {
  generatedVoiceId: string;
  audioBase64: string;
  mime: string;
};

export const Route = createFileRoute("/api/tts/design-previews")({
  server: {
    handlers: {
      OPTIONS: ({ request }) => corsPreflight(request),
      POST: async ({ request }) => {
        const denied = requireClientToken(request);
        if (denied) return denied;

        const apiKey = process.env.ELEVENLABS_API_KEY;
        if (!apiKey) return errorResponse(500, "ELEVENLABS_API_KEY not set on the server");

        let body: RequestBody;
        try {
          body = (await request.json()) as RequestBody;
        } catch {
          return errorResponse(400, "Invalid JSON body");
        }
        const description = (body.description ?? "").trim();
        if (description.length < MIN_DESCRIPTION_CHARS) {
          return errorResponse(400, `description must be ≥ ${MIN_DESCRIPTION_CHARS} characters`);
        }
        if (description.length > MAX_DESCRIPTION_CHARS) {
          return errorResponse(400, `description exceeds ${MAX_DESCRIPTION_CHARS}-character cap`);
        }
        const text =
          typeof body.sampleText === "string" && body.sampleText.trim()
            ? body.sampleText.trim().slice(0, MAX_SAMPLE_CHARS)
            : DEFAULT_SAMPLE_TEXT;

        let upstream: Response;
        try {
          upstream = await fetch(UPSTREAM_URL, {
            method: "POST",
            headers: {
              "xi-api-key": apiKey,
              "content-type": "application/json",
            },
            body: JSON.stringify({ voice_description: description, text }),
            signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
          });
        } catch (err) {
          if (err instanceof DOMException && err.name === "TimeoutError") {
            return errorResponse(504, `Voice design timed out after ${UPSTREAM_TIMEOUT_MS}ms`);
          }
          const message = err instanceof Error ? err.message : String(err);
          return errorResponse(502, `Voice design fetch failed: ${message}`);
        }
        if (!upstream.ok) {
          const detail = await upstream.text();
          return errorResponse(upstream.status, `ElevenLabs ${upstream.status}: ${detail}`);
        }

        const json = (await upstream.json()) as {
          previews?: Array<{
            audio_base_64?: string;
            generated_voice_id?: string;
            media_type?: string;
          }>;
        };
        const previews: DesignPreview[] = (json.previews ?? [])
          .filter((p) => p.audio_base_64 && p.generated_voice_id)
          .map((p) => ({
            generatedVoiceId: p.generated_voice_id!,
            audioBase64: p.audio_base_64!,
            mime: p.media_type ?? "audio/mpeg",
          }));

        return Response.json(
          { previews },
          { headers: withCors({ "content-type": "application/json" }) },
        );
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
