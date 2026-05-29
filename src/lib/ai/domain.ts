import type { LLMProvider } from "@/lib/providers";
import type { JamesProfile, Memory, StyleProfile, SuggestionCategory } from "@/lib/db";
import type { PerPersonCategoryHints } from "@/lib/learning/style-evidence";

/**
 * Domain-level AI client. Sits above the raw LLMProvider chat layer and
 * exposes app-shaped methods (`generateSuggestions`, `expandUtterance`,
 * `summarizeConversation`, …) the way the approach doc specifies.
 *
 * Each method:
 *   - builds the right prompt (with `cacheSystem` on the persona block),
 *   - picks the right model tier (fast for live, smart for batch),
 *   - parses the response into structured output (JSON shape we trust).
 *
 * The provider implementations live in `src/lib/providers/`; this layer
 * is shared between Anthropic and OpenAI clients because the prompts and
 * output schemas are provider-neutral.
 */

export type Mood = "normal" | "calm" | "excited" | "sad" | "upset" | "empathetic" | "amused";

export const MOODS: readonly Mood[] = [
  "normal",
  "calm",
  "excited",
  "sad",
  "upset",
  "empathetic",
  "amused",
] as const;

export type SuggestionDraft = {
  text: string;
  category: SuggestionCategory;
  why?: string;
};

export type SuggestionContext = {
  /** Display name for James. */
  jamesName: string;
  /** Recent transcript lines, oldest first. */
  transcript: Array<{ speaker: string; text: string }>;
  /** Active mood preset. */
  mood: Mood;
  /** Optional people present (just names; richer profiles in step 4). */
  peopleNames?: string[];
  /** Optional active place name. */
  placeName?: string;
  /** Optional active event name + agenda. */
  event?: { name: string; keyInfo?: string };
  /** Full James persona for the system block. Cache-friendly — stable
   * across a session, so it sits inside the cached system prompt. */
  jamesProfile?: JamesProfile;
  /**
   * Tier-1 distilled style profile (openers, sign-offs, taboo, formality,
   * category preferences). Sits in the cached system block — it only
   * rebuilds every ~12h via the post-summarise hook, so the LLM cache key
   * stays stable across the whole conversation.
   */
  styleProfile?: StyleProfile;
  /**
   * Lowercased phrases the model should NOT propose — accumulated from
   * suggestions shown ≥ N times and never tapped across recent sessions.
   * Goes in the cached system block (cross-session stable). The post-
   * generation filter at the call site is the safety net; this is the
   * preventive hint.
   */
  deadPhrases?: string[];
  /**
   * Per-person category-selection rates keyed by person NAME (the model
   * sees names, not IDs). Turn-volatile: the active roster can change
   * mid-conversation, so this rides the user message rather than the
   * cached system block.
   */
  categoryHints?: Map<string, PerPersonCategoryHints>;
  /**
   * Top-K relevant memories for the people in the room + place. Turn-
   * volatile (the query rotates with the recent transcript), so this
   * rides the user message too.
   */
  memories?: Memory[];
};

export type ExpandContext = {
  jamesName: string;
  rawText: string;
  recentTranscript?: Array<{ speaker: string; text: string }>;
};

export type SummarizeConversationContext = {
  /** Already-formatted "Speaker: text" transcript, oldest first. */
  transcript: string;
  /** Optional people present for grounding the summary. */
  peopleNames?: string[];
};

export type SummarizeConversationResult = {
  summary: string;
  highlights: string[];
};

export type DraftPlatform = "facebook" | "email" | "imessage";

export type DraftReplyContext = {
  platform: DraftPlatform;
  /** What James received (the email he's replying to, the comment, the text). */
  incoming?: string;
  /** What James roughly typed as a reply / what he wants to say. */
  rawText: string;
  /** Free-text context (who it's from, the relationship, etc.) */
  context?: string;
  /** Optional James profile so the model can write in his voice. */
  jamesProfile?: JamesProfile;
  /**
   * Optional distilled style profile — feeds the same fingerprint the live
   * cockpit uses into Helpers, so drafts sound consistent with how James
   * talks in conversation. Cached in the system prompt because it's only
   * refreshed every ~12h.
   */
  styleProfile?: StyleProfile;
  /**
   * Tone-redo nudge. When set, appends a single instruction line to the user
   * prompt asking the model to re-cast the SAME intent in a different tone
   * ("shorter", "warmer", "drier", "more formal", "more casual"). Used by the
   * Helpers-tab chip row after the first draft lands.
   */
  toneOverride?: string;
};

export type DraftReplyVariation = { text: string; tone: string };

export type DraftReplyResult = {
  recommended: string;
  alternatives: DraftReplyVariation[];
  error?: string;
};

export type InterestSuggestion = {
  kind: "topic_loved" | "current_context" | "signature_phrase";
  text: string;
  why?: string;
};

export type ExtractInterestsContext = {
  /** The text the assistant just helped James write. */
  draft: string;
  /** Optionally the message he was replying to. */
  incoming?: string;
  currentTopicsLoved?: string;
  currentLifeContext?: string;
  currentSignaturePhrases?: string;
  jamesName?: string;
};

export type ExtractLexiconContext = {
  /** Focused transcript: this person's turns + light context. */
  transcript: string;
  /** Name of the person whose vocabulary we're extracting. */
  personName: string;
  /** Existing lexicon terms for this person. The model skips repeats. */
  existingTerms?: string[];
};

export type ExtractLexiconEntry = {
  term: string;
  /** Suggested keyterm boost, 1.0-2.0. Higher for distinctive proper nouns,
   * lower for general jargon. The persister clamps to 0.5–2.0. */
  weight: number;
  reasoning?: string;
};

export type ExtractLexiconResult = {
  terms: ExtractLexiconEntry[];
};

export type EventPrepContext = {
  eventName: string;
  /** Freeform date/time string. */
  eventWhen: string;
  placeName?: string;
  attendeeNames: string[];
  keyInfo?: string;
  /** James's optional steering ("focus on cricket plans", "ask about her trip"). */
  userPrompt?: string;
  jamesProfile?: JamesProfile;
};

export type EventPrepResult = {
  /** 4–6 talking points James could raise. */
  keyPoints: string[];
  /** 3–5 questions he could ask. */
  keyQuestions: string[];
};

// --------------------------------------------------------------------------
// Post-conversation learning loop types
// --------------------------------------------------------------------------

/**
 * Style-distillation sample bundle. Each list is a different evidence
 * channel — tapped suggestions, ignored suggestions, edited suggestions
 * (text the model proposed vs the text James actually said), and Helpers-tab
 * draft edits. The smart-tier model rolls these up into a `StyleProfile`.
 */
export type DistillStyleSamples = {
  tappedExamples: Array<{ personName?: string; text: string; category: string }>;
  ignoredExamples: Array<{ text: string; category: string }>;
  editedExamples: Array<{ from: string; to: string }>;
  helperEdits: Array<{ platform: string; recommended: string; jamesEdit: string }>;
};

export type DistillStyleContext = {
  samples: DistillStyleSamples;
  jamesProfile?: JamesProfile;
  previous?: StyleProfile;
};

export type DistilledStyleProfile = Pick<
  StyleProfile,
  | "preferredOpeners"
  | "preferredSignOffs"
  | "formality"
  | "humorMarkers"
  | "tabooPhrases"
  | "averageSentenceLength"
  | "readingGradeEstimate"
  | "categoryPreferenceScores"
> & {
  /** Optional one-sentence summary of what changed; surfaced in the System tab. */
  summary?: string;
};

export type ExtractMemoriesContext = {
  transcript: string;
  conversationId: string;
  peopleNames: string[];
  jamesProfile?: JamesProfile;
};

export type ExtractedMemoryKind = "fact" | "preference" | "joke" | "event";

export type ExtractedMemory = {
  /** Resolved id from the peopleNames roster. Undefined when the memory is
   * general / not person-specific or the model picked a name we can't resolve. */
  personId?: string;
  kind: ExtractedMemoryKind;
  text: string;
};

export type ExtractMemoriesResult = {
  memories: ExtractedMemory[];
};

export type EnrichPersonProfileContext = {
  personName: string;
  transcript: string;
  currentProfile?: {
    relationship?: string;
    topicsLoved?: string[];
    notes?: string;
  };
  jamesProfile?: JamesProfile;
};

export type ProfileProposalDraft = {
  field: string;
  op: "set" | "append" | "remove";
  value: string;
  reasoning?: string;
};

export type EnrichPersonProfileResult = {
  proposals: ProfileProposalDraft[];
};

