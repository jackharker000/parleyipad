import { createFileRoute } from "@tanstack/react-router";

import { corsPreflight, requireClientToken, withCors } from "@/lib/api-cors";

/**
 * ElevenLabs voices proxy. Calls the v2 voices endpoint (which supports
 * pagination) and returns a slimmed-down `{ voices: [...] }` payload — no
 * categories the Voice picker can't use, no API key ever leaving the server.
 *
 * Settings opens this dropdown on every render of the Voice & Models tab,
 * so we set a short cache-control header to dodge cold-fetching the catalog
 * on every nav into the page. The voice list barely changes for a single
 * user; 5 minutes is plenty.
 */

const ELEVENLABS_VOICES_URL = "https://api.elevenlabs.io/v2/voices";
const PAGE_SIZE = 100;
const KEEP_CATEGORIES = new Set(["premade", "cloned"]);

// Per-page upstream timeout. The Voice & Models tab opens this dropdown on
// every render, so a hung catalog fetch would stall the settings page; 10s
// per page is plenty for a list that barely changes.
const UPSTREAM_TIMEOUT_MS = 10_000;

type UpstreamVoice = {
  voice_id: string;
  name: string;
  category?: string;
  preview_url?: string;
};

type UpstreamResponse = {
  voices?: UpstreamVoice[];
  has_more?: boolean;
  next_page_token?: string;
};

export type SimpleVoice = {
  voiceId: string;
  name: string;
  category: string;
  previewUrl?: string;
};

export const Route = createFileRoute("/api/tts/voices")({
  server: {
    handlers: {
      OPTIONS: ({ request }) => corsPreflight(request),
      // Only handler is GET, but it still makes a keyed ElevenLabs call, so it
      // sits behind the same shared-secret gate as the POST routes.
      GET: async ({ request }) => {
        const denied = requireClientToken(request);
        if (denied) return denied;

        const apiKey = process.env.ELEVENLABS_API_KEY;
        if (!apiKey) return errorResponse(500, "ELEVENLABS_API_KEY not set on the server", request);

        const voices: SimpleVoice[] = [];
        let nextPageToken: string | undefined = undefined;

        try {
          do {
            const params = new URLSearchParams();
            params.set("page_size", String(PAGE_SIZE));
            if (nextPageToken) params.set("next_page_token", nextPageToken);
            const url = `${ELEVENLABS_VOICES_URL}?${params.toString()}`;
            const upstream = await fetch(url, {
              method: "GET",
              headers: {
                "xi-api-key": apiKey,
                accept: "application/json",
              },
              signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
            });

            if (!upstream.ok) {
              const text = await upstream.text();
              // Log upstream body server-side for debuggability, but never echo it
              // to the caller — it can include request ids, billing-org ids, and
              // (on auth errors) substrings of the API key.
              console.warn("[elevenlabs-voices] upstream", upstream.status, ":", text);
              return errorResponse(
                upstream.status,
                `ElevenLabs returned ${upstream.status}`,
                request,
              );
            }

            const data = (await upstream.json()) as UpstreamResponse;
            for (const v of data.voices ?? []) {
              const category = (v.category ?? "premade").toLowerCase();
              const keep = KEEP_CATEGORIES.has(category) || !!v.preview_url;
              if (!keep) continue;
              voices.push({
                voiceId: v.voice_id,
                name: v.name,
                category,
                previewUrl: v.preview_url,
              });
            }
            nextPageToken = data.has_more ? data.next_page_token : undefined;
            // Hard guard: never loop forever on a server that keeps returning
            // has_more=true. 5 pages × 100 voices = enough for any real user.
          } while (nextPageToken && voices.length < PAGE_SIZE * 5);
        } catch (err) {
          if (err instanceof DOMException && err.name === "TimeoutError") {
            return errorResponse(
              504,
              `ElevenLabs voices timed out after ${UPSTREAM_TIMEOUT_MS}ms`,
              request,
            );
          }
          const message = err instanceof Error ? err.message : String(err);
          return errorResponse(502, `Voices fetch failed: ${message}`, request);
        }

        // Stable-sort: cloned first (the user's own clones), then premade,
        // alphabetised within each bucket. Makes the dropdown predictable.
        voices.sort((a, b) => {
          if (a.category !== b.category) return a.category === "cloned" ? -1 : 1;
          return a.name.localeCompare(b.name);
        });

        return Response.json(
          { voices },
          {
            headers: withCors(
              {
                "content-type": "application/json",
                "cache-control": "public, max-age=300",
              },
              request,
            ),
          },
        );
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
