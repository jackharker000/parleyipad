import type { STTProvider, STTRequest, STTSegment } from "./types";

/**
 * ElevenLabs Scribe proxied through /api/stt/elevenlabs. The server endpoint
 * accepts a multipart POST of the audio blob and returns Scribe's segmented
 * JSON straight back. We ignore Scribe's speaker tag — speaker ID is our job.
 */
export class ElevenLabsScribeSTT implements STTProvider {
  readonly id = "elevenlabs-scribe";

  async transcribe(request: STTRequest): Promise<{ segments: STTSegment[] }> {
    const form = new FormData();
    form.append("audio", request.audio);
    form.append("sampleRate", String(request.sampleRate));

    const res = await fetch("/api/stt/elevenlabs", {
      method: "POST",
      body: form,
      signal: request.signal,
    });
    if (!res.ok) throw new Error(`Scribe proxy ${res.status}: ${await res.text()}`);
    const json = (await res.json()) as {
      segments: Array<{ start: number; end: number; text: string; speaker?: string }>;
    };
    return {
      segments: json.segments.map((s) => ({
        startMs: Math.round(s.start * 1000),
        endMs: Math.round(s.end * 1000),
        text: s.text,
        externalSpeakerTag: s.speaker,
      })),
    };
  }
}