export type DetectIntroductionsContext = {
  /** Transcript text the model can scan for confirmations. */
  transcript: string;
  /** Names the regex pre-filter picked up. */
  candidates: string[];
};

export type ConfirmedIntroduction = {
  name: string;
  confidence: number;
};

export type DetectIntroductionsResult = {
  confirmed: ConfirmedIntroduction[];
};

export type IdentifySpeakerContext = {
  /** Window of recent turns the speaker just spoke into. */
  transcript: Array<{ speaker: string; text: string }>;
  /** Candidate names the matcher couldn't decisively pick between. */
  candidates: string[];
  /** Optional contextual hints — place name, event name, expected attendees. */
  place?: string;
  event?: string;
  jamesProfile?: JamesProfile;
};

export type IdentifySpeakerResult = {
  name: string | "unknown";
  confidence: number;
  reasoning?: string;
};

export type RediarizeTieBreakerCandidate = {
  /** Candidate transcript segments + their top-2 posterior gap. */
  segmentId: string;
  text: string;
  /** Top-2 candidate names + posteriors from the cosine pass. */
  top1: { name: string; posterior: number };
  top2: { name: string; posterior: number };
};

export type RediarizeTieBreakerContext = {
  candidates: RediarizeTieBreakerCandidate[];
  /** Names of all people in the conversation, for grounding. */
  rosterNames: string[];
  /** Full transcript context (single string, ~6k chars cap). */
  transcript: string;
};

export type RediarizeTieBreakerDecision = {
  segmentId: string;
  /** Resolved name from `rosterNames`, or "unknown" if neither candidate fits. */
  name: string | "unknown";
  confidence: number;
};

export type RediarizeTieBreakerResult = {
  decisions: RediarizeTieBreakerDecision[];
};

export class DomainAI {
  constructor(private llm: LLMProvider) {}

  /**
   * Live cockpit's bread-and-butter call. Returns 6 ready-to-tap replies.
   * Fast model, prompt-caching on the persona block.
   *
   * When `onUpdate` is supplied, the call streams: as each `{ text, category,
   * why }` object closes inside the model's output, `onUpdate(drafts, true)`
   * fires with the running list so the cockpit can paint progressively. The
   * promise still resolves to the final `SuggestionDraft[]` for callers that
   * want to await the complete result (and for the suggestions log write
   * downstream). A final `onUpdate(drafts, false)` is NOT emitted here — the
   * cockpit gets that from the resolved promise.
   *
   * When `onUpdate` is absent, falls back to the non-stream path.
   */
  async generateSuggestions(
    ctx: SuggestionContext,
    onUpdate?: (drafts: SuggestionDraft[], generating: boolean) => void,
    options?: { signal?: AbortSignal },
  ): Promise<SuggestionDraft[]> {
    const request = {
      tier: "fast" as const,
      maxTokens: 800,
      // 0.7, not 0.8: the structured 6-slot shape + category spread already
      // force variety, so the extra degree of randomness mostly bought
      // off-voice phrasing and near-duplicate cards. Lower keeps replies
      // sounding like James while staying diverse.
      temperature: 0.7,
      cacheSystem: true,
      messages: [
        { role: "system" as const, content: suggestionsSystemPrompt(ctx) },
        { role: "user" as const, content: suggestionsUserPrompt(ctx) },
      ],
      signal: options?.signal,
    };

    if (!onUpdate) {
      const response = await this.llm.complete(request);
      return parseSuggestions(response.text);
    }

    let accumulated = "";
    const scanner = new StreamingSuggestionScanner();
    let emitted = 0;
    for await (const chunk of this.llm.stream(request)) {
      accumulated += chunk;
      const drafts = scanner.consume(chunk);
      if (drafts.length > emitted) {
        emitted = drafts.length;
        onUpdate(drafts.slice(), true);
      }
    }

    // Final pass: parse the complete accumulated text so we capture any
    // suggestion the streaming scanner couldn't close (e.g. trailing prose
    // around the JSON, or the model truncating). If the final reparse
    // succeeds and finds at least as many drafts as we streamed, prefer it
    // — it's the canonical parse. Otherwise fall back to whatever the
    // scanner managed to extract so we never throw away a successful stream.
    try {
      const finalDrafts = parseSuggestions(accumulated);
      if (finalDrafts.length >= scanner.drafts.length) return finalDrafts;
    } catch {
      /* fall through to scanner output */
    }
    if (scanner.drafts.length === 0) {
      // Re-raise so the caller's error path runs — we genuinely got nothing.
      return parseSuggestions(accumulated);
    }
    return scanner.drafts;
  }

  /**
   * Take James's rough typed text and rewrite it into a polished sentence
   * in his voice. Single string out.
   */
  async expandUtterance(ctx: ExpandContext): Promise<string> {
    const response = await this.llm.complete({
      tier: "fast",
      maxTokens: 200,
      temperature: 0.5,
      cacheSystem: true,
      messages: [
        { role: "system", content: expandSystemPrompt(ctx) },
        {
          role: "user",
          content:
            (ctx.recentTranscript && ctx.recentTranscript.length > 0
              ? `Recent transcript:\n${formatTranscript(ctx.recentTranscript)}\n\n`
              : "") + `Rough text: ${ctx.rawText}\n\nPolished:`,
        },
      ],
    });
    return response.text.trim().replace(/^"|"$/g, "");
  }

  /**
   * Post-conversation summary. Smart tier, batch — runs in the background
   * after Stop via the pendingJobs drainer. Returns a one-paragraph
   * summary plus 3–6 bullet highlights for the Recent view.
   */
  async summarizeConversation(
    ctx: SummarizeConversationContext,
  ): Promise<SummarizeConversationResult> {
    const response = await this.llm.complete({
      tier: "smart",
      maxTokens: 700,
      temperature: 0.4,
      cacheSystem: false,
      messages: [
        { role: "system", content: summarizeSystemPrompt() },
        { role: "user", content: summarizeUserPrompt(ctx) },
      ],
    });
    return parseSummary(response.text);
  }

  /**
   * Post-conversation lexicon extraction. Picks 5–15 proper nouns, distinctive
   * jargon, pet/place/project names, or unusual words this person is likely
   * to use again. The list feeds `personLexicon` → `buildKeyterms` → Scribe's
   * `keyterms` biasing on the next session. Smart tier (quality matters more
   * than latency — this runs in the background after Stop).
   */
  async extractLexicon(ctx: ExtractLexiconContext): Promise<ExtractLexiconResult> {
    const response = await this.llm.complete({
      tier: "smart",
      maxTokens: 300,
      temperature: 0.3,
      cacheSystem: false,
      messages: [
        { role: "system", content: extractLexiconSystemPrompt() },
        { role: "user", content: extractLexiconUserPrompt(ctx) },
      ],
    });
    return parseExtractLexicon(response.text);
  }

  /**
   * Generate talking points + questions for an upcoming event. Smart tier,
   * fired from the Events page's "Prep with AI" button. Uses the James
   * persona block so the suggestions are bent toward what he actually cares
   * about (cricket, family, etc.) rather than generic small talk.
   */
  async generateEventPrep(ctx: EventPrepContext): Promise<EventPrepResult> {
    const response = await this.llm.complete({
      tier: "smart",
      maxTokens: 800,
      temperature: 0.5,
      cacheSystem: false,
      messages: [
        { role: "system", content: eventPrepSystemPrompt(ctx) },
        { role: "user", content: eventPrepUserPrompt(ctx) },
      ],
    });
    return parseEventPrep(response.text);
  }

  /**
   * Helpers-tab draft generator. Quality-critical, not latency-critical —
   * uses the smart tier so the model has room to write in James's voice.
   * Returns a recommended draft plus alternative tones.
   */
  async draftReply(ctx: DraftReplyContext): Promise<DraftReplyResult> {
    const response = await this.llm.complete({
      tier: "smart",
      maxTokens: 1200,
      temperature: 0.7,
      cacheSystem: true,
      messages: [
        { role: "system", content: draftReplySystemPrompt(ctx) },
        { role: "user", content: draftReplyUserPrompt(ctx) },
      ],
    });
    return parseDraftReply(response.text, ctx.rawText);
  }

  /**
   * After a draft is written, propose 0–3 SHORT additions James could pin
   * to his profile so future replies sound more like him. Smart tier; runs
   * fire-and-forget alongside the draft, never blocks the UI.
   */
  async extractInterests(ctx: ExtractInterestsContext): Promise<{
    suggestions: InterestSuggestion[];
    error?: string;
  }> {
    const response = await this.llm.complete({
      tier: "smart",
      maxTokens: 400,
      temperature: 0.4,
      cacheSystem: true,
      messages: [
        { role: "system", content: extractInterestsSystemPrompt(ctx) },
        { role: "user", content: extractInterestsUserPrompt(ctx) },
      ],
    });
    return parseInterestSuggestions(response.text);
  }

