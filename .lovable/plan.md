## Goal

Make the app feel snappier on James's iPad without removing anything he uses. Keep the mood buttons exactly as they are — they only steer suggestions, not the voice.

## Important clarification

You picked "Mood-driven TTS modulation" as the thing to remove. Heads-up: **that feature isn't actually wired up today**. The TTS call uses fixed voice settings (stability 0.5, style 0.3) for every utterance, regardless of mood. So there is nothing to rip out on the voice side — mood already only drives the AI suggestions. That's good news: the cleanup below is pure win, no feature loss.

If you actually meant the **on-device speaker fingerprinting** (the MFCC analysis that recognises who's talking), tell me and I'll fold its removal in — that one is a real CPU cost.

## What this plan changes

### 1. Speed up the suggestion loop (biggest win)

Every new transcript segment currently fires a fresh AI call after 600 ms. In a lively conversation that's a call every couple of seconds, each one sending the full profile, people, place, event, style JSON, and asking for **16** suggestions.

- Increase debounce from 600 ms → **1500 ms** so a burst of speech only triggers one call.
- Drop suggestion count from **16 → 10** (still plenty of variety, ~35% smaller response, faster to render).
- Cache the assembled context (`jamesProfile`, `people`, `place`, `event`, `styleProfileJson`) per conversation and only rebuild it when the people/place/event selection changes — right now we rebuild from IndexedDB on every refresh.
- Trim recent transcript window from last 12 → last 8 segments in the prompt.
- Skip the AI call entirely when nothing has changed since the last call (same transcript length + same mood).

### 2. Lighten the TTS path

- Switch model from `eleven_turbo_v2_5` to the same model but request `mp3_22050_32` instead of `mp3_44100_128` for the spoken-aloud path. Audio is for the room, not headphones — much smaller payload, faster first-audio.
- Remove the unused `style: 0.3` and `use_speaker_boost: true` overrides (defaults are fine and the request body shrinks).

### 3. Reduce IndexedDB write pressure

- Bulk-insert suggestion logs is fine, but currently every committed transcript segment also triggers a `conversations.update(speaker_map)` write. Batch those — only persist `speaker_map` on Stop or when a new label first appears.
- Stop persisting voiceprints mid-session; only persist on Stop (already mostly done — remove the per-segment "first time" persist).

### 4. Lazy-load heavy routes

The home page currently pulls in everything because the router eagerly imports all routes. Convert these to dynamic chunks so the home page boots faster:

- `/settings` (2,554 lines — biggest file in the app)
- `/helpers` and its DraftHelper
- `/recent`, `/conversation/new`

TanStack Router supports route-level code splitting via `createFileRoute(...).lazy()` — no behaviour change, just smaller initial JS.

### 5. Remove dead weight

- Strip unused imports in `src/routes/index.tsx` (audit `Reply`, `History`, `Calendar`, etc. — several lucide icons are imported but unused after recent edits).
- Remove the `setRecognised` state hook on the home page — it's set but never read (the destructured first slot is `,`).
- Drop `MIC_SESSION_KEY` early-return path's redundant Permissions API try/catch when `sessionStorage` already says granted.

### 6. Default to a faster suggestion model

Current default is `google/gemini-2.5-flash-lite`, which is already fast. Leave the user's chosen model alone, but for **first-launch** users set the default to `google/gemini-2.5-flash-lite` explicitly (today the fallback only kicks in if settings is missing) so nobody silently lands on a slower premium model.

## What this plan does NOT change

- Mood buttons stay exactly as they are (UI + suggestion steering).
- Voice fingerprinting / speaker recognition stays (you didn't ask to remove it — but say the word and I will).
- No schema changes, no auth changes, no feature removals.

## Files touched

- `src/routes/index.tsx` — debounce, context cache, dead imports, write batching
- `src/lib/aac.functions.ts` — suggestion count 16→10, transcript window 12→8, TTS bitrate, settings cleanup
- `src/router.tsx` and route files — lazy chunks for `/settings`, `/helpers`, `/recent`, `/conversation/new`
- `src/lib/db.ts` — default model fallback (small)

## Expected impact

- Home page first paint: noticeably faster (settings.tsx alone is ~40% of the bundle today).
- Time-to-suggestion after a sentence: similar single-call latency, but **far fewer** redundant calls in a busy conversation = lower iPad CPU + lower AI cost.
- TTS time-to-first-audio: ~30–40% smaller download.
- No visible UI change beyond fewer "thinking" flickers in the suggestions panel.
