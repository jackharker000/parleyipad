import type { TTSProvider, TTSRequest } from "./types";

/**
 * ElevenLabs Flash v2.5 over a streaming endpoint. The server function opens
 * the WebSocket / streaming HTTP connection upstream and forwards binary
 * audio chunks back to the browser. We pre-cache the canned quick phrases
 * elsewhere (`src/lib/audio/quick-phrase-cache.ts`, build order step 3).
 */
export class ElevenLabsFlashTTS implements TTSProvider {
  readonly id = "elevenlabs-flash";

  async *stream(request: TTSRequest): AsyncIterable<Uint8Array> {
    const res = await fetch("/api/tts/elevenlabs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: request.text, voiceId: request.voiceId }),
      signal: request.signal,
    });
    if (!res.ok || !res.body) {
      throw new Error(`Flash TTS proxy ${res.status}: ${await res.text()}`);
    }
    const reader = res.body.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) yield value;
      }
    } finally {
      // James interrupts mid-utterance often; cancel the reader so the keyed
      // upstream TTS stream is released instead of leaking a connection.
      try {
        await reader.cancel();
      } catch {
        /* already closed */
      }
    }
  }
}