  /**
   * Tier-1 style distillation. Smart tier; runs at most once per 12h from
   * the post-conversation drainer. Folds recent suggestion + helper-draft
   * evidence into a typed `StyleProfile` that lives in the cached system
   * block of every future suggestion call.
   */
  async distillStyleProfile(ctx: DistillStyleContext): Promise<DistilledStyleProfile> {
    const response = await this.llm.complete({
      tier: "smart",
      maxTokens: 1500,
      temperature: 0.3,
      cacheSystem: false,
      messages: [
        { role: "system", content: distillStyleSystemPrompt() },
        { role: "user", content: distillStyleUserPrompt(ctx) },
      ],
    });
    return parseStyleProfile(response.text);
  }

  /**
   * Tier-3 memory extraction. Smart tier; runs post-conversation. Returns
   * a short list of person-specific or place-specific memories worth
   * embedding for top-K retrieval at suggestion time.
   */
  async extractMemories(ctx: ExtractMemoriesContext): Promise<ExtractMemoriesResult> {
    const response = await this.llm.complete({
      tier: "smart",
      maxTokens: 800,
      temperature: 0.3,
      cacheSystem: false,
      messages: [
        { role: "system", content: extractMemoriesSystemPrompt() },
        { role: "user", content: extractMemoriesUserPrompt(ctx) },
      ],
    });
    return parseExtractedMemories(response.text, ctx.peopleNames);
  }

  /**
   * Tier-2 per-person profile enrichment. Smart tier; one call per
   * confirmed participant after the drainer's rediarize pass. Returns
   * conservative proposals against `relationship` / `topicsLoved` / `notes`.
   */
  async enrichPersonProfile(ctx: EnrichPersonProfileContext): Promise<EnrichPersonProfileResult> {
    const response = await this.llm.complete({
      tier: "smart",
      maxTokens: 600,
      temperature: 0.3,
      cacheSystem: false,
      messages: [
        { role: "system", content: enrichPersonProfileSystemPrompt() },
        { role: "user", content: enrichPersonProfileUserPrompt(ctx) },
      ],
    });
    return parseEnrichPersonProfile(response.text);
  }

  /**
   * Tier-2 introduction confirmation. Fast tier; takes a regex-shortlisted
   * candidate list and a transcript and returns only those candidates that
   * are *actual* self-introductions (vs accidental name matches like "meet
   * me at the cafe"). The pre-filter caps the prompt size.
   */
  async detectIntroductions(ctx: DetectIntroductionsContext): Promise<DetectIntroductionsResult> {
    const response = await this.llm.complete({
      tier: "fast",
      maxTokens: 400,
      temperature: 0.2,
      cacheSystem: false,
      messages: [
        { role: "system", content: detectIntroductionsSystemPrompt() },
        { role: "user", content: detectIntroductionsUserPrompt(ctx) },
      ],
    });
    return parseDetectIntroductions(response.text);
  }

  /**
   * Live tie-breaker for the matcher. Used when the voice + context prior
   * leave two candidates within an ambiguity gap (e.g. siblings, parent +
   * adult child). The model sees the recent transcript window and picks
   * the most likely speaker from a closed-set, or "unknown" if neither
   * fits. Fast tier — this sits on the live path.
   */
  async identifySpeakerFromContext(ctx: IdentifySpeakerContext): Promise<IdentifySpeakerResult> {
    const response = await this.llm.complete({
      tier: "fast",
      maxTokens: 200,
      temperature: 0.1,
      cacheSystem: false,
      messages: [
        { role: "system", content: identifySpeakerSystemPrompt(ctx) },
        { role: "user", content: identifySpeakerUserPrompt(ctx) },
      ],
    });
    return parseIdentifySpeaker(response.text, ctx.candidates);
  }

  /**
   * Post-conversation tie-breaker for rediarize. Resolves segments whose
   * top-2 candidate posteriors were within the ambiguity gap. Batch-sized
   * so we do at most one LLM call per conversation, not one per ambiguous
   * segment. Smart tier — quality dominates here, latency doesn't matter.
   */
  async aiRediarizeTieBreaker(ctx: RediarizeTieBreakerContext): Promise<RediarizeTieBreakerResult> {
    if (ctx.candidates.length === 0) return { decisions: [] };
    const response = await this.llm.complete({
      tier: "smart",
      maxTokens: 800,
      temperature: 0.2,
      cacheSystem: false,
      messages: [
        { role: "system", content: rediarizeTieBreakerSystemPrompt() },
        { role: "user", content: rediarizeTieBreakerUserPrompt(ctx) },
      ],
    });
    return parseRediarizeTieBreaker(response.text);
  }
}

// --------------------------------------------------------------------------

function suggestionsSystemPrompt(ctx: SuggestionContext): string {
  const name = ctx.jamesName || "James";
  const personaBlock = ctx.jamesProfile ? `\n${jamesProfileBlock(ctx.jamesProfile)}` : "";
  const styleBlock = ctx.styleProfile ? `\n${styleProfileBlock(ctx.styleProfile, name)}` : "";
  const deadBlock =
    ctx.deadPhrases && ctx.deadPhrases.length > 0
      ? `\nDo NOT propose these phrases — ${name} has consistently ignored them:\n${ctx.deadPhrases
          .slice(0, 25)
          .map((p) => `- ${p}`)
          .join("\n")}\n`
      : "";
  return `You are Parley, an AAC reply assistant for ${name}.

${name} is a non-verbal man with cerebral palsy. He communicates by tapping suggested replies on an iPad, which are then spoken aloud in his cloned voice. Your job is to give him 6 ready-to-tap replies whenever someone speaks to him.
${personaBlock}${styleBlock}${deadBlock}
Grounding (critical — these are spoken aloud in ${name}'s own cloned voice):
- Only propose replies grounded in the transcript, ${name}'s profile, or the listed memories.
- NEVER invent facts, plans, commitments, names, opinions, or events ${name} hasn't expressed. Do not put words in his mouth.
- "planned" items must come from the event notes or memories, never from invention. If there's nothing real to surface, use a different category instead.

Voice and style:
- Sound like ${name}, not like an assistant. First-person ("I", "we", never "${name} says...").
- Conversational English. Contractions are fine. Avoid emojis.
- 3–15 words per reply is the sweet spot.

Variety (all 6 must be genuinely distinct — different stance, topic, or move; never two rewordings of the same reply):
- Aim for roughly 2 answers, 1–2 questions, 1 followup, and 1 flexible slot (planned/humor/clarify as the moment fits).
- ALWAYS include exactly one "give-me-a-moment" or "clarify" so ${name} can hold the floor or stall on any turn.

Output strictly as JSON, no commentary:

{
  "suggestions": [
    { "text": "string", "category": "answer|question|followup|planned|humor|clarify|give-me-a-moment", "why": "string (optional, short)" }
  ]
}

Categories:
- "answer" — direct response to what the other person said
- "question" — turn the conversation back to them
- "followup" — pursue a thread or detail
- "planned" — surface an agenda point ${name} wanted to make (from event notes / memories only)
- "humor" — light, ${name}-flavoured aside
- "clarify" — ask them to repeat, or to confirm what they meant
- "give-me-a-moment" — buy time / hold the floor

Always return exactly 6 suggestions.`;
}

function suggestionsUserPrompt(ctx: SuggestionContext): string {
  const lines: string[] = [];
  if (ctx.placeName) lines.push(`Place: ${ctx.placeName}`);
  if (ctx.event) {
    lines.push(`Event: ${ctx.event.name}`);
    if (ctx.event.keyInfo) lines.push(`Event notes: ${ctx.event.keyInfo}`);
  }
  if (ctx.peopleNames && ctx.peopleNames.length > 0) {
    lines.push(`People in the room: ${ctx.peopleNames.join(", ")}`);
  }
  lines.push(`Mood preset: ${ctx.mood}`);

  if (ctx.categoryHints && ctx.categoryHints.size > 0) {
    lines.push("");
    lines.push(
      `Per-person preferences (tap rate by category, ${ctx.jamesName || "James"}'s history):`,
    );
    for (const [personName, hints] of ctx.categoryHints.entries()) {
      const top = Object.entries(hints)
        .filter(([, v]) => typeof v === "number" && v > 0)
        .sort(([, a], [, b]) => (b as number) - (a as number))
        .slice(0, 3)
        .map(([cat, rate]) => `${cat} ${((rate as number) * 100) | 0}%`)
        .join(", ");
      if (top) lines.push(`- ${personName}: ${top}`);
    }
  }

  if (ctx.memories && ctx.memories.length > 0) {
    lines.push("");
    lines.push("Relevant memories:");
    for (const m of ctx.memories.slice(0, 8)) {
      lines.push(`- (${m.kind}) ${m.text}`);
    }
  }

  lines.push("");
  lines.push("Recent transcript:");
  lines.push(formatTranscript(ctx.transcript));
  lines.push("");
  lines.push("Generate 6 reply suggestions James could tap right now. JSON only.");
  return lines.join("\n");
}

