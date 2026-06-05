# Parley — AAC Reply Copilot

This file orients Claude Code on the project. Read it first, then `Parley_Approach_and_Options.md` for the full reasoning. The screen tour (`Parley_Screens_Annotated.pdf`) and design brief (`Parley_Design_Brief.pdf`) describe the _prototype_ and pin the locked cockpit UX — rebuild the engine, not the UX.

## What this is

Parley is an iPad-first AAC (Augmentative and Alternative Communication) copilot. The cockpit listens to a conversation, transcribes in real time, identifies who is speaking, and offers tappable, contextually-aware reply suggestions that the user speaks aloud via TTS in a cloned version of their own voice.

The first user is James — a non-verbal man with cerebral palsy and impaired motor control — and his voice, profile, and people are still our north star for what "good" feels like. The app itself is now multi-user: other non-speaking people and their families sign in to their own account and run their own cockpit on their own iPad.

A prototype was built in Lovable but is too slow and unreliable. This is a clean rebuild. The functional design (cockpit layout, mood selector, quick phrases, speaker panel states, helper tabs, settings tabs) is sound and stays as designed. The _engine_ is what changes.

## Hard context (decided, do not relitigate without asking)

- **Multi-user behind a login via Firebase Auth (Google).** Sign-in is client-side Firebase Auth (email/password). Admin is a Firebase custom claim (`admin: true`); accounts on the `PARLEY_ADMIN_EMAILS` allow-list are auto-promoted, and the first account in the project is the bootstrap fallback. Server-side admin ops + the waitlist use the Firebase Admin SDK (a service account, server-only). Speaker-ID (the ONNX model and the matching computation) still runs on-device; API keys still never live in the client. Cockpit data syncs to Firebase by default — per-user Firestore subtrees for text (transcripts, voiceprint metadata, profile, style profile, memories, follow-ups, suggestions log, people, places, events, helper drafts, settings) plus Firebase Storage for audio blobs (voice samples and cached quick-phrase TTS). Cloud sync runs for every signed-in account — there's no per-account toggle.
- **Top priority: speaker-ID accuracy.** This is the most-broken part of the prototype (mean-MFCC + cosine was the root cause, not a threshold problem). Fix it first.
- **Latency matters intensely.** The user feels every extra second. Suggestions land within 1–2s of a speaker finishing.
- **The UI layout and feature set are already designed and liked** — see `Parley_Screens_Annotated.pdf` and `Parley_Design_Brief.pdf`. Rebuild the engine, not the cockpit UX. The marketing site and admin dashboard are new surfaces and have their own designs.
- **API keys never live in the iPad client.** They sit behind small server functions / API routes (TanStack Start). Provider switching is a settings change, not a key swap.
- **Vendor-neutral on the AI/audio path.** Drop Lovable Gateway and Lovable Cloud — provider switching (LLM/STT/TTS) is a settings change. Auth, the waitlist, the admin user list, and the per-user cockpit-data sync all run on Firebase (Auth + Firestore + Storage, with the Admin SDK on the server for admin reads and waitlist persistence).
- **We pair on this.** Claude writes most code; the human edits, runs, and deploys. Prefer clean, conventional patterns over clever ones.

## Route map

The app is one TanStack Start project with three surfaces. URLs are the source of truth — file paths under `src/routes/` follow the standard file-based-routing convention.

- **Public marketing** (no login): `/`, `/how-it-works`, `/features`, `/story`, `/privacy`, `/get-started`.
- **Auth**: `/login`, `/signup`. (No `/auth/callback` — there is no email confirmation.)
- **App** (login-gated, client-side, by `beforeLoad` in `src/routes/app.tsx`): `/app`, `/app/people`, `/app/events`, `/app/recent`, `/app/helpers`, `/app/settings`, `/app/spike/speaker-id`.
- **Admin** (admin-only, client-side guard in `src/routes/admin.tsx`; server routes re-verify the ID token + admin claim): `/admin`, `/admin/users`, `/admin/users/$userId`, `/admin/usage`. The admin user list comes from Firebase Auth via the Admin SDK (`/api/admin/*`) — a central, cross-device directory.
- **API** (keyed server routes): `/api/llm/*`, `/api/stt/*`, `/api/tts/*`, `/api/embed/*`, `/api/admin/*`, `/api/auth/ensure-role`, `/api/waitlist`. The waitlist persists to Firestore via the Admin SDK when the service account is configured; without it (e.g. local dev) it validates + logs + returns ok without saving.

