# Reset and rebuild speaker recognition

Yes — agreed. The current stack has too many overlapping heuristics (Scribe `speaker_id`, local MFCC clustering, name self-intros, "James addresses them" inference, trivial 1:1 fallback, plus an end-of-session placeholder-person creator). They fight each other and the names that come out are unreliable. Best move is to delete them, build back in clear, testable layers, and keep James in the loop for naming.

Below is the plan, broken into your four phases. Each phase ends in a checkpoint so we don't move on until that piece is observably correct.

---

## Phase 0 — Strip out the existing logic (no behaviour added)

Goal: get back to a clean baseline so the new pipeline isn't fighting old code.

Remove / gut:
- `src/lib/speaker-id.ts` — delete `autoMapSpeakers` entirely (keep `labelTranscriptForPrompt`, that one is a pure rename helper used by prompts).
- `src/lib/auto-person.ts` — keep `extractIntroducedNames` (still useful as a *suggestion* in Phase 3) but remove `autoCreateIntroducedPeople` and any callsite.
- `src/routes/index.tsx`:
  - Remove the auto-mapping `useEffect` that calls `autoMapSpeakers`.
  - Remove the in-segment `bestMatch` voiceprint auto-mapping branch.
  - Remove the end-of-session "create Guest person + persist voiceprint" block in `handleStop`.
  - Remove `speakerCounterRef`-based fallback labelling that runs when MFCC fails — we'll redo it cleanly.
- Leave `VoiceCapture`, `computeMfccMean`, `cosineSim`, `mergeIntoCentroid`, `recordVoiceprint`, `bestMatch` in `voiceprint.ts` — they're the primitives we'll build on. No deletions there.

Checkpoint: app runs, transcript records with raw labels (whatever Scribe gives, or a single placeholder), no auto-naming, no auto-person creation, no voiceprint writes during a session. James can record and stop without errors.

---

## Phase 1 — Reliable speaker counting (Speaker 1..N)

Goal: for any conversation, produce a stable set of distinct labels `Speaker 1`, `Speaker 2`, … that correctly reflects how many unique voices are present, including a new voice that joins mid-conversation. **No naming yet.**

Approach (single source of truth — local MFCC clustering only; ignore Scribe's `speaker_id` for now since it's been unreliable in our tests):
- For each committed utterance, slice the matching audio window from `VoiceCapture` and compute a mean MFCC vector.
- Maintain `liveClusters: Map<label, { centroid, sampleCount }>` for the session, seeded empty at session start.
- Matching rule: cosine sim against every live centroid; if best ≥ `MERGE_THRESHOLD` (start at 0.82, tune in checkpoint), merge into that cluster; else open a new cluster `Speaker {N+1}`.
- Update centroid as a sample-weighted running mean (`mergeIntoCentroid` already does this).
- Edge cases:
  - Utterance too short / too quiet → MFCC returns null → temporarily label `Speaker ?` and don't update any cluster. Don't create a new speaker from a 200ms "uh huh".
  - James's own TTS playback continues to use the synthetic `__james_self__` label and is excluded from clustering entirely.

Checkpoint: play the 3-person interview clip → expect exactly 3 `Speaker N` labels in the transcript, no false splits and no merges. Add a small dev panel (or just `console.debug`) that prints `{speaker, sampleCount, clusterCount}` per utterance so we can verify visually.

---

## Phase 2 — Match against saved voiceprints; otherwise stage a new one

Goal: at the end of each utterance (or every K utterances), check whether each live cluster's centroid matches any **saved** `voiceprints` row.

- For each live cluster, compute `bestMatch(centroid, savedPrints, VOICEPRINT_MATCH_THRESHOLD)`:
  - **Match:** record `clusterLabel → personId` in an in-memory `recognisedMap`. Do not yet rename the transcript label — the UI layer (Phase 3) shows it as `Speaker 2 → likely "Mum"` so James can confirm. On confirmation, the cluster's centroid is merged back into that person's saved voiceprint via `recordVoiceprint`.
  - **No match:** the cluster stays unnamed and becomes a *candidate* for naming in the Phase 3 UI. Its centroid is **not** persisted until James confirms a name.
- Self-intro names from `extractIntroducedNames` are surfaced as a *suggested name* for the cluster that uttered them — they no longer auto-create a Person.

Checkpoint: record a session that contains one known voice (Matt) plus two strangers → expect `Speaker N → Matt (suggested, sim 0.x)` for the known one and two un-suggested clusters for the strangers. Nothing is written to the People table or the voiceprints table without James clicking confirm.

---

## Phase 3 — UI rework: 80/20 suggestions panel with confirm-to-name

