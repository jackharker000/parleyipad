# Parley — AAC Reply Copilot for James

This file orients Claude Code on the project. Read it first, then `Parley_Approach_and_Options.md` for the full reasoning.

## What this is

Parley is an iPad-first AAC (Augmentative and Alternative Communication) copilot for James, a non-verbal man with cerebral palsy and impaired motor control. It listens to a conversation, transcribes in real time, identifies who is speaking, and offers tappable, contextually-aware reply suggestions that James speaks aloud via TTS in a cloned version of his own voice.

A prototype was built in Lovable but is too slow and unreliable. This is a clean rebuild.

## Hard context (decided, do not relitigate without asking)

- **One dedicated iPad, one user (James).** Single-user. No multi-tenant accounts, no row-level security, no cross-device sync machinery. Keep it simple, fast, local-first.
- **Top priority: speaker-ID accuracy.** This is the most-broken part of the prototype and the first thing to get right.
- **Latency matters intensely.** James feels every extra second. Suggestions should appear within 1–2s of a speaker finishing.
- **The UI layout and feature set are already designed and liked** — see `Parley_Screens_Annotated.pdf` and `Parley_Design_Brief.pdf`. Rebuild the _engine_, not the UX.
- **We pair on this.** Claude writes most code; the human edits, runs, and deploys. Prefer clean, conventional patterns over clever ones.

## Target architecture (see approach doc for full reasoning)

- **Frontend:** React 19 + TanStack Start, Tailwind. Local-first with Dexie/IndexedDB — but a single clean schema, not the prototype's 9 versions.
- **Speaker ID (build this first):** on-device neural speaker embeddings (ECAPA-TDNN exported to ONNX, run via ONNX Runtime Web + WebGPU), Silero VAD for segmentation, enrollment of known people, and a Bayesian context prior — `posterior(person) ∝ voiceMatchLikelihood × prior(person | place, event, recentSpeakers)`. Replaces the prototype's mean-MFCC + cosine approach.
- **Suggestions:** turn-triggered (not 1.5s polling), with prompt caching on the large persona block and retrieval for relevant memories.
- **AI providers:** one `LLMProvider` interface with Anthropic and OpenAI implementations, selectable in Settings. Fast model for live suggestions, smart model for summaries/drafts/event prep. **API keys live only behind server functions, never in the client.**
- **STT:** ElevenLabs Scribe to start (consider Deepgram or Apple on-device later).
- **TTS:** ElevenLabs Flash v2.5 over streaming WebSocket; pre-cache the quick phrases. Put TTS behind a small interface too (Cartesia Sonic 3 is the latency fallback).
- **Audio pipeline:** AudioWorklet (not the deprecated ScriptProcessorNode); heavy compute in a Web Worker / WebGPU.
- **Hosting:** local-first PWA wrapped with Capacitor as a native iPad app, plus a thin edge proxy (Vercel/Cloudflare) for the keyed API calls.

## Recommended build order

1. Clean skeleton — React/TanStack, single-version schema, provider interfaces stubbed, vendor-neutral (drop Lovable Gateway/Cloud).
2. **Speaker-ID spike** — VAD + ECAPA embeddings on-device + enrollment + context-prior matcher. Prove accuracy in isolation first.
3. Live cockpit — turn-triggered suggestions, prompt caching, streaming TTS, AudioWorklet capture.
4. Settings / People / Locations / Events on the clean schema (layout unchanged from the screen tour).
5. Helpers + Recent — reuse the provider layer.
6. Capacitor wrap + edge proxy + on-device backup/export.

## Reference files in this folder

- `Parley_Approach_and_Options.md` — full rationale for every decision above. **Start here.**
- `Parley_Design_Brief.pdf` — original functional spec (functions/layout are the source of truth for _what_ to build).
- `Parley_Screens_Annotated.pdf` — annotated screen-by-screen UI tour.

## Working agreement

- Don't change the agreed UX without flagging it.
- Keep API keys out of client code.
- When in doubt about scope, remember: single user, speaker-ID first, latency always.
