import type { LLMProvider, LLMRequest, LLMResponse } from "./types";

/**
 * Anthropic LLM proxied through /api/llm/anthropic. The server function
 * holds the API key, the browser never sees it.
 *
 * The proxy is expected to:
 *   1. Forward `messages` straight through to the Anthropic Messages API.
 *   2. Set `cache_control: { type: "ephemeral" }` on the system block when
 *      `request.cacheSystem === true`, so the persona block gets cached.
 *   3. Pick a model based on `request.tier` (fast vs smart) using server-side
 *      env vars (PARLEY_ANTHROPIC_FAST_MODEL, PARLEY_ANTHROPIC_SMART_MODEL).
 */
export class AnthropicLLM implements LLMProvider {
  readonly id = "anthropic";

  async complete(request: LLMRequest): Promise<LLMResponse> {
    const res = await fetch("/api/llm/anthropic", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...request, stream: false }),
      signal: request.signal,
    });
    if (!res.ok) throw new Error(`Anthropic proxy ${res.status}: ${await res.text()}`);
    return (await res.json()) as LLMResponse;
  }

  async *stream(request: LLMRequest): AsyncIterable<string> {
    const res = await fetch("/api/llm/anthropic", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...request, stream: true }),
      signal: request.signal,
    });
    if (!res.ok || !res.body) {
      throw new Error(`Anthropic proxy ${res.status}: ${await res.text()}`);
    }

    // NDJSON: one JSON object per line. Each `{"delta":"..."}` yields a
    // string chunk; `{"done":true}` (or EOF) ends the stream.
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        if (buffer.trim().length > 0) {
          const tail = parseDeltaLine(buffer);
          if (tail) yield tail;
        }
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const delta = parseDeltaLine(line);
        if (delta) yield delta;
      }
    }
  }
}

function parseDeltaLine(line: string): string | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    const json = JSON.parse(trimmed) as { delta?: unknown; done?: unknown };
    if (typeof json.delta === "string" && json.delta.length > 0) return json.delta;
  } catch {
    /* ignore malformed lines */
  }
  return null;
}