function styleProfileBlock(sp: StyleProfile, name: string): string {
  const lines: string[] = [`${name}'s style fingerprint (distilled from past taps):`];
  if (sp.formality) lines.push(`- Formality: ${sp.formality}`);
  if (sp.preferredOpeners.length > 0) {
    lines.push(`- Common openers: ${sp.preferredOpeners.slice(0, 6).join(", ")}`);
  }
  if (sp.preferredSignOffs.length > 0) {
    lines.push(`- Common sign-offs: ${sp.preferredSignOffs.slice(0, 6).join(", ")}`);
  }
  if (sp.humorMarkers.length > 0) {
    lines.push(`- Humour markers: ${sp.humorMarkers.slice(0, 6).join(", ")}`);
  }
  if (sp.tabooPhrases.length > 0) {
    lines.push(`- Avoid (taboo): ${sp.tabooPhrases.slice(0, 8).join(", ")}`);
  }
  if (sp.averageSentenceLength > 0) {
    lines.push(`- Target sentence length: ~${Math.round(sp.averageSentenceLength)} words`);
  }
  if (sp.categoryPreferenceScores && Object.keys(sp.categoryPreferenceScores).length > 0) {
    const top = Object.entries(sp.categoryPreferenceScores)
      .filter(([, v]) => typeof v === "number" && (v as number) > 0)
      .sort(([, a], [, b]) => (b as number) - (a as number))
      .slice(0, 4)
      .map(([cat, rate]) => `${cat} ${((rate as number) * 100) | 0}%`)
      .join(", ");
    if (top) lines.push(`- Preferred categories: ${top}`);
  }
  return lines.join("\n");
}

function expandSystemPrompt(ctx: ExpandContext): string {
  const name = ctx.jamesName || "James";
  return `You polish ${name}'s rough typed input into one short, natural sentence in his voice.

Rules:
- Keep it to one or two sentences.
- First-person, conversational, no emojis.
- Don't add information ${name} didn't intend — only fix grammar, expand shorthand, smooth the phrasing.
- Output the polished sentence ONLY. No quotes, no commentary, no prefix.`;
}

function formatTranscript(turns: Array<{ speaker: string; text: string }>): string {
  if (turns.length === 0) return "(no transcript yet)";
  return turns.map((t) => `${t.speaker}: ${t.text}`).join("\n");
}

// --------------------------------------------------------------------------

const SUGGESTION_CATEGORIES = new Set<SuggestionCategory>([
  "answer",
  "question",
  "followup",
  "planned",
  "humor",
  "clarify",
  "give-me-a-moment",
]);

function parseSuggestions(raw: string): SuggestionDraft[] {
  // Models sometimes wrap JSON in ```json fences or trailing prose. Strip
  // anything outside the first balanced { ... } block.
  const json = extractJsonObject(raw);
  if (!json) throw new Error(`generateSuggestions: no JSON in response\n${raw}`);

  let parsed: { suggestions?: unknown };
  try {
    parsed = JSON.parse(json) as { suggestions?: unknown };
  } catch (err) {
    throw new Error(`generateSuggestions: malformed JSON: ${(err as Error).message}`);
  }
  if (!Array.isArray(parsed.suggestions)) {
    throw new Error("generateSuggestions: response missing `suggestions` array");
  }

  const drafts: SuggestionDraft[] = [];
  for (const item of parsed.suggestions) {
    if (!item || typeof item !== "object") continue;
    const o = item as { text?: unknown; category?: unknown; why?: unknown };
    if (typeof o.text !== "string" || o.text.trim().length === 0) continue;
    const category = SUGGESTION_CATEGORIES.has(o.category as SuggestionCategory)
      ? (o.category as SuggestionCategory)
      : "answer";
    drafts.push({
      text: o.text.trim(),
      category,
      why: typeof o.why === "string" && o.why.trim().length > 0 ? o.why.trim() : undefined,
    });
  }
  return drafts;
}

function extractJsonObject(s: string): string | null {
  // Find the first '{' and walk to its balanced match. Robust to fenced code
  // blocks and stray prose around the JSON.
  let depth = 0;
  let start = -1;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (c === "}") {
      depth--;
      if (depth === 0 && start >= 0) return s.slice(start, i + 1);
    }
  }
  return null;
}

/**
 * Stateful scanner that consumes streamed JSON text one chunk at a time and
 * emits each `{ text, category, why }` object inside the top-level
 * `"suggestions"` array as soon as that object closes.
 *
 * Why this exists: the live cockpit needs the first suggestion card visible
 * at TTFT (~400–900 ms), not after the full response (~1.5–3.5 s). Pulling a
 * streaming-JSON parser dependency would be overkill — the shape is fixed,
 * so a small depth tracker with string/escape awareness is enough.
 *
 * Tolerance: malformed or unparsable objects are skipped silently. The final
 * non-streaming reparse in `generateSuggestions` back-fills anything we
 * missed (e.g. when the model's last object closes the same instant the
 * containing array does and we never re-enter the scanner).
 */
class StreamingSuggestionScanner {
  /** Drafts captured so far, in order of appearance. */
  readonly drafts: SuggestionDraft[] = [];

  private buffer = "";
  /** Index in `buffer` we've already scanned up to (exclusive). */
  private cursor = 0;
  /** Brace depth inside the suggestions array (each suggestion object is 1). */
  private depth = 0;
  /** Are we currently inside a string literal? */
  private inString = false;
  /** Previous char was a backslash (so the next quote is escaped). */
  private escape = false;
  /** Index in `buffer` of the most recent `{` at depth 1 (i.e. an opening
   * suggestion object). -1 when not currently inside a suggestion. */
  private objStart = -1;
  /** Are we past the `[` of the `"suggestions"` array? */
  private inSuggestionsArray = false;
  /** Where in `buffer` we last looked for the `[` (so we don't re-scan). */
  private arraySearchCursor = 0;

  consume(chunk: string): SuggestionDraft[] {
    this.buffer += chunk;

    if (!this.inSuggestionsArray) {
      // Look for the `"suggestions"` key, then the `[` that follows it. We
      // start tracking depth only after we see that opening bracket so we
      // don't accidentally count braces in the surrounding object.
      const keyIdx = this.buffer.indexOf('"suggestions"', this.arraySearchCursor);
      if (keyIdx < 0) {
        // Keep enough of a tail to catch a `"suggestions"` that straddles
        // chunk boundaries.
        this.arraySearchCursor = Math.max(0, this.buffer.length - '"suggestions"'.length);
        return this.drafts;
      }
      const bracketIdx = this.buffer.indexOf("[", keyIdx);
      if (bracketIdx < 0) {
        this.arraySearchCursor = keyIdx;
        return this.drafts;
      }
      this.inSuggestionsArray = true;
      this.cursor = bracketIdx + 1;
    }

    for (let i = this.cursor; i < this.buffer.length; i++) {
      const c = this.buffer[i];

      if (this.inString) {
        if (this.escape) {
          this.escape = false;
        } else if (c === "\\") {
          this.escape = true;
        } else if (c === '"') {
          this.inString = false;
        }
        continue;
      }

      if (c === '"') {
        this.inString = true;
        continue;
      }
      if (c === "{") {
        if (this.depth === 0) this.objStart = i;
        this.depth++;
        continue;
      }
      if (c === "}") {
        this.depth--;
        if (this.depth === 0 && this.objStart >= 0) {
          const objText = this.buffer.slice(this.objStart, i + 1);
          this.objStart = -1;
          const draft = parseSingleSuggestion(objText);
          if (draft) this.drafts.push(draft);
        }
        continue;
      }
      if (c === "]" && this.depth === 0) {
        // End of suggestions array; nothing more to scan.
        this.cursor = i + 1;
        return this.drafts;
      }
    }

    this.cursor = this.buffer.length;
    return this.drafts;
  }
}

