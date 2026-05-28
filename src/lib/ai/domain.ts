import type { LLMProvider } from "@/lib/providers";
import type { JamesProfile, SuggestionCategory } from "@/lib/db";

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
};

export type ExpandContext = {
  jamesName: string;
  rawText: string;
  recentTranscript?: Array<{ speaker: string; text: string }>;
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

export class DomainAI {
  constructor(private llm: LLMProvider) {}

  /**
   * Live cockpit's bread-and-butter call. Returns 6 ready-to-tap replies.
   * Fast model, prompt-caching on the persona block.
   */
  async generateSuggestions(ctx: SuggestionContext): Promise<SuggestionDraft[]> {
    const response = await this.llm.complete({
      tier: "fast",
      maxTokens: 800,
      temperature: 0.8,
      cacheSystem: true,
      messages: [
        { role: "system", content: suggestionsSystemPrompt(ctx) },
        { role: "user", content: suggestionsUserPrompt(ctx) },
      ],
    });
    return parseSuggestions(response.text);
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
}

// --------------------------------------------------------------------------

function suggestionsSystemPrompt(ctx: SuggestionContext): string {
  const name = ctx.jamesName || "James";
  return `You are Parley, an AAC reply assistant for ${name}.

${name} is a non-verbal man with cerebral palsy. He communicates by tapping suggested replies on an iPad, which are then spoken aloud in his cloned voice. Your job is to give him 6 ready-to-tap replies whenever someone speaks to him.

Voice and style:
- Sound like ${name}, not like an assistant. First-person ("I", "we", never "James says...").
- Conversational English. Contractions are fine. Avoid emojis.
- 3–15 words per reply is the sweet spot.
- Cover a range — at least one answer, one follow-up question, sometimes a clarification or a light moment.

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
- "planned" — surface an agenda point ${name} wanted to make
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
  lines.push("");
  lines.push("Recent transcript:");
  lines.push(formatTranscript(ctx.transcript));
  lines.push("");
  lines.push("Generate 6 reply suggestions James could tap right now. JSON only.");
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

  return `You are a writing assistant helping ${name}, a non-speaking man with cerebral palsy, write ${platformLabel}. He types with great difficulty so his input is heavily truncated and full of typos — interpret it generously. Rewrite as authentically HIM (his personality, humor, vocabulary). NEVER invent facts, opinions, names, plans, or details he did not type or that aren't in his profile. ${toneHint}

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
  return `${profileBlock}${contextBlock}${incomingBlock}
# What ${name} typed (rough, may have typos / be truncated)
"${ctx.rawText}"

Produce one polished recommended draft plus 2–4 alternative variations with different tones. JSON only.`;
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
