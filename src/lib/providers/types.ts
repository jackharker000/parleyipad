/**
 * Provider-neutral types shared by LLM, STT, and TTS interfaces.
 * Implementations live next to their interface (llm-anthropic.ts, etc.) and
 * are selected at runtime from settings.
 */

export type ChatRole = "system" | "user" | "assistant";

export type ChatMessage = {
  role: ChatRole;
  content: string;
};

export type LLMRequest = {
  messages: ChatMessage[];
  /** Cap on output tokens. */
  maxTokens?: number;
  /** 0 = deterministic, 1 = creative. Live suggestions usually run hot. */
  temperature?: number;
  /** Hint to the provider that the system prompt should be cached. */
  cacheSystem?: boolean;
  /** Which model tier the caller wants: "fast" for live, "smart" for batch. */
  tier?: "fast" | "smart";
  /** AbortSignal so the caller can cancel before the response lands. */
  signal?: AbortSignal;
};

export type LLMResponse = {
  text: string;
  usage?: {
    inputTokens: number;
    outputTokens: number;
    cachedInputTokens?: number;
  };
};

export interface LLMProvider {
  readonly id: string;
  complete(request: LLMRequest): Promise<LLMResponse>;
  /** Yields chunks of text as they arrive. */
  stream(request: LLMRequest): AsyncIterable<string>;
}

export type STTSegment = {
  startMs: number;
  endMs: number;
  text: string;
  /** Optional STT-provider speaker tag — we ignore this and use our own VAD+ID. */
  externalSpeakerTag?: string;
};

export type STTRequest = {
  audio: Blob;
  sampleRate: number;
  signal?: AbortSignal;
};

export interface STTProvider {
  readonly id: string;
  transcribe(request: STTRequest): Promise<{ segments: STTSegment[] }>;
}

export type TTSRequest = {
  text: string;
  voiceId: string;
  signal?: AbortSignal;
};

export interface TTSProvider {
  readonly id: string;
  /** Returns audio as a streamed sequence of PCM/MP3 chunks. */
  stream(request: TTSRequest): AsyncIterable<Uint8Array>;
}
