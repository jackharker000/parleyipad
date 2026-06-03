# Parley — AAC Reply Copilot

This file orients Claude Code on the project. Read it first, then `Parley_Approach_and_Options.md` for the full reasoning. The screen tour (`Parley_Screens_Annotated.pdf`) and design brief (`Parley_Design_Brief.pdf`) describe the _prototype_ and pin the locked cockpit UX — rebuild the engine, not the UX.

## What this is

Parley is an iPad-first AAC (Augmentative and Alternative Communication) copilot. The cockpit listens to a conversation, transcribes in real time, identifies who is speaking, and offers tappable, contextually-aware reply suggestions that the user speaks aloud via TTS in a cloned version of their own voice.

The first user is James — a non-verbal man with cerebral palsy and impaired motor control — and his voice, profile, and people are still our north star for what "good" feels like. The app itself is now multi-user: other non-speaking people and their families sign in to their own account and run their own cockpit on their own iPad.

A prototype was built in Lovable but is too slow and unreliable. This is a clean rebuild. The functional design (cockpit layout, mood selector, quick phrases, speaker panel states, helper tabs, settings tabs) is sound and stays as designed. The _engine_ is what changes.

## Hard context (decided, do not relitigate without asking)

- **Multi-user behind an ON-DEVICE login.** No third-party identity provider — accounts live in IndexedDB on each device (PBKDF2-hashed passwords, `src/lib/auth-local.ts`), session in localStorage, client-side route guards. The first account created on a device is the admin. Cross-device sync and any central user directory are explicitly future, separately-scoped work — there is no server. Speaker-ID still on-device; API keys still never in the client.
- **Top priority: speaker-ID accuracy.** This is the most-broken part of the prototype (mean-MFCC + cosine was the root cause, not a threshold problem). Fix it first.
- **Latency matters intensely.** The user feels every extra second. Suggestions land within 1–2s of a speaker finishing.
- **The UI layout and feature set are already designed and liked** — see `Parley_Screens_Annotated.pdf` and `Parley_Design_Brief.pdf`. Rebuild the engine, not the cockpit UX. The marketing site and admin dashboard are new surfaces and have their own designs.
- **API keys never live in the iPad client.** They sit behind small server functions / API routes (TanStack Start). Provider switching is a settings change, not a key swap.
- **Vendor-neutral on the AI/audio path.** Drop Lovable Gateway and Lovable Cloud. No Supabase. No third-party backend. Auth, app data, and admin views are all on-device.
- **We pair on this.** Claude writes most code; the human edits, runs, and deploys. Prefer clean, conventional patterns over clever ones.

## Route map

The app is one TanStack Start project with three surfaces. URLs are the source of truth — file paths under `src/routes/` follow the standard file-based-routing convention.

- **Public marketing** (no login): `/`, `/how-it-works`, `/features`, `/story`, `/privacy`, `/get-started`.
- **Auth**: `/login`, `/signup`. (No `/auth/callback` — there is no email confirmation.)
- **App** (login-gated, client-side, by `beforeLoad` in `src/routes/app.tsx`): `/app`, `/app/people`, `/app/events`, `/app/recent`, `/app/helpers`, `/app/settings`, `/app/spike/speaker-id`.
- **Admin** (admin-only, client-side, by `beforeLoad` in `src/routes/admin.tsx`): `/admin`, `/admin/users`, `/admin/users/$userId`, `/admin/usage`. The admin view shows only the accounts on the current device — there is no central directory without a backend.
- **API** (keyed server routes): `/api/llm/*`, `/api/stt/*`, `/api/tts/*`, `/api/embed/*`, `/api/waitlist`. The waitlist route exists but does not persist (validates + logs + returns ok — no backend).

## Auth model

Authentication is fully on-device. There is no identity provider and no auth server: accounts live in IndexedDB on each device (PBKDF2-hashed passwords), the session lives in localStorage, and route guards run client-side. The trust boundary is the device itself — like a screen lock, not a server boundary — which is the right shape for a local-first app.

- **LocalUser** is the canonical shape:
  ```ts
  type LocalUser = { id: string; email: string | null; is_admin: boolean };
  ```
- **`useLocalSession()`** is the canonical client-side session reader — components and route guards use it to get the signed-in `LocalUser` (or `null`).
- **`signUp` / `signIn` / `signOut` / `listLocalAccounts`** from `@/lib/auth-local` are the account operations. `signUp` creates an account in IndexedDB; `signIn` verifies the PBKDF2 hash; `signOut` clears the localStorage session; `listLocalAccounts` enumerates the accounts on this device (used by the admin view).
- **First account is admin.** The first account created on a device is bootstrapped as the admin automatically — no promotion step, no SQL. Subsequent accounts on the same device are non-admin.
- **Guards are client-side.** `beforeLoad` in `src/routes/app.tsx` gates `/app/*` on a session; `beforeLoad` in `src/routes/admin.tsx` gates `/admin/*` on `is_admin`. Because everything is local-first there is no server-side trust boundary to re-check against — the device is the boundary.

