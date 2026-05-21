## Goals

1. Make the "Speakers" panel editable, not just confirm/reject — James can override a wrong suggestion (e.g. system says "Speaker 1 = James" but it's actually Matt) before any voiceprint is saved.
2. Surface name hints from the transcript itself ("hi I'm Matt", "this is Sarah") as inline suggestions next to each unknown cluster, with one-tap accept.
3. Tighten the "Ask" flow so the answer to *"who am I speaking with?"* is captured against the cluster that just spoke and offered back to James as a one-tap suggestion.
4. Add a **"Record voice sample"** action on each person's profile in Settings → People, so James can capture a clean voiceprint for a known person without needing them in a live conversation.

Nothing about diarization clustering, thresholds, or the Scribe pipeline changes — only the SpeakerPanel UI, the per-cluster state it tracks, and a new mini-recorder on the person profile.

## Changes

### 1. SpeakerPanel: edit + multiple name suggestions

`src/components/SpeakerPanel.tsx`

Extend `ClusterStatus` so an "unknown" cluster can carry **multiple** suggested names (from self-intros + Q&A replies), not just one:

```text
ClusterStatus =
  | { kind: "unknown"; suggestions?: { name: string; source: "self-intro" | "ask-reply" | "manual" }[] }
  | { kind: "suggested"; personId: string; sim: number; alternateName?: string }
  | { kind: "confirmed"; personId: string }
```

Each cluster row now renders:

- **Header**: `Speaker N` + sample count + a small ✏️ Edit button (always visible, even when confirmed).
- **Name suggestion chips** (unknown only): one chip per suggested name, e.g. `[Matt ✓] [Sarah ✓]`. Tap = create+confirm that person against this cluster. Chips show their source as a tooltip ("heard self-intro", "answered 'who am I speaking with?'").
- **Suggested-match row** (suggested only): `Sounds like Mum (87%)` with **Confirm** / **Not them** / **It's someone else…** — the third option drops the cluster back to `unknown` and opens the name input pre-focused.
- **Free-text Name… input**: always available below the chips (fallback path, unchanged behaviour).
- **Confirmed row**: name + ✏️. Edit opens a small popover with two actions:
  - *Reassign to another person* (dropdown of existing people + "New person…")
  - *This isn't them — clear* (drops back to `unknown`, removes the entry from `speaker_map`, keeps the cluster's centroid; **does not delete the saved voiceprint of the previously-confirmed person**).

### 2. Wire suggestions and edits in `src/routes/index.tsx`

- In the `onCommittedTranscriptWithTimestamps` handler, when scanning a segment for `extractIntroducedNames`, **append** the name to the cluster's `suggestions` list (de-duped) instead of overwriting `suggestedName`. Apply this even if the cluster is currently in `suggested` state (store as `alternateName` on the suggested status) so James can override a wrong voiceprint match with a freshly-heard self-intro.
- Add a new handler `editConfirmedSpeaker(label, action)`:
  - `"clear"` → remove `label` from `speakerMap`, set status back to `unknown`, no DB writes.
  - `{ kind: "reassign", personId }` → update `speakerMap[label] = personId`, set status to `confirmed`, persist updated centroid via `recordVoiceprint(personId, cluster.centroid)`.
- Add `addSuggestionFromText(label, name)` so the "Ask" answer can be turned into a chip. We track which cluster spoke last *after* the Ask press in a small ref (`expectingNameForClusterRef`); the next committed segment from any unknown cluster runs `extractIntroducedNames` on its text and pushes any hit onto that cluster's suggestions with `source: "ask-reply"`.
- The existing `onAskName` → `speak("Sorry, who am I speaking with?")` becomes:

```text
onAskName(): set expectingNameForClusterRef = currentFocusedClusterLabel ?? null; speak(...)
```

  Cluster panel passes the label of the cluster whose Ask button was tapped, so the next reply maps to the right row.

### 3. Settings → People: record a voiceprint for an existing person

`src/routes/settings.tsx` (`PersonDetail` component, near the Edit/Delete buttons)

Add a new **"Voice"** section:

- Status line: `Voice learned · N samples` if a `voiceprints` row exists for `person.id`, else `No voiceprint yet`.
- Buttons:
  - **Record voice sample** → opens an inline mini-recorder (no Scribe, just `VoiceCapture` + `computeMfccMean`). Flow: tap Record → 5-second countdown UI → "Speak normally for ~5 seconds" → tap Stop (or auto-stop at 8s) → compute MFCC → call `recordVoiceprint(person.id, mfcc)` → toast "Voice sample saved". Re-recording adds to the running centroid via the existing merge logic in `recordVoiceprint`.
  - **Replace voice sample** (only when one exists) → `deleteVoiceprint(person.id)` then immediately enter the recording flow, so the new capture starts a fresh centroid with `sample_count = 1`.
  - **Delete voiceprint** (only when one exists) → confirm → `deleteVoiceprint(person.id)`.

The mini-recorder lives in a new component `src/components/VoiceSampleRecorder.tsx` (small, self-contained, uses the existing `VoiceCapture` + `computeMfccMean` primitives — no new audio code).

### 4. Small consistency fixes

- `extractIntroducedNames` is already called per-segment; no change to that lib.
- `auto-person.ts` STOP_NAMES already excludes "James" so James saying "I'm James" never lands in someone else's suggestion list. Verified, no change.
- "Me" rows in the live transcript are unchanged.

## Out of scope

- No change to the Diarizer, MFCC thresholds, Scribe handling, or auto-creation rules.
- No change to suggestion generation prompts.
- No DB migration: `voiceprints` table already supports this exact shape.

## Acceptance checks

1. Multi-speaker recording: one cluster mis-labelled "James" can be overridden via ✏️ → Reassign or by tapping a "Matt" suggestion chip.
2. After "Ask", the next unknown speaker's reply containing a name shows that name as a one-tap chip on their cluster row.
3. From Settings → People → open Mum → Record voice sample → speak for 5s → "Voice learned · 1 sample" appears; in next live conversation, Mum is offered as a `suggested` match when she speaks.
4. Editing a confirmed speaker back to `unknown` does not delete the previously-saved voiceprint of that person.
