import { createFileRoute } from "@tanstack/react-router";

import { corsPreflight, requireClientToken, withCors } from "@/lib/api-cors";
import { meter } from "@/lib/metering";

/**
 * Anthropic Messages API proxy. The browser sends an `LLMRequest`
 * (see `src/lib/providers/types.ts`) plus `stream?: boolean`; we read
 * `ANTHROPIC_API_KEY` from the server env and forward to Anthropic.
 *
 * Prompt caching: when `cacheSystem === true`, we wrap the system block
 * with `cache_control: { type: "ephemeral" }` so the persona block gets
 * cached across turns. Anthropic charges ~10% of input cost on cache hits.
 *
 * Streaming wire format: NDJSON. One JSON object per line, `\n`-terminated.
 * - `{"delta":"<text>"}` for each text chunk (from either `content_block_delta`
 *   text events or tool_use `input_json_delta.partial_json` fragments — both
 *   are forwarded as raw string deltas; the caller decides how to parse).
 * - `{"done":true}` final line so the client can distinguish clean EOF from
 *   a dropped connection.
 * `x-accel-buffering: no` keeps Vercel / nitro v3 from buffering the body.
 */

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";

// Input clamps — keep a public proxy from being driven into expensive calls.
const MAX_OUTPUT_TOKENS = 2048;
const MAX_TOTAL_CONTENT_CHARS = 200_000;

// Upstream timeout. Without this, an Anthropic socket that hangs after sending
// headers never resolves the fetch — and the cockpit suggestion grid waits
// forever, breaking the "never go silent" degradation contract. 20s is
// generous because streaming completions legitimately run long.
const UPSTREAM_TIMEOUT_MS = 20_000;

type Tier = "fast" | "smart" | undefined;
type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

type RequestBody = {
  messages: ChatMessage[];
  maxTokens?: number;
  temperature?: number;
  cacheSystem?: boolean;
  tier?: Tier;
  stream?: boolean;
};

function modelFor(tier: Tier): string {
  const fast = process.env.PARLEY_ANTHROPIC_FAST_MODEL ?? "claude-haiku-4-5";
  const smart = process.env.PARLEY_ANTHROPIC_SMART_MODEL ?? "claude-sonnet-4-6";
  return tier === "smart" ? smart : fast;
}

function buildAnthropicPayload(body: RequestBody) {
  const systemParts: Array<{ type: "text"; text: string; cache_control?: { type: "ephemeral" } }> =
    [];
  const messages: Array<{ role: "user" | "assistant"; content: string }> = [];

  for (const m of body.messages) {
    if (m.role === "system") {
      systemParts.push({
        type: "text",
        text: m.content,
        ...(body.cacheSystem ? { cache_control: { type: "ephemeral" as const } } : {}),
      });
    } else {
      messages.push({ role: m.role, content: m.content });
    }
  }

  return {
    model: modelFor(body.tier),
    max_tokens: Math.min(body.maxTokens ?? 1024, MAX_OUTPUT_TOKENS),
    temperature: body.temperature ?? 0.7,
    ...(systemParts.length > 0 ? { system: systemParts } : {}),
    messages,
  };
}