function parseSingleSuggestion(objText: string): SuggestionDraft | null {
  let parsed: { text?: unknown; category?: unknown; why?: unknown };
  try {
    parsed = JSON.parse(objText) as { text?: unknown; category?: unknown; why?: unknown };
  } catch {
    return null;
  }
  if (typeof parsed.text !== "string" || parsed.text.trim().length === 0) return null;
  const category = SUGGESTION_CATEGORIES.has(parsed.category as SuggestionCategory)
    ? (parsed.category as SuggestionCategory)
    : "answer";
  return {
    text: parsed.text.trim(),
    category,
    why:
      typeof parsed.why === "string" && parsed.why.trim().length > 0
        ? parsed.why.trim()
        : undefined,
  };
}

// --------------------------------------------------------------------------
// Post-conversation summary prompts + parser
// --------------------------------------------------------------------------

function summarizeSystemPrompt(): string {
  return `You summarise transcripts of conversations involving James, a non-verbal man with cerebral palsy who replies via an AAC iPad. Your summary appears in his Recent view so he can scan past chats at a glance.

Output strictly as JSON, no commentary:

{
  "summary": "string (one short paragraph, 2-4 sentences, past tense)",
  "highlights": ["string", "string", "..."]
}

Rules:
- summary: who was there, what they talked about, any decisions or commitments. Past tense, third-person where natural ("James asked about...", "Mum mentioned..."). 2-4 sentences max.
- highlights: 3-6 short bullets (each under 12 words). Concrete moments, not generic observations. Skip filler.
- NEVER invent facts or details not present in the transcript. If the transcript is sparse, return a short summary and few highlights.`;
}

function summarizeUserPrompt(ctx: SummarizeConversationContext): string {
  const peopleLine =
    ctx.peopleNames && ctx.peopleNames.length > 0
      ? `People present: ${ctx.peopleNames.join(", ")}\n\n`
      : "";
  return `${peopleLine}Transcript:
"""
${ctx.transcript}
"""

Return JSON only.`;
}

function parseSummary(raw: string): SummarizeConversationResult {
  const json = extractJsonObject(raw);
  if (!json) return { summary: raw.trim().slice(0, 600), highlights: [] };
  let parsed: { summary?: unknown; highlights?: unknown };
  try {
    parsed = JSON.parse(json) as { summary?: unknown; highlights?: unknown };
  } catch {
    return { summary: raw.trim().slice(0, 600), highlights: [] };
  }
  const summary =
    typeof parsed.summary === "string" && parsed.summary.trim().length > 0
      ? parsed.summary.trim()
      : "";
  const highlights: string[] = [];
  if (Array.isArray(parsed.highlights)) {
    for (const item of parsed.highlights) {
      if (typeof item === "string" && item.trim().length > 0) {
        highlights.push(item.trim());
      }
    }
  }
  return { summary, highlights };
}

function extractLexiconSystemPrompt(): string {
  return `You build a per-person vocabulary list that feeds a speech-recognition keyterm-biasing system. The model uses it to recognise proper nouns and unusual words a person actually says.

Output strictly as JSON, no commentary:

{
  "terms": [
    { "term": "string", "weight": number, "reasoning": "string (optional)" }
  ]
}

Rules:
- Pick 5–15 entries. Fewer is fine when the transcript is sparse.
- Favour proper nouns (names of people, pets, places, products, projects), distinctive jargon, technical terms, sports/hobby vocabulary, and unusual words.
- Skip common English words, conversational filler, generic verbs/adjectives.
- Skip anything already in the existing-terms list (case-insensitive match).
- "weight" 1.0–2.0. Use the high end (1.6–2.0) for distinctive proper nouns the speech model would otherwise hallucinate. Use the low end (1.0–1.3) for general jargon.
- Keep each term ≤ 20 characters. Single token or very short phrase.
- Original casing of the term as it would appear in writing ("Anna", "MRI", "iPad").`;
}

function extractLexiconUserPrompt(ctx: ExtractLexiconContext): string {
  const existingBlock =
    ctx.existingTerms && ctx.existingTerms.length > 0
      ? `Existing terms (do NOT repeat any of these, case-insensitive):\n${ctx.existingTerms.join(", ")}\n\n`
      : "Existing terms: (none)\n\n";
  return `Person speaking: ${ctx.personName}

${existingBlock}Their turns (with light context):
"""
${ctx.transcript}
"""

Return JSON only.`;
}

function parseExtractLexicon(raw: string): ExtractLexiconResult {
  const json = extractJsonObject(raw);
  if (!json) return { terms: [] };
  let parsed: { terms?: unknown };
  try {
    parsed = JSON.parse(json) as { terms?: unknown };
  } catch {
    return { terms: [] };
  }
  if (!Array.isArray(parsed.terms)) return { terms: [] };
  const out: ExtractLexiconEntry[] = [];
  for (const item of parsed.terms) {
    if (!item || typeof item !== "object") continue;
    const o = item as { term?: unknown; weight?: unknown; reasoning?: unknown };
    if (typeof o.term !== "string" || o.term.trim().length === 0) continue;
    const weightNum = typeof o.weight === "number" && Number.isFinite(o.weight) ? o.weight : 1.0;
    out.push({
      term: o.term.trim(),
      weight: weightNum,
      reasoning:
        typeof o.reasoning === "string" && o.reasoning.trim().length > 0
          ? o.reasoning.trim()
          : undefined,
    });
  }
  return { terms: out };
}

function eventPrepSystemPrompt(ctx: EventPrepContext): string {
  const name = ctx.jamesProfile?.displayName || "James";
  const personaBlock = ctx.jamesProfile ? `\n${jamesProfileBlock(ctx.jamesProfile)}\n` : "";
  return `You help ${name}, a non-verbal man with cerebral palsy who communicates by tapping suggested replies on an iPad, prepare for an upcoming conversation. Your output appears on the Events page before the conversation happens.
${personaBlock}
Goal: give ${name} 4–6 concrete talking points he could raise, and 3–5 questions he could ask. Bias toward the things he actually cares about (use his profile). Skip generic small talk unless his profile signals he enjoys it. Never invent facts about the attendees.

Output strictly as JSON, no commentary:

{
  "keyPoints": ["string", "string", "..."],
  "keyQuestions": ["string", "string", "..."]
}

Rules:
- 4–6 keyPoints, 3–5 keyQuestions.
- Each entry under 18 words.
- First-person where natural ("I want to ask about...", "Tell them about..."), conversational.
- Concrete, not generic.`;
}

function eventPrepUserPrompt(ctx: EventPrepContext): string {
  const lines: string[] = [];
  lines.push(`Event: ${ctx.eventName}`);
  lines.push(`When: ${ctx.eventWhen}`);
  if (ctx.placeName) lines.push(`Where: ${ctx.placeName}`);
  if (ctx.attendeeNames.length > 0) lines.push(`Attendees: ${ctx.attendeeNames.join(", ")}`);
  if (ctx.keyInfo?.trim()) lines.push(`Notes about the event:\n${ctx.keyInfo.trim()}`);
  if (ctx.userPrompt?.trim()) lines.push(`What he wants from prep: ${ctx.userPrompt.trim()}`);
  lines.push("");
  lines.push("Return JSON only.");
  return lines.join("\n");
}

function parseEventPrep(raw: string): EventPrepResult {
  const json = extractJsonObject(raw);
  if (!json) return { keyPoints: [], keyQuestions: [] };
  let parsed: { keyPoints?: unknown; keyQuestions?: unknown };
  try {
    parsed = JSON.parse(json) as { keyPoints?: unknown; keyQuestions?: unknown };
  } catch {
    return { keyPoints: [], keyQuestions: [] };
  }
  const stringArray = (raw: unknown): string[] => {
    if (!Array.isArray(raw)) return [];
    const out: string[] = [];
    for (const item of raw) {
      if (typeof item === "string" && item.trim().length > 0) out.push(item.trim());
    }
    return out;
  };
  return {
    keyPoints: stringArray(parsed.keyPoints),
    keyQuestions: stringArray(parsed.keyQuestions),
  };
}

// --------------------------------------------------------------------------
// Helpers-tab prompts: draft reply + interest extraction
// --------------------------------------------------------------------------