Goal: split the current suggestions area so James can see what's being heard and approve who is who, without leaving the home screen.

Layout changes in `src/routes/index.tsx`:
- The current suggestions card becomes a **flex row, 80% / 20%** on the home page.
- Left 80%: existing suggestions grid, but reduced from 4 columns to **3 columns**. Same chip styles, same tap-to-speak behaviour. (Same component, just a column count change and width.)
- Right 20%: a new `SpeakerPanel` component with two stacked sections:
  1. **Live transcript** (top, scrolling): shows the last ~10 utterances, prefixed with the current label/name for each speaker, auto-scroll to bottom.
  2. **Speakers in this conversation** (bottom): one row per live cluster:
     - Known & confirmed → "Mum" (small ✓ icon).
     - Recognised by voiceprint, awaiting confirm → "Speaker 2 — likely Mum (87%)" with **Confirm** / **Not Mum** buttons.
     - Unknown, no voiceprint match → "Speaker 3" with two actions:
       - **Name…** (inline text input, defaults to any self-intro suggestion if present, e.g. "Jack")
       - **Ask them** (speaks "Sorry, who am I speaking with?" via existing TTS pipeline)
     - "Confirm" is the **only** path that:
       - Creates a Person (if new) or updates the existing one,
       - Calls `recordVoiceprint(personId, centroid)` so it's saved,
       - Updates `conversation.speaker_map` so the transcript and prompt context start using the real name.

State: a single `clusterState: Record<label, { status: 'unknown'|'suggested'|'confirmed', candidatePersonId?, suggestedName?, sim? }>` lives in the index route and is passed to `SpeakerPanel`.

Checkpoint: full integration test — record a 4-speaker convo with Matt + 3 strangers, where one stranger says "I'm Jack". Expected result:
- 4 rows in the speaker panel.
- Matt: confirmed automatically *after* James clicks confirm (we surface the match, James approves once).
- Jack's row pre-fills name "Jack" from the self-intro; James taps Confirm → Person + voiceprint saved.
- Other 2 stay as `Speaker 3` / `Speaker 4` until James names them or asks them.
- Re-recording later → Matt and Jack are recognised automatically (suggested), still require one-tap confirm the first time per session, then stay confirmed.

---

## Phase 4 — Cleanup & guarantees

- Conversation save: `conversation.speaker_map` only contains **confirmed** entries. Unconfirmed clusters are dropped from the saved transcript's person attribution (the text remains, attributed to "Speaker N").
- People list / detail: a person card shows "Voice learned · N samples" iff a `voiceprints` row exists. After Phase 3 every confirmed cluster writes one, so the indicator becomes accurate.
- Settings: optional sliders for `MERGE_THRESHOLD` and `VOICEPRINT_MATCH_THRESHOLD` so we can tune in the field without redeploying.
- Remove dead code paths flagged during Phase 0 audit; remove `autoMapSpeakers` import everywhere; delete `autoCreateIntroducedPeople`.

---

## Files we'll touch

- `src/routes/index.tsx` — most of the work (strip old logic, add cluster state, split layout, wire confirm flow).
- `src/lib/voiceprint.ts` — small additions: a `Diarizer` helper that owns `liveClusters` and exposes `assign(mfcc): label`.
- `src/components/SpeakerPanel.tsx` — **new** component for the right 20%.
- `src/lib/speaker-id.ts` — shrink to just `labelTranscriptForPrompt`.
- `src/lib/auto-person.ts` — keep `extractIntroducedNames`, remove auto-create.
- `src/lib/db.ts` — no schema change required (we're already using `voiceprints` and `speaker_map`); maybe add `MERGE_THRESHOLD` constant alongside `VOICEPRINT_MATCH_THRESHOLD`.
- `src/routes/people.*` (people tab) — verify the "Voice learned" indicator now reflects reality after Phase 3.

## Why this should work where the previous attempts didn't

- **One source of truth for "who's talking"** (local MFCC clustering). No more Scribe-vs-MFCC tie-break logic, no more end-of-session guesswork.
- **No silent writes.** Persons and voiceprints are only created when James confirms. That ends the "system invented Matt as the third speaker" class of bug.
- **Recognition becomes a suggestion, not a decision.** Voiceprint matches surface as proposals; confirmation is one tap. So when matches are wrong, the cost is one button press, not a poisoned People table.
- **Mid-conversation joiners** fall out for free from clustering — a new voice produces a new centroid → new Speaker N row → James names it.

If this looks right I'll start with Phase 0 (the strip-out) so you can verify the baseline before we add anything back.
