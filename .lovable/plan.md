
# AAC Copilot for James — MVP Plan (v3, final)

A tablet-optimized web app for iPad Safari (installable to Home Screen) that helps James participate in live conversations: it listens, transcribes, suggests responses he can tap to speak aloud, and remembers people, places, and past conversations so future prompts get smarter and more "James-like" over time.

Scope: Roadmap Stages 2 + 3 + 4 (core loop, memory, contextual prompt engine), plus data-collection foundations for Stage 6 (James-style personalization) and Stage 8 (manual speaker identity).

## What changed in v3

Confirmed from your last message:
- **Hybrid local-first storage** with cloud-sync toggle.
- **GPS auto-context**: detect place from coordinates, auto-load that place's context.
- **Auto-save summaries**: post-conversation summary + memory candidates persist automatically; review screen is optional, edits happen later.
- **Conversation Prep**: load website / PDF / text / manual notes before a conversation; AI helps James draft a plan of key speaking points.

## Storage model — hybrid

- All conversations, transcripts, people, places, memories, plans, prep documents, and the suggestion-feedback log live in **IndexedDB on the iPad** (via Dexie). Default = nothing leaves the device.
- Live transcript chunks and the small "context packet" still go to ElevenLabs (transcription/TTS) and Lovable AI (suggestions, summaries, prep extraction) per turn — stateless, no provider retention.
- One-tap **Export / Import** (JSON) to iCloud Drive or AirDrop.
- Settings toggle **"Sync to Lovable Cloud"** (off by default) mirrors everything to private Postgres for backup / multi-device. Schema is built day one so the toggle is a switch, not a rewrite.

## What it does (end-to-end flow)

1. **(Optional) Prep a conversation** — James (or a helper) opens "Prepare". They can:
   - paste/share a URL, drop a PDF, paste text, or dictate notes;
   - the app extracts and summarizes the source;
   - AI proposes a "Key Speaking Points" plan (3–7 bullets: things to say, things to ask, opinions to express). James edits, reorders, deletes, adds his own.
   - Plan is attached to the upcoming conversation.
2. **Start Conversation** — large button. App requests **GPS** once (with a clear permission card). It looks up the nearest known Place (radius ~75m). If found → auto-attaches that Place's context. If not → offers "Save this location as a new place?" (one tap, name it later). GPS can be turned off entirely in Settings.
3. **Live transcription** — ElevenLabs Scribe streams transcript with diarization. Helper/James can tap a speaker bubble to assign a known Person, create a new one, or mark "Stranger". Mapping persists for the session.
4. **Suggestions** — every ~3s the server function builds a context packet and asks Lovable AI for 4–8 ranked, categorized reply suggestions. James taps one (or edits / types own) → ElevenLabs TTS speaks it.
5. **End Conversation** — one tap. Behind the scenes, automatically:
   - generate AI summary,
   - extract memory candidates,
   - extract follow-ups for next time,
   - extract style signals for James's profile,
   - persist all of it.
   No mandatory review. A subtle "Saved · Review" link sits on Home for later editing/deleting.

## Context packet (sent on every suggestion call)

- **Conversation context** — last ~30s of transcript with speaker labels.
- **Speaker context** — for each identified speaker: name, relationship, interests, recurring topics, last few interaction summaries. Unknown speakers get a "you don't know this person yet" hint.
- **Location context (GPS-driven)** — current Place: name, notes, common topics, people often present, past conversation summaries at this place.
- **Prep context** — if a plan is attached: source summary + key speaking points, with which points have already been covered this conversation marked off.
- **James-style hints** — compact style profile (preferred length, tone, common phrasings, categories he picks vs ignores).
- **Session memory** — what's already been suggested/selected this session (avoid repeats).

The model returns `{suggestions: [{text, category, why, plan_point_id?}]}` via tool-calling. Categories: answer, question, follow-up-from-memory, **planned-point**, quick-phrase, humor, clarify, "give-me-a-moment".

## GPS / Place handling

- Browser Geolocation API. Permission asked on first conversation start. Clear, friendly explanation; works without it (manual Place picker fallback).
- Place matching: simple haversine distance against saved Places; nearest within 75m wins. Confidence shown subtly ("📍 Library — auto-detected").
- One-tap override: "Wrong place" → quick picker.
- New place capture: when no match, the app silently records lat/lng on the conversation; on the post-conversation home screen it offers "Was this somewhere new? Name it" — turning it into a reusable Place with a tap.
- Privacy: coordinates stored locally only; never sent to AI providers (only the resolved Place name + notes are).