function jamesProfileBlock(jp: JamesProfile | undefined): string {
  if (!jp) return "";
  const lines: string[] = [`# About ${jp.displayName || "James"} (the person writing)`];
  if (jp.background) lines.push(`Background: ${jp.background}`);
  if (jp.personality) lines.push(`Personality: ${jp.personality}`);
  if (jp.humorStyle) lines.push(`Humor style: ${jp.humorStyle}`);
  if (jp.communicationStyle) lines.push(`Communication style: ${jp.communicationStyle}`);
  if (jp.topicsLoved && jp.topicsLoved.length > 0) {
    lines.push(`Topics he loves: ${jp.topicsLoved.join(", ")}`);
  }
  if (jp.topicsAvoided && jp.topicsAvoided.length > 0) {
    lines.push(`Topics he avoids: ${jp.topicsAvoided.join(", ")}`);
  }
  if (jp.currentLifeContext) lines.push(`Current life context: ${jp.currentLifeContext}`);
  if (jp.signaturePhrases && jp.signaturePhrases.length > 0) {
    lines.push(`Signature phrases (use his actual voice):\n- ${jp.signaturePhrases.join("\n- ")}`);
  }
  if (jp.notes) lines.push(`Other notes about him:\n${jp.notes}`);
  return lines.join("\n") + "\n";
}

function draftReplySystemPrompt(ctx: DraftReplyContext): string {
  const name = ctx.jamesProfile?.displayName || "James";
  const platformLabel =
    ctx.platform === "email"
      ? "an email"
      : ctx.platform === "imessage"
        ? "an iMessage / text message"
        : "a Facebook post or comment";
  const toneHint =
    ctx.platform === "email"
      ? "Email tone: complete sentences, polite, can be a few short paragraphs. Sign off as he normally would (or omit signature if his profile doesn't suggest one)."
      : ctx.platform === "imessage"
        ? "Text-message tone: short, casual, lower-case ok, contractions, can use a single emoji if it fits him. Usually 1-2 short sentences."
        : "Facebook tone: warm, conversational, concise. Emojis sparingly only if it fits his personality.";
  const styleBlock = ctx.styleProfile ? `\n\n${styleProfileBlock(ctx.styleProfile, name)}` : "";

  return `You are a writing assistant helping ${name}, a non-speaking man with cerebral palsy, write ${platformLabel}. He types with great difficulty so his input is heavily truncated and full of typos — interpret it generously. Rewrite as authentically HIM (his personality, humor, vocabulary). NEVER invent facts, opinions, names, plans, or details he did not type or that aren't in his profile. ${toneHint}${styleBlock}

Output strictly as JSON, no commentary:

{
  "recommended": "string",
  "alternatives": [
    { "text": "string", "tone": "string" }
  ]
}

Produce one polished recommended draft plus 2–4 alternative variations with different tones (e.g. shorter / warmer / drier-witted). JSON only.`;
}

function draftReplyUserPrompt(ctx: DraftReplyContext): string {
  const profileBlock = jamesProfileBlock(ctx.jamesProfile);
  const contextBlock = ctx.context ? `# Context\n${ctx.context}\n` : "";
  const incomingBlock = ctx.incoming?.trim()
    ? `# What he received / is replying to\n"""\n${ctx.incoming.trim()}\n"""\n`
    : "";
  const name = ctx.jamesProfile?.displayName || "James";
  const override = ctx.toneOverride?.trim();
  const overrideLine = override
    ? `\nOverride the tone — make this version ${override}. Keep the same intent and content.`
    : "";
  return `${profileBlock}${contextBlock}${incomingBlock}
# What ${name} typed (rough, may have typos / be truncated)
"${ctx.rawText}"

Produce one polished recommended draft plus 2–4 alternative variations with different tones. JSON only.${overrideLine}`;
}

function parseDraftReply(raw: string, fallbackText: string): DraftReplyResult {
  const json = extractJsonObject(raw);
  if (!json) {
    return { recommended: fallbackText, alternatives: [], error: "No JSON in response" };
  }
  let parsed: { recommended?: unknown; alternatives?: unknown };
  try {
    parsed = JSON.parse(json) as { recommended?: unknown; alternatives?: unknown };
  } catch (err) {
    return {
      recommended: fallbackText,
      alternatives: [],
      error: `Malformed JSON: ${(err as Error).message}`,
    };
  }
  const recommended =
    typeof parsed.recommended === "string" && parsed.recommended.trim().length > 0
      ? parsed.recommended.trim()
      : fallbackText;
  const alternatives: DraftReplyVariation[] = [];
  if (Array.isArray(parsed.alternatives)) {
    for (const item of parsed.alternatives) {
      if (!item || typeof item !== "object") continue;
      const o = item as { text?: unknown; tone?: unknown };
      if (typeof o.text !== "string" || o.text.trim().length === 0) continue;
      alternatives.push({
        text: o.text.trim(),
        tone: typeof o.tone === "string" ? o.tone.trim() : "",
      });
    }
  }
  return { recommended, alternatives };
}

function extractInterestsSystemPrompt(ctx: ExtractInterestsContext): string {
  const name = ctx.jamesName || "James";
  return `You are a careful profile-keeper for ${name}, a non-speaking AAC user. Looking at a message he just wrote (and optionally what he received), suggest 0-3 SHORT additions to his profile that would help an AI assistant respond more like him in the future.

Categories:
- "topic_loved" — a hobby/subject he clearly cares about
- "current_context" — a current life event/plan/health/family update
- "signature_phrase" — a recurring expression or way of speaking

Only suggest things clearly evidenced in the text. Skip if nothing meaningful is new. Each suggestion must be under 12 words. Do NOT repeat anything already present in his current profile fields.

Output strictly as JSON, no commentary:

{
  "suggestions": [
    { "kind": "topic_loved|current_context|signature_phrase", "text": "string", "why": "string (optional)" }
  ]
}`;
}

function extractInterestsUserPrompt(ctx: ExtractInterestsContext): string {
  const incomingBlock = ctx.incoming?.trim()
    ? `# What he received\n"""\n${ctx.incoming.trim()}\n"""\n`
    : "";
  return `# Already in his profile (do NOT repeat)
Topics loved: ${ctx.currentTopicsLoved || "(none)"}
Current life context: ${ctx.currentLifeContext || "(none)"}
Signature phrases: ${ctx.currentSignaturePhrases || "(none)"}

${incomingBlock}# What he just wrote
"""
${ctx.draft}
"""

Return 0-3 suggested profile additions. JSON only.`;
}

// --------------------------------------------------------------------------
// Style distillation prompts + parser
// --------------------------------------------------------------------------

function distillStyleSystemPrompt(): string {
  return `You distill James's reply-style evidence into a structured profile that downstream prompts will inject. James is a non-verbal man with cerebral palsy who taps AI-suggested replies on an iPad.

You are given four evidence channels:
- tappedExamples: suggestions James actually tapped (proxy for "yes, this is me").
- ignoredExamples: suggestions James left unread (proxy for "not me").
- editedExamples: where the model proposed X and James edited it to Y before speaking (the strongest signal — Y is his voice).
- helperEdits: Helpers-tab drafts where the model proposed "recommended" and James edited to "jamesEdit" before sending. Same strong signal as editedExamples.

Roll these into a stable style profile. Be conservative: prefer the smaller / safer claim when evidence is thin. Don't echo phrases verbatim unless they recur.

Output strictly as JSON, no commentary:

{
  "preferredOpeners": ["string", "..."],
  "preferredSignOffs": ["string", "..."],
  "formality": "casual|neutral|formal",
  "humorMarkers": ["string", "..."],
  "tabooPhrases": ["string", "..."],
  "averageSentenceLength": number,
  "readingGradeEstimate": number,
  "categoryPreferenceScores": { "answer": 0.0, "question": 0.0, "followup": 0.0, "planned": 0.0, "humor": 0.0, "clarify": 0.0, "give-me-a-moment": 0.0 },
  "summary": "string (one short sentence describing what changed since the previous profile, optional)"
}

Rules:
- preferredOpeners / preferredSignOffs: 0-6 entries each. Phrases James actually uses, not generic ones.
- humorMarkers: 0-8 short phrases or recurring jokes. Skip if no humor signal.
- tabooPhrases: 0-8 phrases James consistently ignored or edited away. These become "do NOT propose" hints.
- formality: pick one. "neutral" is the safe default.
- averageSentenceLength: in words. Estimate from tapped+edited rows.
- readingGradeEstimate: US grade level (e.g. 6 = sixth grade). Rough estimate.
- categoryPreferenceScores: 0.0–1.0 per category. Higher = James picks it more often. Omit categories with no signal rather than guessing 0.
- summary: optional one sentence ("now leans short and dry", "more questions for family"). Skip when nothing meaningful changed.`;
}

function distillStyleUserPrompt(ctx: DistillStyleContext): string {
  const profile = ctx.jamesProfile ? jamesProfileBlock(ctx.jamesProfile) : "";
  const previousBlock = ctx.previous
    ? `# Previous style profile (refine this, don't reset it)\n${JSON.stringify(ctx.previous, null, 2)}\n\n`
    : "";
  const samplesBlock = `# Evidence\n${JSON.stringify(ctx.samples, null, 2)}\n\n`;
  return `${profile}${previousBlock}${samplesBlock}Return JSON only.`;
}

