import { createFileRoute } from "@tanstack/react-router";

/**
 * Edge proxy for the Anthropic Messages API. Reads `ANTHROPIC_API_KEY` from
 * the server environment, never from the client. The body is `LLMRequest`
 * from `@/lib/providers/types` plus a `stream` flag.
 *
 * Wired up in step 3 of the build order. Today it returns 501 so the
 * provider layer compiles end-to-end.
 */
export const Route = createFileRoute("/api/llm/anthropic")({
  server: {
    handlers: {
      POST: async () => {
        return new Response(
          JSON.stringify({
            error:
              "Anthropic proxy not wired yet. Implement using process.env.ANTHROPIC_API_KEY in step 3 (Live cockpit).",
          }),
          { status: 501, headers: { "content-type": "application/json" } },
        );
      },
    },
  },
});
