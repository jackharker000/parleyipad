## Short answer

Yes — splitting models by job is a real win here. Right now one Settings choice (`suggestion_model`) drives both the latency-critical path (live suggestions, expand-to-sentence) **and** the quality-critical path (post-conversation summary, memory extraction, event prep, reply drafts). Those two jobs have opposite needs.

## What's happening today

Live, latency-critical (called many times per minute):
- `generateSuggestions` — refreshed as James and others speak
- `expandUtterance` — every time James taps a chip

Background / one-shot, quality-critical (called once per conversation or on demand):
- `summarizeConversation` — narrative + highlights + memory candidates + follow-ups
- `extractInterests` — durable profile/memory updates
- `generateEventPrep` — pre-conversation briefing
- `draftReply`, `draftFacebookPost` — longer-form writing

All of these read `aiModelRef.current`, which is just `settings.suggestion_model`. Default is `gemini-2.5-flash-lite` for everything. `summarizeConversation` is the only one with a hardcoded fallback to `gemini-2.5-flash` if no model is passed — but the client always passes the lite one, so the fallback never fires.

Net effect: either James gets slow suggestions (if you pick a smart model) or shallow memory/summaries (if you pick a fast one). You can't have both.

## Proposed split

Two named tiers, stored as separate settings, each with a sensible default:

| Tier | Used by | Default | Why |
|---|---|---|---|
| **Fast** (`fast_model`) | `generateSuggestions`, `expandUtterance` | `google/gemini-3-flash-preview` (or keep `2.5-flash-lite`) | Sub-second response, runs constantly, short outputs |
| **Smart** (`smart_model`) | `summarizeConversation`, `extractInterests`, `generateEventPrep`, `draftReply`, `draftFacebookPost` | `google/gemini-2.5-pro` (or `gpt-5-mini`) | Runs once, longer context, nuance matters for memory + writing quality |

### Settings UI

Replace the single "AI model" dropdown with two:
- **Live suggestions model** (Fast tier) — with a one-line "what this affects" caption
- **Memory & analysis model** (Smart tier) — same caption pattern

Keep the existing model catalogue; just bind each dropdown to its own setting. Migrate existing users by seeding `fast_model = suggestion_model` and `smart_model = "google/gemini-2.5-pro"` on first load.

### Wiring

- `src/lib/db.ts` — add `fast_model` + `smart_model` to default settings (and the type), keep `suggestion_model`/`expand_model` for one release as fallbacks during migration.
- `src/routes/index.tsx` — replace `aiModelRef` with `fastModelRef` + `smartModelRef`; suggestion + expand calls send `fast`, summarize/interests/event-prep/reply calls send `smart`.
- `src/lib/aac.functions.ts` — no logic change needed; functions already accept a `model` param. Only update the hardcoded fallback in `summarizeConversation` to be irrelevant once the client always passes one.
- `src/routes/settings.tsx` — split the dropdown into two controls.

## Other improvements unlocked by the split

1. **Reasoning effort on the smart tier only.** For `summarizeConversation` and `extractInterests`, pass `reasoning: { effort: "low" }` (or `"medium"`) when the smart model supports it. Gives sharper memories without slowing James's live experience.
2. **Larger transcript window for analysis.** Today the live path uses the last 8 utterances (kept short for speed). The smart-tier summary can safely take the full transcript — it already does, but we can also feed more prior-conversation context for `generateEventPrep`.
3. **Parallelize post-conversation work.** `summarizeConversation` and `extractInterests` can run in parallel (`Promise.all`) on conversation end, instead of sequentially. With two different model tiers this matters less for latency but reduces total wall-clock time for "Save & finish."
4. **Skip smart calls when nothing changed.** Add a guard: if the transcript is < ~3 utterances or unchanged since last summary, skip the smart-model call entirely. Cuts cost without affecting quality.

## Recommendation

Worth doing. The split is a ~1-file-per-area change, and it directly addresses the trade-off you're describing: keep James's tapping experience snappy on a Flash-tier model, while letting the post-conversation memory/profile work use a Pro-tier model where the extra second or two is invisible to him.

Want me to implement this as described, or adjust the defaults / UI first?