## Target architecture

### Frontend

- **React 19 + TanStack Start v1**, Tailwind v4 with the existing Slate & Sun oklch palette.
- **Local-first with Dexie/IndexedDB** for cockpit data — but a **single clean schema**, not the prototype's 9 versions. Add tables (people, voiceprints, conversations, turns, suggestions, suggestions_log, memories, follow_ups, style_profile, james_profile, locations, events, document blobs, settings) as the features that need them land. IndexedDB never round-trips through Supabase.
- **Local-first PWA wrapped with Capacitor** as a native iPad app. Full-screen, reliable mic, on-device IndexedDB. Hosting is a thin Vercel edge runtime for the keyed API calls and the marketing/auth/admin pages.

### Speaker ID (build this first)

- **Silero VAD** (ONNX) for clean segmentation. Replaces energy-based silence detection.
- **ECAPA-TDNN (or ECAPA2)** exported to ONNX, run via **ONNX Runtime Web + WebGPU**. ~192-dim speaker embeddings, on-device. Replaces the prototype's mean-MFCC + cosine.
- **Enrollment** per known person — multiple short, clean samples captured _in the room the user is in_ (not long studio takes). Centroid = mean of enrolled embeddings.
- **Bayesian context-prior matcher**:
  ```
  posterior(person) ∝ likelihood(voice | person) × prior(person | place, event, recent speakers)
  ```
  Cosine similarity → calibrated likelihood (sharp-temp softmax). Prior boosts people associated with the active location, expected at the active event, or recently heard. An explicit "unknown speaker" candidate keeps mass for new voices.
- **Online assignment** during the conversation drives the Speaker Panel's Unknown / Suggested / Confirmed states.
- **Post-conversation re-clustering** (Tier 2) cleans up labels with full-conversation hindsight. Online seeds; offline corrects.
- **LLM tie-breaker** (`identifySpeakerFromContext`) stays as a fallback when voice + prior are genuinely ambiguous (e.g. siblings with similar voices).

### Audio pipeline

- **AudioWorklet** for mic capture (not the deprecated `ScriptProcessorNode`, which jankes the UI).
- **Web Worker / WebGPU** for VAD + embedding compute so the main thread stays free.
- iPad Safari may force 44.1/48 kHz — resample to 16 kHz before VAD/embedder.

### Suggestions

- **Turn-triggered, not 1.5s polling.** VAD signals turn end → debounce briefly → generate once.
- **Prompt caching on the large persona block** (Anthropic `cache_control: ephemeral`; OpenAI handles repeated prefixes implicitly). Cuts long-prompt latency ~85% and cost ~90%.
- **Retrieve only the relevant memories** (semantic top-K), not the whole user-context bundle.
- **Structured outputs** via tool-use / JSON-mode so suggestions arrive in a guaranteed shape (no free-text parsing).
- **Graceful degradation**: when the AI provider errors or times out, quick phrases + typed-text-to-speech + cached audio still work. The user is never left silent.

### LLMProvider abstraction

One **domain-level** provider interface — methods are app-shaped, not raw chat:

```
generateSuggestions, summarizeConversation, expandUtterance, draftReply,
extractInterests, generateEventPrep, identifySpeakerFromContext,
enrichPersonProfile, detectIntroductions, aiRediarizeTieBreaker
```

Two implementations: **Anthropic** (Claude) and **OpenAI** (GPT). Selectable in Settings. Each call picks the right model tier:

- **Fast model** (Haiku / GPT-mini class) for live suggestions + expand. Latency dominates.
- **Smart model** (Sonnet/Opus / GPT flagship) for summaries, drafts, event prep, profile enrichment. Quality dominates.

API keys live in `process.env` on the server only. Every provider call goes through `/api/*` routes that hold the keys and forward upstream.

### STT

