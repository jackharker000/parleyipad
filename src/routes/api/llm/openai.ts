import { createFileRoute } from "@tanstack/react-router";

import { corsPreflight, requireClientToken, withCors } from "@/lib/api-cors";

/**
 * OpenAI Chat Completions proxy. Same request shape as the Anthropic
 * proxy. OpenAI handles prompt-prefix caching implicitly so we don't
 * need to mark anything explicitly.
 *
 * Streaming wire format matches the Anthropic proxy: NDJSON with
 * `{"delta":"<chunk>"}` per line and a final `{"done":true}`.
 */

const OPENAI_URL = "https://api.openai.com/v1/chat/completions";

// Input clamps — keep a public proxy from being driven into expensive calls.
const MAX_OUTPUT_TOKENS = 2048;
const MAX_TOTAL_CONTENT_CHARS = 200_000;

// Upstream timeout. Mirrors the Anthropic proxy: without it an OpenAI socket
// that hangs after sending headers never resolves the fetch, and the cockpit
// suggestion grid waits forever — breaking the "never go silent" contract.
// 20s is generous because streaming completions legitimately run long.
const UPSTREAM_TIMEOUT_MS = 20_000;

type Tier = "fast" | "smart" | undefined;
type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

type RequestBody = {
  messages: ChatMessage[];
  maxTokens?: number;
  temperature?: number;
  tier?: Tier;
  stream?: boolean;
};

function modelFor(tier: Tier): string {
  const fast = process.env.PARLEY_OPENAI_FAST_MODEL ?? "gpt-4o-mini";
  const smart = process.env.PARLEY_OPENAI_SMART_MODEL ?? "gpt-4o";
  return tier === "smart" ? smart : fast;
}

