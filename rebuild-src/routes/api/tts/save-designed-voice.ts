import { createFileRoute } from "@tanstack/react-router";

import { corsPreflight, requireClientToken, withCors } from "@/lib/api-cors";

/**
 * ElevenLabs "save the previewed voice" proxy. Caller picks one of the
 * preview voices returned by /api/tts/design-previews; we forward to
 * ElevenLabs's text-to-voice/create-voice-from-preview endpoint and return
 * the resulting voiceId so the client can persist it as the active voice.
 */

const UPSTREAM_URL = "https://api.elevenlabs.io/v1/text-to-voice/create-voice-from-preview";
const UPSTREAM_TIMEOUT_MS = 20_000;
const MIN_NAME_CHARS = 1;
const MAX_NAME_CHARS = 100;
const MIN_DESCRIPTION_CHARS = 20;
const MAX_DESCRIPTION_CHARS = 1000;

type RequestBody = {
  voiceName: string;
  description: string;
  generatedVoiceId: string;
};

export type SaveDesignedVoiceResult = {
  voiceId: string;
  name: string;
};

export const Route = createFileRoute("/api/tts/save-designed-voice")({
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
        const voiceName = (body.voiceName ?? "").trim();
        const description = (body.description ?? "").trim();
        const generatedVoiceId = (body.generatedVoiceId ?? "").trim();
        if (voiceName.length < MIN_NAME_CHARS || voiceName.length > MAX_NAME_CHARS) {
          return errorResponse(
            400,
            `voiceName must be ${MIN_NAME_CHARS}–${MAX_NAME_CHARS} characters`,
          );
        }
        if (
          description.length < MIN_DESCRIPTION_CHARS ||
          description.length > MAX_DESCRIPTION_CHARS
        ) {
          return errorResponse(
            400,
            `description must be ${MIN_DESCRIPTION_CHARS}–${MAX_DESCRIPTION_CHARS} characters`,
          );
        }
        if (generatedVoiceId.length === 0) {
          return errorResponse(400, "generatedVoiceId is required");
        }

        let upstream: Response;
        try {
          upstream = await fetch(UPSTREAM_URL, {
            method: "POST",
            headers: {
              "xi-api-key": apiKey,
              "content-type": "application/json",
            },
            body: JSON.stringify({
              voice_name: voiceName,
              voice_description: description,
              generated_voice_id: generatedVoiceId,
            }),
            signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
          });
        } catch (err) {
          if (err instanceof DOMException && err.name === "TimeoutError") {
            return errorResponse(504, `Save voice timed out after ${UPSTREAM_TIMEOUT_MS}ms`);
          }
          const message = err instanceof Error ? err.message : String(err);
          return errorResponse(502, `Save voice fetch failed: ${message}`);
        }
        if (!upstream.ok) {
          const detail = await upstream.text();
          return errorResponse(upstream.status, `ElevenLabs ${upstream.status}: ${detail}`);
        }

        const json = (await upstream.json()) as { voice_id?: string; name?: string };
        if (!json.voice_id) {
          return errorResponse(502, "ElevenLabs response missing voice_id");
        }
        const result: SaveDesignedVoiceResult = {
          voiceId: json.voice_id,
          name: json.name ?? voiceName,
        };

        return Response.json(result, {
          headers: withCors({ "content-type": "application/json" }),
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
