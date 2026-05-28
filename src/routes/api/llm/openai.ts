import { createFileRoute } from "@tanstack/react-router";

import { corsPreflight, withCors } from "@/lib/api-cors";

/**
 * OpenAI Chat Completions proxy. Same request shape as the Anthropic
 * proxy. OpenAI handles prompt-prefix caching implicitly so we don't
 * need to mark anything explicitly.
 */

const OPENAI_URL = "https://api.openai.com/v1/chat/completions";

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
      OPTIONS: corsPreflight,
      POST: async ({ request }) => {
        const apiKey = process.env.OPENAI_API_KEY;
        if (!apiKey) return errorResponse(500, "OPENAI_API_KEY not set on the server");

        let body: RequestBody;
        try {
          body = (await request.json()) as RequestBody;
        } catch {
          return errorResponse(400, "Body must be JSON");
        }

        const stream = !!body.stream;
        const payload = {
          model: modelFor(body.tier),
          messages: body.messages,
          temperature: body.temperature ?? 0.7,
          max_tokens: body.maxTokens ?? 1024,
          ...(stream ? { stream: true } : {}),
        };

        const upstream = await fetch(OPENAI_URL, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify(payload),
        });

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

        // Stream re-emit: OpenAI sends SSE with `choices[0].delta.content`.
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
                  choices?: Array<{ delta?: { content?: string } }>;
                };
                const delta = event.choices?.[0]?.delta?.content;
                if (delta) {
                  controller.enqueue(encoder.encode(`data: ${JSON.stringify({ delta })}\n\n`));
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