function parseStyleProfile(raw: string): DistilledStyleProfile {
  const json = extractJsonObject(raw);
  const fallback: DistilledStyleProfile = {
    preferredOpeners: [],
    preferredSignOffs: [],
    formality: "neutral",
    humorMarkers: [],
    tabooPhrases: [],
    averageSentenceLength: 0,
    readingGradeEstimate: 0,
    categoryPreferenceScores: {},
  };
  if (!json) return fallback;
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(json) as Record<string, unknown>;
  } catch {
    return fallback;
  }
  const stringArray = (v: unknown): string[] => {
    if (!Array.isArray(v)) return [];
    const out: string[] = [];
    for (const item of v) {
      if (typeof item === "string" && item.trim().length > 0) out.push(item.trim());
    }
    return out;
  };
  const formality: DistilledStyleProfile["formality"] =
    parsed.formality === "casual" || parsed.formality === "formal" ? parsed.formality : "neutral";
  const numeric = (v: unknown, fallback: number): number =>
    typeof v === "number" && Number.isFinite(v) ? v : fallback;
  const categoryScores: Partial<Record<SuggestionCategory, number>> = {};
  if (parsed.categoryPreferenceScores && typeof parsed.categoryPreferenceScores === "object") {
    const raw = parsed.categoryPreferenceScores as Record<string, unknown>;
    for (const cat of SUGGESTION_CATEGORIES) {
      const v = raw[cat];
      if (typeof v === "number" && Number.isFinite(v)) {
        categoryScores[cat] = Math.max(0, Math.min(1, v));
      }
    }
  }
  return {
    preferredOpeners: stringArray(parsed.preferredOpeners),
    preferredSignOffs: stringArray(parsed.preferredSignOffs),
    formality,
    humorMarkers: stringArray(parsed.humorMarkers),
    tabooPhrases: stringArray(parsed.tabooPhrases),
    averageSentenceLength: numeric(parsed.averageSentenceLength, 0),
    readingGradeEstimate: numeric(parsed.readingGradeEstimate, 0),
    categoryPreferenceScores: categoryScores,
    summary: typeof parsed.summary === "string" ? parsed.summary.trim() : undefined,
  };
}

// --------------------------------------------------------------------------
// Memory extraction prompts + parser
// --------------------------------------------------------------------------

function extractMemoriesSystemPrompt(): string {
  return `You extract short, durable memories from a conversation involving James, a non-speaking man with cerebral palsy who replies via an AAC iPad. These memories feed semantic top-K retrieval for future suggestion calls — only the memorable, person-specific or place-specific items are worth keeping.

Output strictly as JSON, no commentary:

{
  "memories": [
    { "personIdRef": "string (one of the provided names, or null)", "kind": "fact|preference|joke|event", "text": "string" }
  ]
}

Rules:
- Up to 8 memories. Fewer is fine; skip generic items.
- text: ≤ 15 words. Factual statement attributing the info to a specific person where applicable ("Jack's son just started cricket", not "Their kid plays sport").
- kind: "fact" = durable info; "preference" = likes/dislikes/opinions; "joke" = shared humor or running references; "event" = one-off plans, dates.
- personIdRef: pick exactly one name from the provided list when the memory is about that person; null otherwise. Do NOT invent names.
- NEVER fabricate. If the transcript is sparse, return fewer memories.`;
}

function extractMemoriesUserPrompt(ctx: ExtractMemoriesContext): string {
  const profile = ctx.jamesProfile ? jamesProfileBlock(ctx.jamesProfile) : "";
  return `${profile}# People in the room (use these exact names for personIdRef)
${ctx.peopleNames.length > 0 ? ctx.peopleNames.join(", ") : "(none)"}

# Transcript
"""
${ctx.transcript}
"""

Return JSON only.`;
}

const MEMORY_KINDS = new Set<ExtractedMemoryKind>(["fact", "preference", "joke", "event"]);

function parseExtractedMemories(raw: string, peopleNames: string[]): ExtractMemoriesResult {
  const json = extractJsonObject(raw);
  if (!json) return { memories: [] };
  let parsed: { memories?: unknown };
  try {
    parsed = JSON.parse(json) as { memories?: unknown };
  } catch {
    return { memories: [] };
  }
  if (!Array.isArray(parsed.memories)) return { memories: [] };
  // Resolve personIdRef (a name string) back to nothing — the job layer
  // resolves names to db ids since we don't have the id mapping here.
  // We surface the matched name via the `personId` slot as the raw name; the
  // job-layer caller does the final lookup. Empty string when unresolved.
  const namesLower = new Map<string, string>(peopleNames.map((n) => [n.toLowerCase(), n]));
  const out: ExtractedMemory[] = [];
  for (const item of parsed.memories) {
    if (!item || typeof item !== "object") continue;
    const o = item as { personIdRef?: unknown; kind?: unknown; text?: unknown };
    if (typeof o.text !== "string" || o.text.trim().length === 0) continue;
    if (!MEMORY_KINDS.has(o.kind as ExtractedMemoryKind)) continue;
    let personMatch: string | undefined;
    if (typeof o.personIdRef === "string" && o.personIdRef.trim().length > 0) {
      const matched = namesLower.get(o.personIdRef.trim().toLowerCase());
      if (matched) personMatch = matched;
    }
    out.push({
      personId: personMatch,
      kind: o.kind as ExtractedMemoryKind,
      text: o.text.trim(),
    });
  }
  return { memories: out };
}

// --------------------------------------------------------------------------
// Profile enrichment prompts + parser
// --------------------------------------------------------------------------

function enrichPersonProfileSystemPrompt(): string {
  return `You are a conservative profile-keeper. Looking at a focused transcript of one person's turns (with James's responses for context), propose 0-5 SHORT additions to their Person row. Only emit a proposal when the evidence is clear and durable — single passing remarks don't count.

You may propose against three fields:
- relationship: how this person relates to James (e.g. "mum", "carer", "schoolfriend"). Use "set" op.
- topicsLoved: subjects they clearly enjoy talking about. Use "append" op, one topic per proposal.
- notes: short factual notes about them. Use "append" op, one note per proposal.

Output strictly as JSON, no commentary:

{
  "proposals": [
    { "field": "relationship|topicsLoved|notes", "op": "set|append|remove", "value": "string", "reasoning": "string (one short clause)" }
  ]
}

Rules:
- 0-5 proposals. Empty list is fine and often correct.
- value: ≤ 12 words.
- NEVER invent facts. Skip if the evidence is ambiguous.
- Do NOT repeat anything already in the currentProfile (case-insensitive).`;
}

function enrichPersonProfileUserPrompt(ctx: EnrichPersonProfileContext): string {
  const cp = ctx.currentProfile;
  const profileBlock = ctx.jamesProfile ? jamesProfileBlock(ctx.jamesProfile) : "";
  const currentBlock = `# Current profile (do NOT repeat)
Relationship: ${cp?.relationship?.trim() || "(unset)"}
Topics loved: ${cp?.topicsLoved && cp.topicsLoved.length > 0 ? cp.topicsLoved.join(", ") : "(none)"}
Notes: ${cp?.notes?.trim() || "(none)"}

`;
  return `${profileBlock}${currentBlock}# Person speaking: ${ctx.personName}

# Focused transcript (their turns + light context)
"""
${ctx.transcript}
"""

Return JSON only. Empty list if nothing meaningful is new.`;
}

const PROFILE_OPS = new Set<ProfileProposalDraft["op"]>(["set", "append", "remove"]);
const PROFILE_FIELDS = new Set(["relationship", "topicsLoved", "notes"]);

function parseEnrichPersonProfile(raw: string): EnrichPersonProfileResult {
  const json = extractJsonObject(raw);
  if (!json) return { proposals: [] };
  let parsed: { proposals?: unknown };
  try {
    parsed = JSON.parse(json) as { proposals?: unknown };
  } catch {
    return { proposals: [] };
  }
  if (!Array.isArray(parsed.proposals)) return { proposals: [] };
  const out: ProfileProposalDraft[] = [];
  for (const item of parsed.proposals) {
    if (!item || typeof item !== "object") continue;
    const o = item as { field?: unknown; op?: unknown; value?: unknown; reasoning?: unknown };
    if (typeof o.value !== "string" || o.value.trim().length === 0) continue;
    if (typeof o.field !== "string" || !PROFILE_FIELDS.has(o.field)) continue;
    const op = PROFILE_OPS.has(o.op as ProfileProposalDraft["op"])
      ? (o.op as ProfileProposalDraft["op"])
      : "append";
    out.push({
      field: o.field,
      op,
      value: o.value.trim(),
      reasoning:
        typeof o.reasoning === "string" && o.reasoning.trim().length > 0
          ? o.reasoning.trim()
          : undefined,
    });
  }
  return { proposals: out };
}