- **ElevenLabs Scribe** to start. Behind an STT provider interface so we can swap.
- Worth a later spike: **Deepgram** (live-streaming latency leader) and **Apple on-device** (once we're inside the Capacitor wrap — zero network, zero per-minute cost).

### TTS

- **ElevenLabs Flash v2.5 over streaming WebSocket** — ~75 ms model latency, plays as it streams. Keeps the user's cloned voice identity (the whole point of the app).
- **Cartesia Sonic 3** behind the same interface as the latency fallback.
- **Pre-synthesise + cache the five quick phrases** ("Yes", "No", "Give me a moment", "Could you repeat that?", "Sorry, who am I speaking with?") as on-device audio — zero network latency on the turns that matter most.
- **Cache TTS output for repeated suggestions** so common replies don't re-synthesise.

## Recommended build order

1. **Clean skeleton** — React/TanStack, single clean schema, LLM/STT/TTS provider interfaces stubbed.
2. **Speaker-ID spike** — VAD + ECAPA on-device + enrollment + context-prior matcher. Validate accuracy in isolation, in the actual room, before wiring the rest. This is the #1 risk.
3. **Live cockpit** — turn-triggered suggestions with prompt caching + structured outputs, streaming Flash TTS with pre-cached quick phrases, AudioWorklet capture, online speaker assignment.
4. **Settings, People, Locations, Events** — rebuilt on the clean schema. Layout unchanged from `Parley_Screens_Annotated.pdf`.
5. **Helpers + Recent** — reuse the provider layer.
6. **Capacitor wrap + edge proxy + on-device backup/export.** Test mic + AudioWorklet + WebGPU on the real device early.

Tier 1 (style-evidence feedback loop), Tier 2 (post-conversation re-diarize + voiceprint rebuild + profile enrichment + introduction detection), and Tier 3 (semantic memory retrieval) all stay as designed in the prototype — they're correct concepts, they just hang off the new engine.

## Reference files in this folder

- `Parley_Approach_and_Options.md` — full rationale for every engine decision above. **Master plan.**
- `Parley_Design_Brief.pdf` — original functional spec from the prototype. Use for _what_ to build (cockpit functions/layout) — ignore the prototype's mean-MFCC / Meyda / Lovable-Gateway tech choices.
- `Parley_Screens_Annotated.pdf` — annotated screen-by-screen UI tour of the cockpit. UX source of truth for `/app/*`.
- `docs/setup.md` — first-time setup, on-device accounts, admin bootstrap, dev/typecheck/build/deploy.

## Decisions

A running log of choices that closed open questions in the approach doc.

- **21 May 2026 — Capacitor wrap timing — PWA first.** Ship the working web app first; wrap with Capacitor for iPad once the core (speaker-ID + live cockpit) is solid. Test mic + AudioWorklet + WebGPU on the real device as soon as the wrap exists.
- **21 May 2026 — STT — stay on ElevenLabs Scribe.** Revisit Apple on-device only after the Capacitor wrap is in place.
- **21 May 2026 — Backup — encrypted local file export, no cloud backend.** Each user can export their Dexie DB to an encrypted file they save via the Files app / iCloud Drive on their own. No server-side backup.
- **21 May 2026 — Default models.** Provider default is **Claude**. Fast slot = Claude Haiku (live suggestions, expand). Smart slot = Claude Sonnet (summaries, drafts, event prep, profile enrichment). **OpenAI** is the switchable alternative — a mini model in the fast slot, a flagship model in the smart slot. All API keys stay server-side; the client only knows which provider name to send to which `/api/*` route.
- **3 June 2026 — Pivot to multi-user behind a login.** The earlier "single user, no login, local-first only" framing was superseded so Parley can reach more non-speaking people than just James: a real account boundary, a linkable marketing surface, a waitlist, and an admin view. Cockpit data stays local-first (Dexie/IndexedDB), speaker-ID stays on-device, latency-first still wins all ties, and the cockpit UX is unchanged. New surfaces: the public marketing site at `/`, the `/app/*` login-gated cockpit, the `/admin/*` dashboard, and a `/api/waitlist` endpoint. (The original framing of this pivot routed auth and the waitlist through Supabase — see the 3 June entry below, which reversed that.)
- **3 June 2026 — Auth is on-device; no Supabase, no third-party services.** At the owner's request ("don't have third-party services, build the login myself"), the brief Supabase-auth framing of the pivot above is reversed. Authentication is now fully local: accounts in IndexedDB with PBKDF2-hashed passwords (`src/lib/auth-local.ts`), session in localStorage, client-side route guards, first-account-on-a-device is the admin. What this costs: no central user directory (the admin view sees only the current device's accounts), no cross-device user list, and the waitlist form no longer persists (the `/api/waitlist` route validates + logs + returns ok, with no store behind it — future work). What it keeps: zero auth config, a fully local app, and no auth secrets to manage. Cross-device sync of any data remains separately-scoped future work — there is no server for the cockpit or for identity.

## Working agreement

- Don't change the agreed cockpit UX without flagging it. The marketing site and admin dashboard have more design latitude — flag the bigger moves.
- Keep API keys out of client code. Anything prefixed `VITE_` is shipped in the browser bundle and visible to anyone — never put a secret there.
- Cockpit data and accounts stay on-device (Dexie/IndexedDB). Don't push conversations, turns, voiceprints, memories, or accounts into any third-party backend. There is no server for this data.
- Auth is on-device, so the device is the trust boundary. Don't re-introduce a server-side identity store or admin re-check without flagging it — there is no server to check against.
- When in doubt about scope, remember: speaker-ID first, latency always, on-device for the cockpit.
- Anything _removed_ from the prototype design (MFCC, Lovable, 9-version schema, 1.5s polling, ScriptProcessorNode, `synthesizeSpeech` returning a full base64 MP3) is a deliberate downgrade-then-replace, not a regression. Don't re-add without asking.