export const Route = createFileRoute("/api/llm/openai")({
  server: {
    handlers: {
      OPTIONS: ({ request }) => corsPreflight(request),
      POST: async ({ request }) => {
        const denied = requireClientToken(request);
        if (denied) return denied;

        const apiKey = process.env.OPENAI_API_KEY;
        if (!apiKey) return errorResponse(500, "OPENAI_API_KEY not set on the server");

        let body: RequestBody;
        try {
          body = (await request.json()) as RequestBody;
        } catch {
          return errorResponse(400, "Body must be JSON");
        }

        if (!body || !Array.isArray(body.messages)) {
          return errorResponse(400, "Body must be { messages: ChatMessage[] }");
        }
        const totalChars = body.messages.reduce(
          (sum, m) => sum + (typeof m?.content === "string" ? m.content.length : 0),
          0,
        );
        if (totalChars > MAX_TOTAL_CONTENT_CHARS) {
          return errorResponse(400, `messages content must be ≤ ${MAX_TOTAL_CONTENT_CHARS} chars`);
        }

        const stream = !!body.stream;

        // Structured-output parity with the Anthropic proxy. GPT otherwise
        // wraps JSON in prose more often than Claude, diverging the provider
        // abstraction. We turn on json_object mode for the structured calls
        // (suggestions, summaries, etc.) but NOT the plain-text ones (expand,
        // draft prose). The reliable, in-scope signal is the prompt content:
        // every structured prompt emits "Output strictly as JSON" / "JSON
        // only", while the plain-text prompts never mention JSON. That gate is
        // also exactly what OpenAI requires — json_object mode rejects a
        // request unless the word "json" appears in the messages — so keying
        // off "json" in the content can never enable the mode illegally or
        // break a non-JSON call.
        const wantsJson = body.messages.some(
          (m) => typeof m?.content === "string" && /\bjson\b/i.test(m.content),
        );

        const payload = {
          model: modelFor(body.tier),
          messages: body.messages,
          temperature: body.temperature ?? 0.7,
          max_tokens: Math.min(body.maxTokens ?? 1024, MAX_OUTPUT_TOKENS),
          ...(wantsJson ? { response_format: { type: "json_object" as const } } : {}),
          ...(stream ? { stream: true } : {}),
        };

        let upstream: Response;
        try {
          upstream = await fetch(OPENAI_URL, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              authorization: `Bearer ${apiKey}`,
            },
            body: JSON.stringify(payload),
            signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
          });
        } catch (err) {
          // TimeoutError -> 504 so the client catch fires and degradation kicks
          // in; any other throw is a connect-level failure -> 502.
          if (err instanceof DOMException && err.name === "TimeoutError") {
            return errorResponse(504, `OpenAI timed out after ${UPSTREAM_TIMEOUT_MS}ms`);
          }
          return errorResponse(502, `OpenAI request failed: ${(err as Error).message}`);
        }

        if (!upstream.ok) {
          const text = await upstream.text();
          return errorResponse(upstream.status, `OpenAI ${upstream.status}: ${text}`);
        }

        if (!stream) {
          const data = (await upstream.json()) as {
            choices?: Array<{ message?: { content?: string } }>;
            usage?: { prompt_tokens?: number; completion_tokens?: number };
          };
          const text = data.choices?.[0]?.message?.content ?? "";
          return Response.json(
            {
              text,
              usage: data.usage
                ? {
                    inputTokens: data.usage.prompt_tokens ?? 0,
                    outputTokens: data.usage.completion_tokens ?? 0,
                  }
                : undefined,
            },
            { headers: withCors() },
          );
        }

        // Stream re-emit as NDJSON. OpenAI emits SSE with
        // `choices[0].delta.content`; we forward each non-empty piece as a
        // `{"delta":"<chunk>"}` line, terminating with `{"done":true}`.
        const reader = upstream.body!.getReader();
        const decoder = new TextDecoder();
        const encoder = new TextEncoder();
        let sseBuffer = "";

        const out = new ReadableStream({
          async pull(controller) {
            const { done, value } = await reader.read();
            if (done) {
              // Flush any bytes the streaming decoder is still holding (a
              // multi-byte char split across the final reads), then drain the
              // trailing partial SSE event so the last delta isn't dropped.
              sseBuffer += decoder.decode();
              emitSseEvents(sseBuffer, controller, encoder);
              controller.enqueue(encoder.encode(`${JSON.stringify({ done: true })}\n`));
              controller.close();
              return;
            }
            sseBuffer += decoder.decode(value, { stream: true });
            const events = sseBuffer.split("\n\n");
            sseBuffer = events.pop() ?? "";
            for (const eventBlock of events) {
              emitSseEvents(eventBlock, controller, encoder);
            }
          },
          // Consumer aborted (James interrupted, nav away). Cancel the keyed
          // upstream body so we don't leak the OpenAI connection.
          cancel() {
            void reader.cancel().catch(() => {});
          },
        });

        return new Response(out, {
          status: 200,
          headers: withCors({
            "content-type": "application/x-ndjson",
            "cache-control": "no-cache",
            "x-accel-buffering": "no",
          }),
        });
      },
    },
  },
});

// Parse one SSE event block (lines split on \n) and enqueue any
// `choices[0].delta.content` as an NDJSON line. Shared between the live `pull`
// path and the EOF flush so the trailing partial event isn't dropped.
function emitSseEvents(
  eventBlock: string,
  controller: ReadableStreamDefaultController<Uint8Array>,
  encoder: TextEncoder,
): void {
  for (const line of eventBlock.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    const payloadText = trimmed.slice(5).trim();
    if (!payloadText || payloadText === "[DONE]") continue;
    try {
      const event = JSON.parse(payloadText) as {
        choices?: Array<{ delta?: { content?: string } }>;
      };
      const delta = event.choices?.[0]?.delta?.content;
      if (typeof delta === "string" && delta.length > 0) {
        controller.enqueue(encoder.encode(`${JSON.stringify({ delta })}\n`));
      }
    } catch {
      /* ignore malformed events */
    }
  }
}

function errorResponse(status: number, error: string): Response {
  return new Response(JSON.stringify({ error }), {
    status,
    headers: withCors({ "content-type": "application/json" }),
  });
}