// --------------------------------------------------------------------------
// Introduction detection prompts + parser
// --------------------------------------------------------------------------

function detectIntroductionsSystemPrompt(): string {
  return `You confirm which regex-shortlisted names are actual self-introductions in a transcript. A self-introduction is when someone names themselves to James ("Hi, I'm Sarah", "This is Dr Patel speaking", "My name's Anna"). Skip false positives like "meet me at the cafe" or generic mentions of a third party.

Output strictly as JSON, no commentary:

{
  "confirmed": [
    { "name": "string", "confidence": 0.0 }
  ]
}

Rules:
- Only emit names that are clearly self-introductions in the transcript.
- confidence: 0.0–1.0. Use ≥0.7 only when you're sure.
- Skip a candidate if you're unsure rather than guessing.`;
}

function detectIntroductionsUserPrompt(ctx: DetectIntroductionsContext): string {
  return `# Candidate names (from regex pre-filter)
${ctx.candidates.length > 0 ? ctx.candidates.join(", ") : "(none)"}

# Transcript
"""
${ctx.transcript}
"""

Return JSON only.`;
}

function parseDetectIntroductions(raw: string): DetectIntroductionsResult {
  const json = extractJsonObject(raw);
  if (!json) return { confirmed: [] };
  let parsed: { confirmed?: unknown };
  try {
    parsed = JSON.parse(json) as { confirmed?: unknown };
  } catch {
    return { confirmed: [] };
  }
  if (!Array.isArray(parsed.confirmed)) return { confirmed: [] };
  const out: ConfirmedIntroduction[] = [];
  for (const item of parsed.confirmed) {
    if (!item || typeof item !== "object") continue;
    const o = item as { name?: unknown; confidence?: unknown };
    if (typeof o.name !== "string" || o.name.trim().length === 0) continue;
    const confidence =
      typeof o.confidence === "number" && Number.isFinite(o.confidence)
        ? Math.max(0, Math.min(1, o.confidence))
        : 0;
    out.push({ name: o.name.trim(), confidence });
  }
  return { confirmed: out };
}

function identifySpeakerSystemPrompt(ctx: IdentifySpeakerContext): string {
  const jamesName = ctx.jamesProfile?.displayName || "James";
  const candList = ctx.candidates.map((c) => `- ${c}`).join("\n");
  return `You are the speaker-identification tie-breaker for ${jamesName}'s AAC iPad. The voice-similarity matcher couldn't decide between two candidates; you read the recent transcript window and pick the single best match.

Choose strictly from this candidate list (or "unknown" if no candidate clearly fits):
${candList || "(no candidates)"}

Output strictly as JSON, no commentary:

{ "name": "<one of the candidates, or 'unknown'>", "confidence": <0..1>, "reasoning": "<one short sentence>" }

JSON only.`;
}

function identifySpeakerUserPrompt(ctx: IdentifySpeakerContext): string {
  const lines: string[] = [];
  if (ctx.place) lines.push(`Place: ${ctx.place}`);
  if (ctx.event) lines.push(`Event: ${ctx.event}`);
  lines.push("");
  lines.push("Recent transcript:");
  lines.push(formatTranscript(ctx.transcript));
  lines.push("");
  lines.push("Who is the most recent 'Other' speaker? JSON only.");
  return lines.join("\n");
}

function parseIdentifySpeaker(raw: string, candidates: string[]): IdentifySpeakerResult {
  const json = extractJsonObject(raw);
  if (!json) return { name: "unknown", confidence: 0 };
  let parsed: { name?: unknown; confidence?: unknown; reasoning?: unknown };
  try {
    parsed = JSON.parse(json) as typeof parsed;
  } catch {
    return { name: "unknown", confidence: 0 };
  }
  const name =
    typeof parsed.name === "string" && parsed.name.trim().length > 0
      ? parsed.name.trim()
      : "unknown";
  const lowered = name.toLowerCase();
  const matched =
    lowered === "unknown"
      ? "unknown"
      : (candidates.find((c) => c.toLowerCase() === lowered) ?? "unknown");
  const confidence =
    typeof parsed.confidence === "number" && Number.isFinite(parsed.confidence)
      ? Math.max(0, Math.min(1, parsed.confidence))
      : 0;
  const reasoning =
    typeof parsed.reasoning === "string" && parsed.reasoning.trim().length > 0
      ? parsed.reasoning.trim()
      : undefined;
  return { name: matched, confidence, reasoning };
}

function rediarizeTieBreakerSystemPrompt(): string {
  return `You are a post-conversation speaker-attribution tie-breaker. Each input candidate is a transcript segment whose top-two voice matches were too close to call from voice alone. Read the full transcript, judge which speaker each segment best fits, and decide.

Output strictly as JSON, no commentary:

{
  "decisions": [
    { "segmentId": "<id>", "name": "<one of the roster names, or 'unknown'>", "confidence": <0..1> }
  ]
}

Rules:
- Use ONLY names from the roster list provided.
- Use "unknown" if neither candidate fits and you can't justify either.
- One decision per input candidate. JSON only.`;
}

function rediarizeTieBreakerUserPrompt(ctx: RediarizeTieBreakerContext): string {
  const lines: string[] = [];
  lines.push(`Roster: ${ctx.rosterNames.join(", ") || "(empty)"}`);
  lines.push("");
  lines.push("Full transcript:");
  lines.push(ctx.transcript.slice(-6000));
  lines.push("");
  lines.push("Ambiguous segments:");
  for (const c of ctx.candidates) {
    lines.push(
      `- id="${c.segmentId}" text="${c.text.slice(0, 200).replace(/"/g, "'")}" top1=${c.top1.name}(${c.top1.posterior.toFixed(2)}) top2=${c.top2.name}(${c.top2.posterior.toFixed(2)})`,
    );
  }
  lines.push("");
  lines.push("Return decisions for ALL candidate ids, in any order. JSON only.");
  return lines.join("\n");
}

function parseRediarizeTieBreaker(raw: string): RediarizeTieBreakerResult {
  const json = extractJsonObject(raw);
  if (!json) return { decisions: [] };
  let parsed: { decisions?: unknown };
  try {
    parsed = JSON.parse(json) as { decisions?: unknown };
  } catch {
    return { decisions: [] };
  }
  if (!Array.isArray(parsed.decisions)) return { decisions: [] };
  const out: RediarizeTieBreakerDecision[] = [];
  for (const item of parsed.decisions) {
    if (!item || typeof item !== "object") continue;
    const o = item as { segmentId?: unknown; name?: unknown; confidence?: unknown };
    if (typeof o.segmentId !== "string" || o.segmentId.length === 0) continue;
    if (typeof o.name !== "string" || o.name.length === 0) continue;
    const confidence =
      typeof o.confidence === "number" && Number.isFinite(o.confidence)
        ? Math.max(0, Math.min(1, o.confidence))
        : 0;
    out.push({ segmentId: o.segmentId, name: o.name.trim(), confidence });
  }
  return { decisions: out };
}

const INTEREST_KINDS = new Set<InterestSuggestion["kind"]>([
  "topic_loved",
  "current_context",
  "signature_phrase",
]);

function parseInterestSuggestions(raw: string): {
  suggestions: InterestSuggestion[];
  error?: string;
} {
  const json = extractJsonObject(raw);
  if (!json) return { suggestions: [], error: "No JSON in response" };
  let parsed: { suggestions?: unknown };
  try {
    parsed = JSON.parse(json) as { suggestions?: unknown };
  } catch (err) {
    return { suggestions: [], error: `Malformed JSON: ${(err as Error).message}` };
  }
  if (!Array.isArray(parsed.suggestions)) return { suggestions: [] };
  const out: InterestSuggestion[] = [];
  for (const item of parsed.suggestions) {
    if (!item || typeof item !== "object") continue;
    const o = item as { kind?: unknown; text?: unknown; why?: unknown };
    if (typeof o.text !== "string" || o.text.trim().length === 0) continue;
    if (!INTEREST_KINDS.has(o.kind as InterestSuggestion["kind"])) continue;
    out.push({
      kind: o.kind as InterestSuggestion["kind"],
      text: o.text.trim(),
      why: typeof o.why === "string" && o.why.trim().length > 0 ? o.why.trim() : undefined,
    });
  }
  return { suggestions: out };
}
