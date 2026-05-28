import { createFileRoute } from "@tanstack/react-router";

import { corsPreflight, withCors } from "@/lib/api-cors";

/**
 * Anthropic Messages API proxy. The browser sends an `LLMRequest`
 * (see `src/lib/providers/types.ts`) plus `stream?: boolean`; we read
 * `ANTHROPIC_API_KEY` from the server env and forward to Anthropic.
 *
 * Prompt caching: when `cacheSystem === true`, we wrap the system block
 * with `cache_control: { type: "ephemeral" }` so the persona block gets
 * cached across turns. Anthropic charges ~10% of input cost on cache hits.
 *
 * Streaming: when `stream === true` we re-emit each `content_block_delta`
 * as `data: {"delta":"..."}\n\n` SSE lines, matching the client parser.
 */

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";

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
    max_tokens: body.maxTokens ?? 1024,
    temperature: body.temperature ?? 0.7,
    ...(systemParts.length > 0 ? { system: systemParts } : {}),
    messages,
  };
}

export const Route = createFileRoute("/api/llm/anthropic")({
  server: {
    handlers: {
      OPTIONS: corsPreflight,
      POST: async ({ request }) => {
        const apiKey = process.env.ANTHROPIC_API_KEY;
        if (!apiKey) return errorResponse(500, "ANTHROPIC_API_KEY not set on the server");

        let body: RequestBody;
        try {
          body = (await request.json()) as RequestBody;
        } catch {
          return errorResponse(400, "Body must be JSON");
        }

        const stream = !!body.stream;
        const payload = buildAnthropicPayload(body);

        const upstream = await fetch(ANTHROPIC_URL, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-api-key": apiKey,
            "anthropic-version": ANTHROPIC_VERSION,
            ...(body.cacheSystem ? { "anthropic-beta": "prompt-caching-2024-07-31" } : {}),
          },
          body: JSON.stringify({ ...payload, stream }),
        });

        if (!upstream.ok) {
          const text = await upstream.text();
          return errorResponse(upstream.status, `Anthropic ${upstream.status}: ${text}`);
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
            { headers: withCors() },
          );
        }

        // Stream re-emit: Anthropic sends SSE with several event types; we
        // only forward content_block_delta text. The client parser
        // (`AnthropicLLM.stream`) reads `data: {"delta":"..."}` lines.
        const reader = upstream.body!.getReader();
        const decoder = new TextDecoder();
        const encoder = new TextEncoder();

        const out = new ReadableStream({
          async pull(controller) {
            const { done, value } = await reader.read();
            if (done) {
              controller.close();
              return;
            }
            const chunk = decoder.decode(value, { stream: true });
            for (const line of chunk.split("\n")) {
              const trimmed = line.trim();
              if (!trimmed.startsWith("data:")) continue;
              const payloadText = trimmed.slice(5).trim();
              if (!payloadText || payloadText === "[DONE]") continue;
              try {
                const event = JSON.parse(payloadText) as {
                  type?: string;
                  delta?: { type?: string; text?: string };
                };
                if (event.type === "content_block_delta" && event.delta?.text) {
                  controller.enqueue(
                    encoder.encode(`data: ${JSON.stringify({ delta: event.delta.text })}\n\n`),
                  );
                }
              } catch {
                /* ignore malformed events */
              }
            }
          },
        });

        return new Response(out, {
          status: 200,
          headers: withCors({
            "content-type": "text/event-stream",
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
