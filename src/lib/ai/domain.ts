import type { LLMProvider } from "@/lib/providers";
import type { SuggestionCategory } from "@/lib/db";

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
