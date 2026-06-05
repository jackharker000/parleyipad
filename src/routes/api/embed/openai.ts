import { createFileRoute } from "@tanstack/react-router";

import { corsPreflight, requireClientToken, withCors } from "@/lib/api-cors";
import { meter } from "@/lib/metering";

/**
 * OpenAI embeddings proxy. Used for the Tier-3 semantic memory retrieval
 * pipeline — cheap text embeddings via `text-embedding-3-small` (1536-dim).
 *
 * Cross-vendor on purpose: Anthropic doesn't ship a first-party embedder
 * and `text-embedding-3-small` is the cheapest decent option, so we use it
 * regardless of which LLM provider the user has selected.
 *
 * Wire shape: `{ texts: string[] }` in, `{ embeddings: number[][] }` out
 * (one row per input, same order). Cap at 100 inputs per request — the
 * OpenAI API tolerates larger batches but `embedTexts` on the client
 * splits into ≤100 chunks for predictable per-request latency.
 *
 * Cache-Control: no-store. Embeddings are cheap to call and the client
 * keeps its own LRU; we don't want browsers re-serving stale rows.
 */

const OPENAI_EMBEDDINGS_URL = "https://api.openai.com/v1/embeddings";
const EMBEDDING_MODEL = "text-embedding-3-small";
const MAX_BATCH = 100;

// Upstream timeout. Embeddings feed the Tier-3 memory retrieval that gates a
// suggestion turn; a hung call would stall that path, so cap it at 10s.
const UPSTREAM_TIMEOUT_MS = 10_000;

type RequestBody = {
  texts: string[];
};

export const Route = createFileRoute("/api/embed/openai")({
  server: {
    handlers: {
      OPTIONS: ({ request }) => corsPreflight(request),
      POST: async ({ request }) => {
        const denied = requireClientToken(request);
        if (denied) return denied;

        const start = Date.now();

        const apiKey = process.env.OPENAI_API_KEY;
        if (!apiKey) return errorResponse(500, "OPENAI_API_KEY not set on the server", request);

        let body: RequestBody;
        try {
          body = (await request.json()) as RequestBody;
        } catch {
          return errorResponse(400, "Body must be JSON", request);
        }

        if (!body || !Array.isArray(body.texts)) {
          return errorResponse(400, "Body must be { texts: string[] }", request);
        }
        if (body.texts.length === 0) {
          return Response.json(
            { embeddings: [] },
            { headers: withCors({ "cache-control": "no-store" }, request) },
          );
        }
        if (body.texts.length > MAX_BATCH) {
          return errorResponse(400, `texts.length must be ≤ ${MAX_BATCH}`, request);
        }
        if (body.texts.some((t) => typeof t !== "string")) {
          return errorResponse(400, "Every texts[i] must be a string", request);
        }

        let upstream: Response;
        try {
          upstream = await fetch(OPENAI_EMBEDDINGS_URL, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              authorization: `Bearer ${apiKey}`,
            },
            body: JSON.stringify({ model: EMBEDDING_MODEL, input: body.texts }),
            signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
          });
        } catch (err) {
          const isTimeout = err instanceof DOMException && err.name === "TimeoutError";
          const status = isTimeout ? 504 : 502;
          await meter(request, {
            kind: "embed",
            provider: "openai",
            model: EMBEDDING_MODEL,
            tokensIn: 0,
            durationMs: Date.now() - start,
            status,
          });
          if (isTimeout) {
            return errorResponse(
              504,
              `OpenAI embeddings timed out after ${UPSTREAM_TIMEOUT_MS}ms`,
              request,
            );
          }
          return errorResponse(
            502,
            `OpenAI embeddings request failed: ${(err as Error).message}`,
            request,
          );
        }

        if (!upstream.ok) {
          const text = await upstream.text();
          // Log upstream body server-side for debuggability, but never echo it
          // to the caller — it can include request ids, billing-org ids, model
          // aliases, and (on auth errors) substrings of the API key.
          console.warn("[openai-embed] upstream", upstream.status, ":", text);
          await meter(request, {
            kind: "embed",
            provider: "openai",
            model: EMBEDDING_MODEL,
            tokensIn: 0,
            durationMs: Date.now() - start,
            status: upstream.status,
          });
          return errorResponse(upstream.status, `OpenAI returned ${upstream.status}`, request);
        }

        const data = (await upstream.json()) as {
          model?: string;
          data?: Array<{ embedding?: number[]; index?: number }>;
          usage?: { prompt_tokens?: number; total_tokens?: number };
        };
        const rows = Array.isArray(data.data) ? data.data : [];
        const embeddings: number[][] = new Array(body.texts.length);
        for (let i = 0; i < rows.length; i++) {
          const row = rows[i];
          // OpenAI returns rows in input order, but the response also carries
          // `index` — honour it if present so we're robust to reorderings.
          const idx = typeof row.index === "number" ? row.index : i;
          if (idx >= 0 && idx < embeddings.length && Array.isArray(row.embedding)) {
            embeddings[idx] = row.embedding;
          }
        }
        // Any holes mean OpenAI dropped a row — surface that as an error so
        // the client doesn't silently feed all-zero vectors into the matcher.
        for (let i = 0; i < embeddings.length; i++) {
          if (!embeddings[i]) {
            await meter(request, {
              kind: "embed",
              provider: "openai",
              model: data.model ?? EMBEDDING_MODEL,
              tokensIn: data.usage?.total_tokens ?? data.usage?.prompt_tokens ?? 0,
              durationMs: Date.now() - start,
              status: 502,
            });
            return errorResponse(502, `OpenAI returned no embedding for input ${i}`, request);
          }
        }

        await meter(request, {
          kind: "embed",
          provider: "openai",
          model: data.model ?? EMBEDDING_MODEL,
          tokensIn: data.usage?.total_tokens ?? data.usage?.prompt_tokens ?? 0,
          durationMs: Date.now() - start,
          status: upstream.status,
        });

        return Response.json(
          { embeddings },
          { headers: withCors({ "cache-control": "no-store" }, request) },
        );
      },
    },
  },
});

function errorResponse(status: number, error: string, request?: Request): Response {
  return new Response(JSON.stringify({ error }), {
    status,
    headers: withCors(
      { "content-type": "application/json", "cache-control": "no-store" },
      request,
    ),
  });
}
