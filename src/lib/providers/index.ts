import type { LLMProviderId, STTProviderId, TTSProviderId } from "@/lib/db";
import { AnthropicLLM } from "./llm-anthropic";
import { OpenAILLM } from "./llm-openai";
import { ElevenLabsScribeSTT } from "./stt-elevenlabs";
import { ElevenLabsFlashTTS } from "./tts-elevenlabs";
import { CartesiaSonicTTS } from "./tts-cartesia";
import type { LLMProvider, STTProvider, TTSProvider } from "./types";

export function makeLLM(id: LLMProviderId): LLMProvider {
  switch (id) {
    case "anthropic":
      return new AnthropicLLM();
    case "openai":
      return new OpenAILLM();
  }
}

export function makeSTT(id: STTProviderId): STTProvider {
  switch (id) {
    case "elevenlabs-scribe":
      return new ElevenLabsScribeSTT();
  }
}

export function makeTTS(id: TTSProviderId): TTSProvider {
  switch (id) {
    case "elevenlabs-flash":
      return new ElevenLabsFlashTTS();
    case "cartesia-sonic":
      return new CartesiaSonicTTS();
  }
}

export type { LLMProvider, STTProvider, TTSProvider } from "./types";