## Auth model

Authentication runs on **Firebase Auth** (Google). Sign-in is client-side (email/password); admin privilege is a Firebase custom claim verified server-side. Client route guards gate the UI; the admin API routes re-verify the caller's ID token and admin claim with the Admin SDK, so the real trust boundary is the server, not the browser.

- **SessionUser** is the canonical shape:
  ```ts
  type SessionUser = { id: string; email: string | null; is_admin: boolean };
  ```
- **`useSession()`** from `@/lib/auth` is the canonical client-side session reader — it subscribes to Firebase auth state and reads the `admin` custom claim, returning the signed-in `SessionUser` (or `null`) plus a `loading` flag.
- **`signIn` / `signUp` / `signOut` / `getIdToken`** from `@/lib/auth` are the account operations. `signUp` / `signIn` wrap Firebase email/password auth; `signOut` clears the Firebase session; `getIdToken` returns the current user's Firebase ID token for authenticating calls to `/api/admin/*`.
- **Admin promotion.** Two paths in, both via `/api/auth/ensure-role`, which sets the `admin: true` custom claim through the Admin SDK (the client can't set its own claims) and then prompts the client to refresh its ID token so the claim is visible without re-logging-in. Preferred: the `PARLEY_ADMIN_EMAILS` allow-list — any sign-in matching that list is promoted on the spot. Fallback: the first account created in the Firebase project is auto-promoted. Both require the service account configured.
- **Guards are layered.** `beforeLoad` in `src/routes/app.tsx` gates `/app/*` on a session; `beforeLoad` in `src/routes/admin.tsx` gates `/admin/*` on the admin claim. These guard the UI; the admin server routes (`/api/admin/*`, `/api/auth/ensure-role`) independently verify the ID token + admin claim, which is the authoritative check.

## Sync model

Cockpit data syncs to Firebase by default. Dexie is still the live source of truth — the cockpit reads and writes Dexie, and a write-behind/outbox sync engine in `src/lib/sync/` mirrors changes up to Firebase in the background, retrying on failure. The user never waits on the network.

- **Firestore paths — text data**: `users/{uid}/<table>/{id}`, where `<table>` is the Dexie table name. Conversations, turns, voiceprint metadata, james_profile, style_profile, memories, follow_ups, suggestions_log, people, locations, events, helper drafts, settings — each row mirrors to a doc under that user's subtree.
- **Storage paths — audio blobs**: `users/{uid}/<table>/{id}.bin`. Voice-sample audio (the recordings used to enrol speaker recognition) and cached quick-phrase TTS audio live here. The voiceprint metadata in Firestore points at these blob paths; the speaker-recognition embeddings themselves are computed from the on-device ONNX model — only the underlying audio and the metadata sync.
- **Always on for signed-in users.** Sync runs whenever the account is signed in and Firebase is configured — no per-account toggle, no "pause" affordance. (The `cloudSyncEnabled` field still exists on the settings record for historical reasons but is no longer read by the engine or surfaced in the UI.) Sync is new-only — there's never a backfill.
- **Admin reads bypass user credentials.** The `/admin/*` dashboard hits `/api/admin/*` server routes, which verify the caller's admin claim and then read Firestore/Storage through the **service account** (Admin SDK). This is the only path that crosses user subtrees; the security rules block users from reading anyone else's data directly.
- **Security rules confine users to their own subtree.** See `docs/setup.md` → "Firestore + Storage Security Rules" for the exact rule text. Both Firestore and Storage allow `read, write` only when `request.auth.uid == userId` in the path; waitlist and usage_events are server-write only.
- **Speaker-ID stays on-device.** The ECAPA model, embedding compute, and matcher never leave the iPad. Only the user-generated data (audio + text rows) syncs.

## Target architecture

### Frontend

- **React 19 + TanStack Start v1**, Tailwind v4 with the existing Slate & Sun oklch palette.
- **Local-first with Dexie/IndexedDB** for cockpit data — but a **single clean schema**, not the prototype's 9 versions. Add tables (people, voiceprints, conversations, turns, suggestions, suggestions_log, memories, follow_ups, style_profile, james_profile, locations, events, document blobs, settings) as the features that need them land. Dexie is the source of truth for the live cockpit; a write-behind sync engine mirrors each table up to per-user subtrees in Firebase by default (see "Sync model" below). Toggle off in Settings to stay local-only.
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
- `docs/setup.md` — first-time setup, Firebase project + service-account config, admin bootstrap, dev/typecheck/build/deploy.

## Decisions

A running log of choices that closed open questions in the approach doc.

- **21 May 2026 — Capacitor wrap timing — PWA first.** Ship the working web app first; wrap with Capacitor for iPad once the core (speaker-ID + live cockpit) is solid. Test mic + AudioWorklet + WebGPU on the real device as soon as the wrap exists.
- **21 May 2026 — STT — stay on ElevenLabs Scribe.** Revisit Apple on-device only after the Capacitor wrap is in place.
- **21 May 2026 — Backup — encrypted local file export, no cloud backend.** Each user can export their Dexie DB to an encrypted file they save via the Files app / iCloud Drive on their own. No server-side backup.
- **21 May 2026 — Default models.** Provider default is **Claude**. Fast slot = Claude Haiku (live suggestions, expand). Smart slot = Claude Sonnet (summaries, drafts, event prep, profile enrichment). **OpenAI** is the switchable alternative — a mini model in the fast slot, a flagship model in the smart slot. All API keys stay server-side; the client only knows which provider name to send to which `/api/*` route.
- **3 June 2026 — Pivot to multi-user behind a login.** The earlier "single user, no login, local-first only" framing was superseded so Parley can reach more non-speaking people than just James: a real account boundary, a linkable marketing surface, a waitlist, and an admin view. Cockpit data stays local-first (Dexie/IndexedDB), speaker-ID stays on-device, latency-first still wins all ties, and the cockpit UX is unchanged. New surfaces: the public marketing site at `/`, the `/app/*` login-gated cockpit, the `/admin/*` dashboard, and a `/api/waitlist` endpoint. (The original framing of this pivot routed auth and the waitlist through Supabase — see the 3 June entry below, which reversed that.)
- **3 June 2026 — Auth is on-device; no Supabase, no third-party services.** (Superseded later the same day by the Firebase entry below — kept for history.) At the owner's request ("don't have third-party services, build the login myself"), the brief Supabase-auth framing of the pivot above was reversed. Authentication was made fully local: accounts in IndexedDB with PBKDF2-hashed passwords (`src/lib/auth-local.ts`), session in localStorage, client-side route guards, first-account-on-a-device is the admin. What it cost: no central user directory (the admin view saw only the current device's accounts), no cross-device user list, and a waitlist form that didn't persist. What it kept: zero auth config and no auth secrets to manage.
- **3 June 2026 — Adopt Firebase (Auth + Firestore + Storage).** At the owner's request, after trying Supabase and then on-device auth, Parley moves to Google Firebase. Auth is client-side Firebase Auth (email/password); admin is a custom claim, with the first account in the project auto-promoted by `/api/auth/ensure-role`; server-side admin ops + the waitlist use the Firebase Admin SDK (service account in `FIREBASE_SERVICE_ACCOUNT_B64`, server-only). Chosen for what on-device auth couldn't give: a central, cross-device user list, a persisted waitlist, and a path to syncing cockpit data across devices. This replaces and deletes the on-device auth (`src/lib/auth-local.ts` is gone); `@/lib/auth` (Firebase) is canonical. Trade-off recorded: syncing conversation/voiceprint data to Google is the planned **next** step (not built yet), and that move requires the privacy copy to stay truthful — speaker-ID still runs on-device, but account, waitlist, and (future) synced conversation data live in Firebase, so the site must not claim "nothing leaves your device."
- **5 June 2026 — Cloud sync is always on; the per-account toggle is gone.** The escape valve introduced on 4 June ("flip `cloudSyncEnabled` off in Settings to stay local-only") was removed. AAC-specifically, the question "did my voice samples actually save?" is load-bearing for the user trusting the app, and an off-by-accident state — easy to land on after a `.parlbak` import or a stray tap — was a foot-gun: enrolment data goes in but never makes it off the device, and the user has no obvious recovery path. The engine now starts whenever the user is signed in and Firebase is configured; the System tab's Cloud sync card is status-only (Engine / Pending writes / Last flush / Last error). The `cloudSyncEnabled` field is still on the settings schema for backward compat but is unread — no migration. If a user truly needs local-only operation, the encrypted export already covers data portability; we'll revive a toggle if a real use-case asks for one.
- **5 June 2026 — Auth persists in IndexedDB; PWA `start_url` is `/app`.** Firebase Auth on web defaults to `browserLocalPersistence` (localStorage), which iPad Safari purges under ITP after the ~7-day cap — meaning the home-screen icon dropped the user at `/login` even mid-grace-window. `getFirebaseAuth()` now goes through `initializeAuth(app, { persistence: [indexedDBLocalPersistence, browserLocalPersistence] })` so the session lives in IDB, with localStorage as the fallback if the runtime refuses IDB. The PWA manifest's `start_url` is `/app` so the home-screen icon lands on the cockpit's existing loading gate (which redirects to `/login` on a stale session and renders the cockpit on a live one). `useSession()` also force-refreshes the ID token on `visibilitychange` (visible) and `pageshow` so a long-suspended PWA doesn't surprise the next `/api/admin/*` call with a 401 race.
- **4 June 2026 — Cloud sync of cockpit data is on by default.** The Firebase pivot's "next step" lands: every account, on creation, syncs its cockpit data to per-user Firebase subtrees by default. Firestore holds the text rows under `users/{uid}/<table>/{id}` (conversations, turns, voiceprint metadata, james_profile, style_profile, memories, follow_ups, suggestions_log, people, locations, events, helper drafts, settings); Storage holds the audio blobs under `users/{uid}/<table>/{id}.bin` (voice samples and cached quick-phrase TTS). Dexie stays the live source of truth on the device; a write-behind/outbox engine in `src/lib/sync/` mirrors changes up in the background, so the cockpit never waits on the network. New-only — flipping the toggle later doesn't backfill historical data. Speaker-ID (the ECAPA model and the matching computation) is **not** part of this — it still runs on-device; only user-generated data uploads. Chosen for: cross-device continuity, the admin (currently `jackharker000@gmail.com`) being able to see and help on real accounts via the `/admin/*` dashboard, and a real path to recovery if a device is lost. Trade-offs: voice samples and full conversation transcripts now live in our Firebase project under each user's subtree, so the privacy copy is updated to say so plainly — no "end-to-end encrypted" or "private to you" claims, and the operator's admin reach is stated up front. The per-account `cloudSyncEnabled` setting (default `true`, toggleable in Settings) is the escape valve back to local-only. Security rules in `firestore.rules` + `storage.rules` (see `docs/setup.md`) confine each user to their own subtree; admin cross-user reads only happen server-side via the service account, never with user credentials.

## Working agreement

- Don't change the agreed cockpit UX without flagging it. The marketing site and admin dashboard have more design latitude — flag the bigger moves.
- Keep API keys out of client code. Anything prefixed `VITE_` is shipped in the browser bundle and visible to anyone — never put a secret there.
- Cockpit data (conversations, turns, voiceprints, voice samples, memories, settings, etc.) is Dexie/IndexedDB-first and syncs to per-user Firebase subtrees via the write-behind engine in `src/lib/sync/`. Dexie stays the live source of truth on the device — don't reverse that, don't make the cockpit wait on network round-trips, and don't add a new table without giving the sync engine a path for it. Sync is always on for signed-in users; the legacy `cloudSyncEnabled` field is unread and there is no toggle.
- Auth is Firebase, and the server (Admin SDK, custom claims) is the trust boundary for admin. Keep the service-account credential server-only (never `VITE_`); don't move admin authorization to a client-only check. Admin cross-user reads go through `/api/admin/*` and the service account — never through user credentials, and never by relaxing the security rules.
- Keep the privacy/marketing copy truthful as data moves: speaker-ID (model + matcher) is on-device, but sign-in, the waitlist, and cockpit data (transcripts, voiceprints, voice samples, profile, etc.) all live in Firebase by default. Don't reintroduce "nothing leaves your device" claims, and don't claim end-to-end encryption or full anonymity — the admin can read it.
- When in doubt about scope, remember: speaker-ID first, latency always, Dexie is the live source of truth and sync mirrors behind it.
- Anything _removed_ from the prototype design (MFCC, Lovable, 9-version schema, 1.5s polling, ScriptProcessorNode, `synthesizeSpeech` returning a full base64 MP3) is a deliberate downgrade-then-replace, not a regression. Don't re-add without asking.