## Conversation Prep feature (new)

A dedicated screen `/conversation/new/prep` reachable from Home → "Start Conversation" → "Prepare first" (or skip).

Inputs (any combination):
- **Link** — paste/share a URL. Server function fetches and extracts readable text (Mozilla Readability-style).
- **PDF** — upload from Files. Parsed server-side with `pdfjs-dist` to text.
- **Text** — paste or type.
- **Voice note** — dictate via ElevenLabs Scribe → text.

Processing:
- Each source is summarized into a compact "brief" via Lovable AI (`google/gemini-3-flash-preview`).
- All briefs are combined and James is asked: "Who are you talking to? What's the goal of this conversation?" (optional, one line each).
- AI then proposes a **Plan of Key Speaking Points** (3–7 bullets) with structured output: `{points: [{id, text, kind: "say"|"ask"|"opinion", priority}]}`.
- James edits inline: drag to reorder, swipe to delete, tap "+" to add his own, tap a point to refine wording with AI ("make shorter", "more casual").
- Plan + source briefs are saved with the conversation. During the live conversation, planned-point suggestions get a small ⭐ marker; covered ones grey out.

Uncovered points appear in the post-conversation summary as "you didn't get to mention…", and roll forward as prefilled suggestions next time the same Person/Place is selected.

## Auto-save summary (new behavior)

When James taps Stop:
- Conversation marked ended; transcript flushed.
- Background job (server function) runs three structured-output calls in parallel:
  1. **Summary** — 2–4 sentence narrative + bullet highlights.
  2. **Memory extraction** — `[{text, person_id?, place_id?, kind: "fact"|"preference"|"event"|"todo"}]`. All saved with `status: "auto"` so they can be edited/removed later but are immediately usable.
  3. **Follow-ups** — `[{text, for_person_id?, for_place_id?}]` saved as suggestions to surface next time.
- Style profile recompute is queued.
- Home screen's "Recent" row shows the new conversation with summary preview; tap to open the (now optional) review screen for edits.

No blocking modal, no Save/Ignore choices. James can always go back.

## Stage 6 foundation — James-style personalization (data only)

Every shown suggestion logs: text, category, source, shown_at, selected/edited/ignored, edited_to, time_to_tap_ms, spoken. Typed-from-scratch replies log separately. A periodic local job aggregates these into a `style_profile` JSON (avg length, tone words, frequent expressions, preferred categories, edited-out phrasings) which is fed into every suggestion prompt. No fine-tuning yet; the corpus is ready when we are.

## Stage 8 foundation — speaker identity (manual + assisted)

Diarization gives stable Speaker 1/2/… within a session. Tap a speaker bubble → assign to known Person / create new / mark Stranger. AI watches for "Hi, I'm Jane" patterns and proposes assignments. Unknown speakers bias the suggestions toward "what's your name?" prompts. Cross-session voice fingerprinting is deferred.

## Screens

- **Home** — Start Conversation (primary), Prepare a Conversation, Recent (with summary previews), People, Places, Memory, Settings.
- **Prep** — sources panel + plan editor + "Start Conversation" handoff.
- **Pre-conversation (skippable)** — confirm Person, confirm GPS-detected Place (or override), see attached plan.
- **Live Conversation** (primary): top transcript with tappable speaker bubbles; middle 4–8 large category-colored suggestion buttons with Lock + countdown ring + ⭐ on planned-point suggestions; bottom editable text field + big "Speak" + always-visible quick row (Yes / No / Give me a moment / Repeat that?).
- **Conversation detail / review** — summary, transcript, attached plan with covered/uncovered, memories (auto-saved, editable), follow-ups, "felt like James?" thumbs.
- **People / Places / Memory** browsers. Place detail shows GPS pin + history.
- **Settings** — TTS voice, suggestion refresh rate, mic test, GPS on/off, Storage (local-only / export / import / cloud-sync toggle), clear data.

## Design direction

iPad-first, calm and confident. Generous spacing, ~64px tap targets, high contrast, dyslexia-friendly sans (Atkinson Hyperlegible or Inter). Bottom-anchored controls. One strong accent per suggestion category. Motion minimal; tap targets never reflow while James is choosing.

## Technical approach

