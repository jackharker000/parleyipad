import { createFileRoute } from "@tanstack/react-router";

import { corsPreflight, requireClientToken, withCors } from "@/lib/api-cors";

/**
 * ElevenLabs Scribe (batch REST) proxy.
 *
 * Client posts multipart form-data with `audio` (a wav/webm/mp3 blob) and
 * an optional `sampleRate` hint. We forward to ElevenLabs `/v1/speech-to-text`
 * with our server-side key. Scribe responds with a transcript object that we
 * normalise into the segment shape the client `STTProvider` returns.
 *
 * v1 of the live cockpit uses this batched path — Scribe also has a
 * WebSocket streaming endpoint for partial transcripts, but proxying a
 * WebSocket through Vercel functions is fiddlier and we don't need
 * partials for the speaker-ID + turn-triggered suggestion loop yet.
 */

const SCRIBE_URL = "https://api.elevenlabs.io/v1/speech-to-text";

// Upstream timeout. This batch path is the fallback when the streaming WS
// transcription fails; if it also hangs after sending headers, the segment's
// transcribe() never resolves and that turn is lost. 15s covers a long
// utterance plus Scribe's processing.
const UPSTREAM_TIMEOUT_MS = 15_000;

export const Route = createFileRoute("/api/stt/elevenlabs")({
  server: {
    handlers: {
      OPTIONS: ({ request }) => corsPreflight(request),
      POST: async ({ request }) => {
        const denied = requireClientToken(request);
        if (denied) return denied;

        const apiKey = process.env.ELEVENLABS_API_KEY;
        if (!apiKey) return errorResponse(500, "ELEVENLABS_API_KEY not set on the server");

        const form = await request.formData();
        const audio = form.get("audio");
        if (!(audio instanceof Blob)) {
          return errorResponse(400, "Multipart field `audio` (Blob) is required");
        }

        const upstreamForm = new FormData();
        upstreamForm.append("file", audio, "audio.webm");
        upstreamForm.append("model_id", "scribe_v2_realtime");
        upstreamForm.append("timestamps_granularity", "word");
        // Suppress (laughs)/(pauses)/etc. event tags that Scribe injects into
        // the transcript text and that James can't easily strip out of the
        // suggestion prompts.
        upstreamForm.append("tag_audio_events", "false");

        // Optional keyterm biasing — the client sends `keyTerms` as a JSON
        // array string. Scribe batch accepts `keyterms` as repeated multipart
        // fields (one entry per term). Batch caps at 1000 terms of 50 chars
        // each; we cap at 50 for parity with realtime so a switch to the
        // batch fallback doesn't suddenly inflate cost.
        // Source: https://elevenlabs.io/docs/eleven-api/guides/how-to/speech-to-text/batch/keyterm-prompting
        const keyTermsField = form.get("keyTerms");
        if (typeof keyTermsField === "string" && keyTermsField.length > 0) {
          let parsed: unknown;
          try {
            parsed = JSON.parse(keyTermsField);
          } catch {
            parsed = null;
          }
          if (Array.isArray(parsed)) {
            const terms = parsed
              .filter((t): t is string => typeof t === "string")
              .map((t) => t.trim())
              .filter((t) => t.length > 0)
              .map((t) => (t.length > 50 ? t.slice(0, 50) : t))
              .slice(0, 50);
            for (const term of terms) {
              upstreamForm.append("keyterms", term);
            }
          }
        }

        let upstream: Response;
        try {
          upstream = await fetch(SCRIBE_URL, {
            method: "POST",
            headers: { "xi-api-key": apiKey },
            body: upstreamForm,
            signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
          });
        } catch (err) {
          if (err instanceof DOMException && err.name === "TimeoutError") {
            return errorResponse(504, `Scribe timed out after ${UPSTREAM_TIMEOUT_MS}ms`);
          }
          return errorResponse(502, `Scribe request failed: ${(err as Error).message}`);
        }

        if (!upstream.ok) {
          const text = await upstream.text();
          return errorResponse(upstream.status, `Scribe ${upstream.status}: ${text}`);
        }

        type ScribeWord = {
          text: string;
          start: number;
          end: number;
          type?: string;
          speaker_id?: string;
        };
        type ScribeResponse = {
          language_code?: string;
          text: string;
          words?: ScribeWord[];
        };
        const data = (await upstream.json()) as ScribeResponse;

        // Scribe returns the whole utterance as one block of text plus per-word
        // timestamps. For the cockpit v1 we treat the whole post as a single
        // segment — speaker-ID + turn boundaries already come from Silero VAD,
        // and we're sending one VAD utterance at a time, so word-level
        // splitting isn't worth the complexity yet.
        const start = data.words?.[0]?.start ?? 0;
        const end = data.words?.[data.words.length - 1]?.end ?? 0;
        const segments = [
          {
            start,
            end,
            text: (data.text ?? "").trim(),
            speaker: data.words?.[0]?.speaker_id,
          },
        ];

        return Response.json({ segments }, { headers: withCors() });
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