export const Route = createFileRoute("/api/llm/anthropic")({
  server: {
    handlers: {
      OPTIONS: ({ request }) => corsPreflight(request),
      POST: async ({ request }) => {
        const denied = requireClientToken(request);
        if (denied) return denied;

        const start = Date.now();

        const apiKey = process.env.ANTHROPIC_API_KEY;
        if (!apiKey) return errorResponse(500, "ANTHROPIC_API_KEY not set on the server", request);

        let body: RequestBody;
        try {
          body = (await request.json()) as RequestBody;
        } catch {
          return errorResponse(400, "Body must be JSON", request);
        }

        if (!body || !Array.isArray(body.messages)) {
          return errorResponse(400, "Body must be { messages: ChatMessage[] }", request);
        }
        const totalChars = body.messages.reduce(
          (sum, m) => sum + (typeof m?.content === "string" ? m.content.length : 0),
          0,
        );
        if (totalChars > MAX_TOTAL_CONTENT_CHARS) {
          return errorResponse(
            400,
            `messages content must be ≤ ${MAX_TOTAL_CONTENT_CHARS} chars`,
            request,
          );
        }

        const stream = !!body.stream;
        const payload = buildAnthropicPayload(body);
        const modelId = payload.model;

        let upstream: Response;
        try {
          upstream = await fetch(ANTHROPIC_URL, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-api-key": apiKey,
              "anthropic-version": ANTHROPIC_VERSION,
              ...(body.cacheSystem ? { "anthropic-beta": "prompt-caching-2024-07-31" } : {}),
            },
            body: JSON.stringify({ ...payload, stream }),
            signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
          });
        } catch (err) {
          // AbortSignal.timeout fires a TimeoutError DOMException; anything else
          // is a connect-level failure. Either way the route must resolve so the
          // client's catch runs and degradation kicks in.
          const isTimeout = err instanceof DOMException && err.name === "TimeoutError";
          const status = isTimeout ? 504 : 502;
          await meter(request, {
            kind: "llm",
            provider: "anthropic",
            model: modelId,
            tokensIn: 0,
            tokensOut: 0,
            durationMs: Date.now() - start,
            status,
          });
          if (isTimeout) {
            return errorResponse(
              504,
              `Anthropic timed out after ${UPSTREAM_TIMEOUT_MS}ms`,
              request,
            );
          }
          return errorResponse(
            502,
            `Anthropic request failed: ${(err as Error).message}`,
            request,
          );
        }

        if (!upstream.ok) {
          const text = await upstream.text();
          // Log upstream body server-side for debuggability, but never echo it
          // to the caller — it can include request ids, billing-org ids, model
          // aliases, and (on auth errors) substrings of the API key.
          console.warn("[anthropic] upstream", upstream.status, ":", text);
          await meter(request, {
            kind: "llm",
            provider: "anthropic",
            model: modelId,
            tokensIn: 0,
            tokensOut: 0,
            durationMs: Date.now() - start,
            status: upstream.status,
          });
          return errorResponse(upstream.status, `Anthropic returned ${upstream.status}`, request);
        }

        if (!stream) {
          const data = (await upstream.json()) as {
            content?: Array<{ type: string; text?: string }>;
            usage?: {
              input_tokens?: number;
              output_tokens?: number;
              cache_read_input_tokens?: number;
            };
          };
          const text = (data.content ?? [])
            .filter((b) => b.type === "text")
            .map((b) => b.text ?? "")
            .join("");
          await meter(request, {
            kind: "llm",
            provider: "anthropic",
            model: modelId,
            tokensIn: data.usage?.input_tokens ?? 0,
            tokensOut: data.usage?.output_tokens ?? 0,
            durationMs: Date.now() - start,
            status: upstream.status,
          });
          return Response.json(
            {
              text,
              usage: data.usage
                ? {
                    inputTokens: data.usage.input_tokens ?? 0,
                    outputTokens: data.usage.output_tokens ?? 0,
                    cachedInputTokens: data.usage.cache_read_input_tokens,
                  }
                : undefined,
            },
            { headers: withCors({}, request) },
          );
        }

        // Stream re-emit as NDJSON. Anthropic emits SSE events; we forward:
        //   - `content_block_delta` with `delta.text` (plain text response)
        //   - `content_block_delta` with `delta.partial_json` (tool_use input
        //     fragments — concatenating these forms the assembled JSON input)
        // Both surface as `{"delta":"<chunk>"}` lines so the client/domain
        // layer can accumulate the same way regardless of generation mode.
        const reader = upstream.body!.getReader();
        const decoder = new TextDecoder();
        const encoder = new TextEncoder();
        let sseBuffer = "";
        const usage = { tokensIn: 0, tokensOut: 0 };
        const upstreamStatus = upstream.status;

        const out = new ReadableStream({
          async pull(controller) {
            const { done, value } = await reader.read();
            if (done) {
              // Flush any bytes the streaming decoder is still holding (a
              // multi-byte char split across the final reads). Then drain the
              // trailing partial SSE event so the last delta isn't dropped.
              sseBuffer += decoder.decode();
              emitSseEvents(sseBuffer, controller, encoder, usage);
              controller.enqueue(encoder.encode(`${JSON.stringify({ done: true })}\n`));
              controller.close();
              // Meter the streamed call after the consumer has its `done`. The
              // tokens come from the captured message_start / message_delta
              // events; if they didn't arrive we still log 0/0 with the status
              // so the dashboard sees the call.
              await meter(request, {
                kind: "llm",
                provider: "anthropic",
                model: modelId,
                tokensIn: usage.tokensIn,
                tokensOut: usage.tokensOut,
                durationMs: Date.now() - start,
                status: upstreamStatus,
              });
              return;
            }
            sseBuffer += decoder.decode(value, { stream: true });
            // SSE events are separated by blank lines; keep the trailing
            // partial event in `sseBuffer` for the next chunk.
            const events = sseBuffer.split("\n\n");
            sseBuffer = events.pop() ?? "";
            for (const eventBlock of events) {
              emitSseEvents(eventBlock, controller, encoder, usage);
            }
          },
          // Consumer aborted (James interrupted, nav away). Cancel the keyed
          // upstream body so we don't leak the Anthropic connection.
          cancel() {
            void reader.cancel().catch(() => {});
            // Best-effort meter even on consumer abort so the dashboard sees
            // the call. Tokens whatever we captured before the cut.
            void meter(request, {
              kind: "llm",
              provider: "anthropic",
              model: modelId,
              tokensIn: usage.tokensIn,
              tokensOut: usage.tokensOut,
              durationMs: Date.now() - start,
              status: upstreamStatus,
            });
          },
        });

        return new Response(out, {
          status: 200,
          headers: withCors(
            {
              "content-type": "application/x-ndjson",
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

// Parse one SSE event block (lines split on \n) and enqueue any `delta` text
// as an NDJSON line. Shared between the live `pull` path and the EOF flush so
// the trailing partial event isn't dropped. Also captures token usage from
// `message_start` (input_tokens) and `message_delta` (output_tokens) into the
// caller's accumulator for the metering call at end-of-stream.
function emitSseEvents(
  eventBlock: string,
  controller: ReadableStreamDefaultController<Uint8Array>,
  encoder: TextEncoder,
  usage: { tokensIn: number; tokensOut: number },
): void {
  for (const line of eventBlock.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    const payloadText = trimmed.slice(5).trim();
    if (!payloadText || payloadText === "[DONE]") continue;
    try {
      const event = JSON.parse(payloadText) as {
        type?: string;
        delta?: { type?: string; text?: string; partial_json?: string };
        message?: { usage?: { input_tokens?: number; output_tokens?: number } };
        usage?: { input_tokens?: number; output_tokens?: number };
      };
      if (event.type === "message_start") {
        const u = event.message?.usage;
        if (u) {
          if (typeof u.input_tokens === "number") usage.tokensIn = u.input_tokens;
          if (typeof u.output_tokens === "number") usage.tokensOut = u.output_tokens;
        }
        continue;
      }
      if (event.type === "message_delta") {
        const u = event.usage;
        if (u) {
          if (typeof u.input_tokens === "number") usage.tokensIn = u.input_tokens;
          if (typeof u.output_tokens === "number") usage.tokensOut = u.output_tokens;
        }
        continue;
      }
      if (event.type !== "content_block_delta" || !event.delta) continue;
      const piece = event.delta.text ?? event.delta.partial_json;
      if (typeof piece === "string" && piece.length > 0) {
        controller.enqueue(encoder.encode(`${JSON.stringify({ delta: piece })}\n`));
      }
    } catch {
      /* ignore malformed events */
    }
  }
}

function errorResponse(status: number, error: string, request?: Request): Response {
  return new Response(JSON.stringify({ error }), {
    status,
    headers: withCors({ "content-type": "application/json" }, request),
  });
}
