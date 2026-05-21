import type { LLMProvider, LLMRequest, LLMResponse } from "./types";

/**
 * OpenAI LLM proxied through /api/llm/openai. Same shape as the Anthropic
 * client — server picks the model based on `tier`. We don't expose prompt
 * caching here (OpenAI handles it implicitly for repeated prefixes).
 */
export class OpenAILLM implements LLMProvider {
  readonly id = "openai";

  async complete(request: LLMRequest): Promise<LLMResponse> {
    const res = await fetch("/api/llm/openai", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...request, stream: false }),
      signal: request.signal,
    });
    if (!res.ok) throw new Error(`OpenAI proxy ${res.status}: ${await res.text()}`);
    return (await res.json()) as LLMResponse;
  }

  async *stream(request: LLMRequest): AsyncIterable<string> {
    const res = await fetch("/api/llm/openai", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...request, stream: true }),
      signal: request.signal,
    });
    if (!res.ok || !res.body) {
      throw new Error(`OpenAI proxy ${res.status}: ${await res.text()}`);
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
