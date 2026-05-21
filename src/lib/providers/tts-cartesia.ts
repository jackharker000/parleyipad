import type { TTSProvider, TTSRequest } from "./types";

/**
 * Cartesia Sonic 3 — the latency fallback. Same shape as the ElevenLabs
 * adapter, different upstream. Useful if ElevenLabs goes slow or throws.
 */
export class CartesiaSonicTTS implements TTSProvider {
  readonly id = "cartesia-sonic";

  async *stream(request: TTSRequest): AsyncIterable<Uint8Array> {
    const res = await fetch("/api/tts/cartesia", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: request.text, voiceId: request.voiceId }),
      signal: request.signal,
    });
    if (!res.ok || !res.body) {
      throw new Error(`Cartesia proxy ${res.status}: ${await res.text()}`);
    }
    const reader = res.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) yield value;
    }
  }
}
