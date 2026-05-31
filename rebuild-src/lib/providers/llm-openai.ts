import type { LLMProvider, LLMRequest, LLMResponse } from "./types";

/**
 * OpenAI LLM proxied through /api/llm/openai. Same shape as the Anthropic
 * client — server picks the model based on `tier`. We don't expose prompt
 * caching here (OpenAI handles it implicitly for repeated prefixes).
 */

// Client-side wall-clock bound on the live path. See AnthropicLLM for the
// rationale: the server times out its own upstream, but a stall in the proxy
// hop itself must still reject so the caller's catch fires and the "never go
// silent" degradation path (quick phrases / typed TTS) takes over.
const LIVE_TIMEOUT_MS = 12_000;

export class OpenAILLM implements LLMProvider {
  readonly id = "openai";

  async complete(request: LLMRequest): Promise<LLMResponse> {
    const { signal, dispose } = withTimeoutSignal(request.signal, LIVE_TIMEOUT_MS);
    try {
      const res = await fetch("/api/llm/openai", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...request, stream: false }),
        signal,
      });
      if (!res.ok) throw new Error(`OpenAI proxy ${res.status}: ${await res.text()}`);
      return (await res.json()) as LLMResponse;
    } finally {
      dispose();
    }
  }

  async *stream(request: LLMRequest): AsyncIterable<string> {
    const { signal, dispose } = withTimeoutSignal(request.signal, LIVE_TIMEOUT_MS);
    try {
      const res = await fetch("/api/llm/openai", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...request, stream: true }),
        signal,
      });
      if (!res.ok || !res.body) {
        throw new Error(`OpenAI proxy ${res.status}: ${await res.text()}`);
      }

      // NDJSON: one JSON object per line. `{"delta":"..."}` -> string chunk;
      // `{"done":true}` (or EOF) ends the stream.
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            // Flush bytes the streaming decoder is still holding (a multi-byte
            // char split across the final reads) before draining the tail line.
            buffer += decoder.decode();
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
      } finally {
        // Early break (James interrupts) or throw must cancel the reader so the
        // keyed upstream body is released.
        try {
          await reader.cancel();
        } catch {
          /* already closed */
        }
      }
    } finally {
      dispose();
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

/**
 * Combine an optional caller AbortSignal with a wall-clock timeout. The fetch
 * aborts on whichever fires first; `dispose()` clears the timer so a completed
 * call doesn't leave a pending timeout firing into the void. Falls back to a
 * bare timeout signal when the runtime lacks `AbortSignal.any` (older Safari).
 */
function withTimeoutSignal(
  caller: AbortSignal | undefined,
  ms: number,
): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new DOMException("timeout", "TimeoutError")), ms);
  const dispose = () => clearTimeout(timer);
  if (!caller) return { signal: controller.signal, dispose };
  if (typeof AbortSignal.any === "function") {
    return { signal: AbortSignal.any([caller, controller.signal]), dispose };
  }
  // Fallback: forward the caller's abort into our controller.
  if (caller.aborted) controller.abort(caller.reason);
  else caller.addEventListener("abort", () => controller.abort(caller.reason), { once: true });
  return { signal: controller.signal, dispose };
}
