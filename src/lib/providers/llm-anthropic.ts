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

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        const payload = trimmed.slice(5).trim();
        if (!payload || payload === "[DONE]") continue;
        try {
          const json = JSON.parse(payload) as { delta?: string };
          if (json.delta) yield json.delta;
        } catch {
          /* ignore malformed lines */
        }
      }
    }
  }
}