- **Frontend**: TanStack Start. Routes: `/`, `/conversation/new`, `/conversation/new/prep`, `/conversation/$id`, `/conversation/$id/review`, `/people`, `/places`, `/memory`, `/settings`.
- **Local DB**: Dexie (IndexedDB). Repository layer abstracts read/write so the cloud-sync toggle just swaps the implementation.
- **Live transcription**: `@elevenlabs/react` `useScribe`, VAD commit, diarization on. Token minted server-side via ElevenLabs connector secret.
- **Suggestion engine**: server function → Lovable AI with tool-calling for structured output. Pre-warms on conversation start. Debounced ~3s.
- **TTS**: server function streams ElevenLabs TTS, returns MP3.
- **Prep extractors**: server functions — URL fetch + Readability text extraction; PDF parse via `pdfjs-dist` (Worker-compatible build); text + voice-note pass-through. All summarized via Lovable AI.
- **Plan generator**: structured-output Lovable AI call returning `{points: [...]}`.
- **GPS**: `navigator.geolocation.getCurrentPosition`, single fix per conversation, haversine match against local Places.
- **Auto-summary**: server function with three parallel structured-output calls (summary, memories, follow-ups) triggered on Stop.
- **Memory retrieval**: keyword + recency over local data; embeddings deferred.
- **Style profile builder**: local aggregation + small Lovable AI distillation pass; cached in `style_profile` row.
- **Secrets**: ElevenLabs via connector. `LOVABLE_API_KEY` auto-managed.
- **iPad install**: web manifest + icon + `display: standalone`. No service worker.

## Local data model (Dexie; mirrored 1:1 by optional Postgres)

- `people` { id, name, relationship, interests[], notes, style_notes }
- `places` { id, name, lat, lng, radius_m, notes, common_people[] }
- `conversations` { id, started_at, ended_at, person_ids[], place_id?, gps_lat?, gps_lng?, plan_id?, summary?, speaker_map }
- `transcript_segments` { id, conversation_id, speaker_label, person_id?, text, ts }
- `suggestions_log` { id, conversation_id, text, category, source, plan_point_id?, shown_at, selected, edited_to?, ignored, spoken, time_to_tap_ms }
- `manual_replies_log` { id, conversation_id, text, ts }
- `memories` { id, person_id?, place_id?, conversation_id, text, kind, status: "auto"|"edited"|"hidden", source_segment_id }
- `prep_sources` { id, plan_id, kind: "url"|"pdf"|"text"|"voice", title, raw_text, brief }
- `plans` { id, person_ids[], place_id?, goal?, points: [{id, text, kind, priority, covered?}] }
- `quick_phrases` { id, text, order }
- `style_profile` { updated_at, json } (single row)

## Privacy posture

- Default: local-only. Cloud sync explicit opt-in.
- Always-on recording indicator. One-tap Stop. Per-conversation Delete. "Clear all data" in Settings.
- GPS coordinates stay on device; only resolved Place name/notes go to AI.
- Each AI call sends only the current context packet; no provider retention.

## Explicitly NOT in v1

- Real model fine-tuning (Stage 6 proper) — corpus only.
- Cross-session voice fingerprinting (Stage 8 proper) — manual labeling only.
- Offline / on-device LLM fallback.
- iCloud-native sync (Export/Import covers this), switch control / head tracking beyond Safari native.

## Build order

1. Enable Lovable Cloud. Design system + route scaffolding.
2. Dexie schema + repository layer + People / Places / Memory / Settings CRUD.
3. ElevenLabs connector + TTS server function + standalone "type and speak".
4. Live Scribe transcription + diarization + tap-to-assign speaker.
5. Suggestion engine + grid UI (Lock, categories, countdown, interaction logging).
6. Live persistence: transcript segments + suggestions_log + manual_replies_log.
7. **GPS detection + Place auto-match + new-place capture.**
8. **Auto-save summary + memory + follow-ups on Stop**; conversation detail/review screen for later edits.
9. **Conversation Prep**: URL/PDF/text/voice ingestion → briefs → AI plan generator → plan editor → wire planned-points into suggestions and post-summary "uncovered points".
10. Context-packet wiring (person + place + memory + plan + style_profile).
11. Style-profile builder job + Settings view.
12. Polish: quick phrases, recording indicator, Export/Import, cloud-sync toggle, manifest for Home Screen install.

## What you'll need to do

- Approve enabling Lovable Cloud (one click).
- Approve connecting ElevenLabs (one click, prompted during build).
- On the iPad: grant microphone + location permissions when first prompted.
- After v1 runs, give real-conversation feedback so we can tune latency and prompt quality.
