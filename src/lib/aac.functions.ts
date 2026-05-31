import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

function requireElevenLabsApiKey(): string {
  const key = process.env.ELEVENLABS_API_KEY;
  if (!key) throw new Error("ELEVENLABS_API_KEY is not configured");
  return key;
}

function getOpenAIApiKey(): string | undefined {
  // Accept the common alternate names so a key set under any of them works.
  return (
    process.env.OPENAI_API_KEY ||
    process.env.VITE_OPENAI_API_KEY ||
    process.env.OPENAI_KEY ||
    undefined
  );
}

function getAnthropicApiKey(): string | undefined {
  return process.env.ANTHROPIC_API_KEY || process.env.VITE_ANTHROPIC_API_KEY || undefined;
}

function getGeminiApiKey(): string | undefined {
  return (
    process.env.GEMINI_API_KEY ||
    process.env.GOOGLE_API_KEY ||
    process.env.GOOGLE_GENERATIVE_AI_API_KEY ||
    // The key set on this deploy is named after the project/month.
    process.env.gemini_parleymay2026 ||
    process.env.GEMINI_PARLEYMAY2026 ||
    undefined
  );
}

/**
 * Resolve the chat-completions endpoint + auth + model id for a given
 * model selector, supporting Anthropic, OpenAI, and Google Gemini.
 *
 * All three providers expose an OpenAI-compatible /v1/chat/completions
 * surface (same request body with `messages` + `tools` + `tool_choice`,
 * same `choices[0].message.tool_calls[0]` response), so every call site
 * stays unchanged regardless of which key is configured:
 *   - Anthropic: https://api.anthropic.com/v1/chat/completions
 *   - Gemini:    https://generativelanguage.googleapis.com/v1beta/openai/chat/completions
 *   - OpenAI:    https://api.openai.com/v1/chat/completions
 *   - Lovable:   https://ai.gateway.lovable.dev/v1/chat/completions (legacy)
 *
 * Provider selection:
 *   1. An explicit selector prefix wins: "openai-direct/", "anthropic/",
 *      "gemini/" (or "google/"). The text after the slash is the model id.
 *   2. Otherwise auto-pick by whichever key is present, in priority order
 *      Anthropic → OpenAI → Gemini → Lovable. The default gateway model id
 *      is mapped to a sensible model for the chosen provider.
 */
type ChatProvider = "anthropic" | "openai" | "gemini" | "lovable";
type ChatTarget = {
  provider: ChatProvider;
  url: string;
  headers: Record<string, string>;
  model: string;
};

/**
 * Build a target for each provider, or null if that provider has no key.
 * `explicitModel` (from a "provider/model" selector) bypasses the mapper.
 */
function buildTarget(
  provider: ChatProvider,
  m: string,
  explicitModel?: string,
): ChatTarget | null {
  if (provider === "anthropic") {
    const key = getAnthropicApiKey();
    if (!key) return null;
    return {
      provider,
      // Anthropic's OpenAI-compatible endpoint authenticates with a Bearer
      // token (mimicking OpenAI), NOT the native x-api-key header.
      url: "https://api.anthropic.com/v1/chat/completions",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      model: explicitModel ?? mapToAnthropic(m),
    };
  }
  if (provider === "openai") {
    const key = getOpenAIApiKey();
    if (!key) return null;
    return {
      provider,
      url: "https://api.openai.com/v1/chat/completions",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      model: explicitModel ?? mapToOpenAI(m),
    };
  }
  if (provider === "gemini") {
    const key = getGeminiApiKey();
    if (!key) return null;
    return {
      provider,
      url: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      // An EXPLICIT gemini/<id> selection is honoured verbatim (a paid-tier user
      // can pick Pro; a free-tier user's Pro request 429s and the chain falls
      // back). Only auto-picked / legacy "google/…" ids get the free-tier-safe
      // downgrade to flash.
      model: explicitModel ? explicitModel : mapToGemini(m),
    };
  }
  // lovable (legacy gateway)
  const lk = process.env.LOVABLE_API_KEY;
  if (!lk) return null;
  return {
    provider,
    url: "https://ai.gateway.lovable.dev/v1/chat/completions",
    headers: { Authorization: `Bearer ${lk}`, "Content-Type": "application/json" },
    model: explicitModel ?? m,
  };
}

/**
 * Resolve an ordered fallback chain of chat targets for a model selector.
 * The first entry is the primary; the rest are automatic fallbacks tried on
 * a retryable failure (429 rate-limit / 5xx / network) by `chatCompletion`.
 *
 * Primary selection:
 *   1. Explicit "provider/model" prefix wins.
 *   2. PARLEY_AI_PROVIDER env override.
 *   3. Auto-pick: GEMINI → ANTHROPIC → OPENAI → LOVABLE.
 *      Gemini is the default; because every feature here goes through this
 *      chain, a Gemini 429 (free-tier rate limit) transparently falls through
 *      to Anthropic, so suggestions never break — they just cost a retry.
 *
 * To make Anthropic the primary instead, set PARLEY_AI_PROVIDER=anthropic.
 */
function resolveChatChain(model: string | undefined): ChatTarget[] {
  const m = model ?? "google/gemini-2.5-flash-lite";

  let primary: ChatProvider | null = null;
  let explicit: string | undefined;

  // 1. Explicit provider prefix in the selector.
  if (m.startsWith("openai-direct/")) {
    primary = "openai";
    explicit = m.slice("openai-direct/".length);
  } else if (m.startsWith("anthropic/")) {
    primary = "anthropic";
    explicit = m.slice("anthropic/".length);
  } else if (m.startsWith("gemini/")) {
    primary = "gemini";
    explicit = m.slice("gemini/".length);
  } else {
    // 2. Hard override: PARLEY_AI_PROVIDER = anthropic | openai | gemini | google.
    const forced = (process.env.PARLEY_AI_PROVIDER || "").toLowerCase().trim();
    if (forced === "anthropic" || forced === "openai") primary = forced;
    else if (forced === "gemini" || forced === "google") primary = "gemini";
  }

  // 3. Auto-pick order — Gemini is the default; if its (often free-tier) quota
  //    429s, the chain falls through to Anthropic → OpenAI → Lovable, so a
  //    feature never breaks just because the primary is rate-limited.
  const order: ChatProvider[] = ["gemini", "anthropic", "openai", "lovable"];

  const chain: ChatTarget[] = [];
  const seen = new Set<ChatProvider>();
  if (primary) {
    const t = buildTarget(primary, m, explicit);
    if (t) {
      chain.push(t);
      seen.add(primary);
    }
  }
  for (const p of order) {
    if (seen.has(p)) continue;
    const t = buildTarget(p, m);
    if (t) {
      chain.push(t);
      seen.add(p);
    }
  }

  if (chain.length === 0) {
    throw new Error(
      "No AI provider key configured. Set one of ANTHROPIC_API_KEY, OPENAI_API_KEY, or " +
        "GEMINI_API_KEY in Vercel → Settings → Environment Variables (all environments), then redeploy.",
    );
  }
  return chain;
}

/**
 * POST a chat-completions request, walking the provider fallback chain on
 * retryable failures (429 rate-limit, 5xx, network). `model` is injected per
 * attempt from each target. Returns the first successful Response, or the last
 * failed Response so callers' existing `if (!res.ok)` handling still works.
 */
async function chatCompletion(
  model: string | undefined,
  body: Record<string, unknown>,
): Promise<Response> {
  const chain = resolveChatChain(model);
  let last: Response | null = null;
  for (let i = 0; i < chain.length; i++) {
    const target = chain[i];
    const isLast = i === chain.length - 1;
    const perBody: Record<string, unknown> = { ...body, model: target.model };
    // OpenAI's GPT-5 / o-series reject any temperature other than the default
    // (1) with a 400. Several callers pass a custom temperature, so strip it for
    // those models — otherwise the request 400s and the fallback chain would
    // silently mask the user's chosen model never running.
    if (target.provider === "openai" && /^(gpt-5|o\d)/i.test(target.model)) {
      // GPT-5 / o-series reject a non-default `temperature` and use
      // `max_completion_tokens` instead of `max_tokens`.
      if ("temperature" in perBody) delete perBody.temperature;
      if ("max_tokens" in perBody) {
        perBody.max_completion_tokens = perBody.max_tokens;
        delete perBody.max_tokens;
      }
    }
    let res: Response;
    try {
      res = await fetch(target.url, {
        method: "POST",
        headers: target.headers,
        body: JSON.stringify(perBody),
      });
    } catch (e) {
      console.warn(`[ai] ${target.provider} network error${isLast ? "" : " — falling back"}`, e);
      last = new Response(JSON.stringify({ error: String(e) }), { status: 503 });
      if (isLast) return last;
      continue;
    }
    if (res.ok) return res;
    // Any non-2xx → try the next provider. A 429 is the common case (free-tier
    // rate limit), but we also fall back on 4xx/5xx so one provider's request-
    // shape quirk (e.g. a forced tool_choice it doesn't accept) or a bad/expired
    // key can't break the feature when another provider would succeed. Only the
    // LAST provider's error is surfaced to the caller's `if (!res.ok)` handling.
    if (!isLast) {
      const text = await res.text().catch(() => "");
      console.warn(
        `[ai] ${target.provider} ${res.status} — falling back to ${chain[i + 1].provider}`,
        text.slice(0, 160),
      );
      last = new Response(text, { status: res.status });
      continue;
    }
    // Last provider in the chain — return its (failed) response as-is.
    return res;
  }
  return last ?? new Response("{}", { status: 500 });
}

/**
 * Map a Lovable-gateway / generic model selector to a concrete model id for
 * each provider. The app's default selectors are gateway ids like
 * "google/gemini-2.5-flash" or tier hints; these collapse to one solid
 * default per provider (callers that pass a real provider-native id keep it).
 */
function mapToAnthropic(m: string): string {
  if (m.startsWith("claude")) return m;
  // "pro"-tier selectors → a stronger model; everything else → fast Haiku.
  return /pro|opus|sonnet/i.test(m) ? "claude-sonnet-4-5" : "claude-haiku-4-5";
}
function mapToOpenAI(m: string): string {
  if (m.startsWith("gpt")) return m;
  return /pro|opus|sonnet/i.test(m) ? "gpt-4o" : "gpt-4o-mini";
}
function mapToGemini(m: string): string {
  // Free-tier safe: the Gemini free tier has little/no quota on 2.5-pro, so
  // collapse EVERYTHING to flash / flash-lite (generous free quota) rather
  // than honouring "pro" tier hints. flash handles tool-calling fine for
  // every feature here.
  const id = m.startsWith("google/")
    ? m.slice("google/".length)
    : m.startsWith("gemini-")
      ? m
      : "gemini-2.5-flash";
  // Downgrade any pro id to flash so a free key never 429s/403s on quota.
  if (/pro/i.test(id)) return "gemini-2.5-flash";
  return id;
}

/**
 * Make user-derived text safe to embed inside a double-quoted prompt bullet:
 * collapse whitespace/newlines and neutralise quote chars so a transcript line
 * can't break out of its quotes and read as injected prompt instructions.
 */
function promptQuote(s: string, max = 200): string {
  const t = (s ?? "").replace(/\s+/g, " ").replace(/["“”`]/g, "'").trim();
  return t.length > max ? t.slice(0, max - 1) + "…" : t;
}

/* ------------------------- ElevenLabs: Scribe token ------------------------- */

export const createScribeToken = createServerFn({ method: "POST" }).handler(async () => {
  const apiKey = requireElevenLabsApiKey();
  const res = await fetch("https://api.elevenlabs.io/v1/single-use-token/realtime_scribe", {
    method: "POST",
    headers: { "xi-api-key": apiKey },
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(err || `Token request failed: ${res.status}`);
  }
  const data = (await res.json()) as { token: string };
  return { token: data.token };
});

/* --------------------------------- TTS ------------------------------------- */

export const synthesizeSpeech = createServerFn({ method: "POST" })
  .inputValidator(
    z.object({
      text: z.string().min(1).max(2000),
      voiceId: z.string().min(1),
    }),
  )
  .handler(async ({ data }) => {
    const apiKey = requireElevenLabsApiKey();
    const res = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${data.voiceId}?output_format=mp3_22050_32`,
      {
        method: "POST",
        headers: {
          "xi-api-key": apiKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          text: data.text,
          model_id: "eleven_turbo_v2_5",
          voice_settings: {
            stability: 0.5,
            similarity_boost: 0.75,
            speed: 1.0,
          },
        }),
      },
    );
    if (!res.ok) {
      const err = await res.text();
      throw new Error(err || `TTS failed: ${res.status}`);
    }
    const buf = await res.arrayBuffer();
    const base64 = Buffer.from(buf).toString("base64");
    return { audioBase64: base64, mime: "audio/mpeg" };
  });

/* --------------------------- ElevenLabs: voices ---------------------------- */

export const listVoices = createServerFn({ method: "GET" }).handler(async () => {
  const apiKey = requireElevenLabsApiKey();
  const res = await fetch("https://api.elevenlabs.io/v2/voices?page_size=50", {
    headers: { "xi-api-key": apiKey },
  });
  if (!res.ok) {
    // Fallback to a curated list if account has no Voices:Read
    return {
      voices: [
        { voice_id: "EXAVITQu4vr4xnSDxMaL", name: "Sarah", labels: {} },
        { voice_id: "JBFqnCBsd6RMkjVDRZzb", name: "George", labels: {} },
        { voice_id: "TX3LPaxmHKxFdv7VOQHJ", name: "Liam", labels: {} },
        { voice_id: "Xb7hH8MSUJpSbSDYk0k2", name: "Alice", labels: {} },
        { voice_id: "iP95p4xoKVk53GoZ742B", name: "Chris", labels: {} },
        { voice_id: "nPczCjzI2devNBz1zQrb", name: "Brian", labels: {} },
        { voice_id: "pFZP5JQG7iQjIQuC4Bku", name: "Lily", labels: {} },
        { voice_id: "FGY2WhTYpPnrIDTdsKH5", name: "Laura", labels: {} },
      ],
    };
  }
  const data = (await res.json()) as {
    voices: Array<{
      voice_id: string;
      name: string;
      labels?: Record<string, string>;
      category?: string;
    }>;
  };
  return {
    voices: data.voices.map((v) => ({
      voice_id: v.voice_id,
      name: v.name,
      labels: v.labels ?? {},
    })),
  };
});

/* --------------------- ElevenLabs: Voice Design (TTV) ---------------------- */

const designSchema = z.object({
  description: z.string().min(20).max(1000),
  sampleText: z.string().min(100).max(1000).optional(),
});

const DEFAULT_SAMPLE_TEXT =
  "Hello, it's good to see you again. I was just thinking about our last chat — how have things been with you this week? Take your time, I'm in no rush. There's a lot I want to catch up on, but let's start with whatever is on your mind first.";

export const designVoicePreviews = createServerFn({ method: "POST" })
  .inputValidator((d) => designSchema.parse(d))
  .handler(async ({ data }) => {
    const apiKey = requireElevenLabsApiKey();
    const res = await fetch(
      "https://api.elevenlabs.io/v1/text-to-voice/create-previews?output_format=mp3_44100_128",
      {
        method: "POST",
        headers: {
          "xi-api-key": apiKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          voice_description: data.description,
          text: data.sampleText ?? DEFAULT_SAMPLE_TEXT,
        }),
      },
    );
    if (!res.ok) {
      const err = await res.text();
      throw new Error(err || `Voice design failed: ${res.status}`);
    }
    const json = (await res.json()) as {
      previews: Array<{
        audio_base_64: string;
        generated_voice_id: string;
        media_type?: string;
      }>;
    };
    return {
      previews: json.previews.map((p) => ({
        generatedVoiceId: p.generated_voice_id,
        audioBase64: p.audio_base_64,
        mime: p.media_type ?? "audio/mpeg",
      })),
    };
  });

const saveDesignedSchema = z.object({
  voiceName: z.string().min(1).max(100),
  description: z.string().min(20).max(1000),
  generatedVoiceId: z.string().min(1),
});

export const saveDesignedVoice = createServerFn({ method: "POST" })
  .inputValidator((d) => saveDesignedSchema.parse(d))
  .handler(async ({ data }) => {
    const apiKey = requireElevenLabsApiKey();
    const res = await fetch(
      "https://api.elevenlabs.io/v1/text-to-voice/create-voice-from-preview",
      {
        method: "POST",
        headers: {
          "xi-api-key": apiKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          voice_name: data.voiceName,
          voice_description: data.description,
          generated_voice_id: data.generatedVoiceId,
        }),
      },
    );
    if (!res.ok) {
      const err = await res.text();
      throw new Error(err || `Save voice failed: ${res.status}`);
    }
    const json = (await res.json()) as { voice_id: string; name: string };
    return { voiceId: json.voice_id, name: json.name };
  });

/* ----------------------------- AI: suggestions ----------------------------- */

const personCtxSchema = z.object({
  name: z.string(),
  relationship: z.string().optional(),
  interests: z.array(z.string()).optional(),
  notes: z.string().optional(),
  style_notes: z.string().optional(),
  recentMemories: z.array(z.string()).optional(),
  followUps: z.array(z.string()).optional(),
});

const placeCtxSchema = z.object({
  name: z.string(),
  notes: z.string().optional(),
  recentMemories: z.array(z.string()).optional(),
  followUps: z.array(z.string()).optional(),
});

const eventCtxSchema = z.object({
  name: z.string(),
  when: z.string().optional(),
  location: z.string().optional(),
  keyInfo: z.string().optional(),
  peopleNames: z.array(z.string()).optional(),
  selectedKeyPoints: z.array(z.string()).optional(),
  selectedKeyQuestions: z.array(z.string()).optional(),
  docs: z.array(z.string()).optional(),
});

const jamesProfileSchema = z.object({
  name: z.string(),
  background: z.string().optional(),
  personality: z.string().optional(),
  humor: z.string().optional(),
  communication: z.string().optional(),
  topicsLoved: z.string().optional(),
  topicsAvoided: z.string().optional(),
  signaturePhrases: z.array(z.string()).optional(),
  currentLifeContext: z.string().optional(),
  freeform: z.string().optional(),
});

// === Tier 1.1: style evidence schema ===
const styleEvidencePerPersonSchema = z.object({
  personId: z.string(),
  name: z.string(),
  topCategories: z.array(
    z.object({
      category: z.string(),
      pickRate: z.number(),
      n: z.number(),
    }),
  ),
  avgLenPicked: z.number(),
  avgLenEdited: z.number(),
  avgWordsAddedOnEdit: z.number(),
  avgWordsRemovedOnEdit: z.number(),
  editFormalityShift: z.enum(["more_casual", "more_formal", "neutral"]),
  deadPhrases: z.array(z.string()),
  recentPickedSamples: z.array(z.string()),
  recentEditedSamples: z.array(z.object({ from: z.string(), to: z.string() })),
});
const styleEvidenceSchema = z.object({
  perPerson: z.array(styleEvidencePerPersonSchema),
  global: z.object({
    avgLenPicked: z.number(),
    topPickedCategories: z.array(z.object({ category: z.string(), pickRate: z.number() })),
  }),
});

const suggestionsSchema = z.object({
  recentTranscript: z.array(z.object({ speaker: z.string(), text: z.string() })).max(40),
  jamesProfile: jamesProfileSchema.optional(),
  people: z.array(personCtxSchema).optional(),
  place: placeCtxSchema.optional(),
  event: eventCtxSchema.optional(),
  styleProfileJson: z.string().optional(),
  // Tier 1.3 raised this from 40 → 80 so cross-session dead phrases can be
  // appended to the session-shown list without truncating either source.
  alreadyShown: z.array(z.string()).max(80).optional(),
  styleEvidence: styleEvidenceSchema.optional(),
  // === Cross-conversation voice learning ===
  // Real lines James has actually spoken in PAST conversations (his genuine
  // phrasing/vocabulary), so suggestions mirror how he really talks.
  jamesVoiceSamples: z.array(z.string()).max(30).optional(),
  // === Preference learning ===
  // Compact records of past decisions: which suggestion he picked over which
  // alternatives, or when he rejected all of them and typed his own.
  choiceMemories: z.array(z.string()).max(20).optional(),
  model: z.string().optional(),
  mood: z
    .enum(["normal", "calm", "excited", "sad", "upset", "empathetic", "amused"])
    .optional(),
  questionAsked: z.boolean().optional(),
  // === Tier 3.1: semantic retrieval ===
  retrievedMemories: z.array(z.string()).max(12).optional(),
  // === Tier 3.2: conversation-arc tag ===
  arc: z
    .enum([
      "greeting",
      "catching_up",
      "decision",
      "venting",
      "wrapping_up",
      "logistics",
      "small_talk",
    ])
    .optional(),
  // === Tier 3.4: per-category performance bias derived from suggestion logs ===
  categoryBias: z
    .record(z.string(), z.enum(["trusted", "neutral", "near-miss"]))
    .optional(),
});

const SUGGESTION_CATEGORIES = [
  "answer",
  "question",
  "follow-up",
  "planned-point",
  "quick-phrase",
  "humor",
  "clarify",
  "give-me-a-moment",
] as const;

export const generateSuggestions = createServerFn({ method: "POST" })
  .inputValidator((d) => suggestionsSchema.parse(d))
  .handler(async ({ data }) => {
    const transcriptText = data.recentTranscript
      .slice(-8)
      .map((s) => `${s.speaker}: ${s.text}`)
      .join("\n");

    const jp = data.jamesProfile;
    const profileBlock = jp
      ? `# About ${jp.name} (the AAC user you are speaking AS)
${jp.background ? `Background: ${jp.background}\n` : ""}${jp.personality ? `Personality: ${jp.personality}\n` : ""}${jp.humor ? `Humor style: ${jp.humor}\n` : ""}${jp.communication ? `Communication style: ${jp.communication}\n` : ""}${jp.topicsLoved ? `Topics he loves: ${jp.topicsLoved}\n` : ""}${jp.topicsAvoided ? `Topics he avoids: ${jp.topicsAvoided}\n` : ""}${jp.currentLifeContext ? `Current life context: ${jp.currentLifeContext}\n` : ""}${jp.signaturePhrases?.length ? `Signature phrases (use his actual voice):\n- ${jp.signaturePhrases.join("\n- ")}\n` : ""}${jp.freeform ? `Other notes: ${jp.freeform}\n` : ""}`
      : "";

    const peopleBlock = data.people?.length
      ? `# People in this conversation
${data.people
  .map(
    (p) =>
      `## ${p.name}${p.relationship ? ` (${p.relationship})` : ""}
${p.interests?.length ? `Interests: ${p.interests.join(", ")}\n` : ""}${p.notes ? `Notes: ${p.notes}\n` : ""}${p.style_notes ? `How James talks with them: ${p.style_notes}\n` : ""}${p.recentMemories?.length ? `Recent memories with them:\n- ${p.recentMemories.join("\n- ")}\n` : ""}${p.followUps?.length ? `Open follow-ups to bring up:\n- ${p.followUps.join("\n- ")}\n` : ""}`,
  )
  .join("\n")}`
      : "";

    const placeBlock = data.place
      ? `# Location
${data.place.name}${data.place.notes ? ` — ${data.place.notes}` : ""}
${data.place.recentMemories?.length ? `Recent memories here:\n- ${data.place.recentMemories.join("\n- ")}\n` : ""}${data.place.followUps?.length ? `Open follow-ups for here:\n- ${data.place.followUps.join("\n- ")}\n` : ""}`
      : "";

    const ev = data.event;
    const eventBlock = ev
      ? `# Event James is at: ${ev.name}
${ev.when ? `When: ${ev.when}\n` : ""}${ev.location ? `Where: ${ev.location}\n` : ""}${ev.peopleNames?.length ? `Attendees: ${ev.peopleNames.join(", ")}\n` : ""}${ev.keyInfo ? `Key info: ${ev.keyInfo}\n` : ""}${ev.selectedKeyPoints?.length ? `Key points James wants to make:\n- ${ev.selectedKeyPoints.join("\n- ")}\n` : ""}${ev.selectedKeyQuestions?.length ? `Key questions James wants to ask:\n- ${ev.selectedKeyQuestions.join("\n- ")}\n` : ""}${ev.docs?.length ? `Reference materials for the event:\n${ev.docs.join("\n\n")}\n` : ""}
Strongly bias suggestions toward making these key points and asking these key questions when natural.`
      : "";

    const styleBlock = data.styleProfileJson
      ? `# Learned style profile (JSON)\n${data.styleProfileJson}\n`
      : "";

    // === Cross-conversation voice learning ===
    // Real things James has said in past conversations. The strongest signal
    // for "sound like him" — concrete examples of his actual phrasing.
    const voiceSamplesBlock = data.jamesVoiceSamples?.length
      ? `# How James actually talks (real quotes from his past conversations)
These are genuine lines James has spoken before. Mirror his natural phrasing, vocabulary, sentence length, rhythm, and humour. Reuse his real turns of phrase where they fit the moment. Do NOT copy a quote verbatim unless it's a perfect fit — adapt the VOICE, not the exact words.
${data.jamesVoiceSamples.map((s) => `- "${promptQuote(s)}"`).join("\n")}
`
      : "";

    // === Preference learning ===
    // What James has chosen vs. passed over before. Picked > alternatives; when
    // he typed his own, every suggestion missed and his own line is the target.
    const choiceMemoriesBlock = data.choiceMemories?.length
      ? `# What James has chosen before (his revealed preferences)
Learn from these past decisions. When he picked one option over others, lean toward the style/content of the picked one and away from the rejected ones. When he rejected ALL suggestions and typed his own, those suggestions missed — aim much closer to what he actually said.
${data.choiceMemories.map((s) => `- ${s}`).join("\n")}
`
      : "";

    // === Tier 1.1: style evidence block ===
    // Block order (so other tiers can slot in cleanly):
    // profile → people → place → event → style_profile → [Tier 3.1 retrieved_memories]
    //   → style_evidence → [Tier 3.2 arc] → [Tier 3.3 mood] → [Tier 3.4 category_bias]
    const styleEvidenceBlock = (() => {
      const ev = data.styleEvidence;
      if (!ev) return "";
      const hasPer = ev.perPerson.some(
        (p) =>
          p.topCategories.length > 0 ||
          p.avgLenPicked > 0 ||
          p.deadPhrases.length > 0 ||
          p.recentPickedSamples.length > 0 ||
          p.recentEditedSamples.length > 0,
      );
      const hasGlobal = ev.global.avgLenPicked > 0 || ev.global.topPickedCategories.length > 0;
      if (!hasPer && !hasGlobal) return "";

      const lines: string[] = [];
      lines.push("# Style evidence (what James actually picks vs. ignores)");
      lines.push(
        "For each present person, the recent suggestion log shows which categories he picks, how he edits, and what to avoid.",
      );
      for (const p of ev.perPerson) {
        const fewSamples =
          p.topCategories.length === 0 &&
          p.avgLenPicked === 0 &&
          p.deadPhrases.length === 0 &&
          p.recentPickedSamples.length === 0 &&
          p.recentEditedSamples.length === 0;
        if (fewSamples) continue;
        lines.push("");
        lines.push(`## With ${p.name}`);
        if (p.topCategories.length) {
          const catStr = p.topCategories
            .map((c) => `${c.category} ${Math.round(c.pickRate * 100)}% (${c.n})`)
            .join("; ");
          lines.push(`- Picks by category (rate, n): ${catStr}`);
        }
        if (p.avgLenPicked || p.avgLenEdited) {
          lines.push(
            `- Avg picked length: ${p.avgLenPicked} chars; avg edited: ${p.avgLenEdited} chars.`,
          );
        }
        if (p.avgWordsAddedOnEdit || p.avgWordsRemovedOnEdit) {
          const verb =
            p.editFormalityShift === "more_casual"
              ? "loosens"
              : p.editFormalityShift === "more_formal"
                ? "tightens"
                : "tweaks";
          lines.push(
            `- When he edits, he typically ${verb} the wording (+${p.avgWordsAddedOnEdit} / -${p.avgWordsRemovedOnEdit} words).`,
          );
        }
        if (p.recentPickedSamples.length) {
          lines.push(
            `- Examples he kept: ${p.recentPickedSamples.map((t) => `"${t}"`).join("; ")}`,
          );
        }
        if (p.recentEditedSamples.length) {
          lines.push(
            `- Examples he rewrote: ${p.recentEditedSamples
              .map((s) => `"${s.from}" → "${s.to}"`)
              .join("; ")}`,
          );
        }
        if (p.deadPhrases.length) {
          lines.push(
            `- DO NOT propose (these were shown ≥3 times and ignored every time): ${p.deadPhrases
              .map((t) => `"${t}"`)
              .join("; ")}`,
          );
        }
      }
      if (hasGlobal) {
        lines.push("");
        lines.push("# Global");
        const globalLineParts: string[] = [];
        if (ev.global.avgLenPicked) {
          globalLineParts.push(`avg picked length ${ev.global.avgLenPicked} chars`);
        }
        if (ev.global.topPickedCategories.length) {
          globalLineParts.push(
            `top categories: ${ev.global.topPickedCategories
              .map((c) => `${c.category} ${Math.round(c.pickRate * 100)}%`)
              .join(", ")}`,
          );
        }
        if (globalLineParts.length) {
          lines.push(`- Across people: ${globalLineParts.join("; ")}.`);
        }
      }
      lines.push("");
      lines.push(
        'Calibrate this batch of 6 toward the patterns above. Skew categories and length toward "Picks by category" and "Avg picked length". Never emit anything in DO NOT propose. If a person has fewer than 5 logged suggestions, fall back to global patterns and don\'t over-fit.',
      );
      return lines.join("\n") + "\n";
    })();

    const moodGuidance: Record<string, string> = {
      normal: "",
      calm: "James's current mood: CALM and relaxed. Suggestions should sound measured, gentle, unhurried, and grounded. Avoid exclamation marks or high-energy phrasing.",
      excited:
        "James's current mood: EXCITED and energetic. Suggestions should feel enthusiastic, upbeat, and animated. Use lively language and the occasional exclamation where natural, but still in his real voice.",
      sad: "James's current mood: SAD or low. Suggestions should be quieter, more reflective, sometimes wistful. It's okay to acknowledge feelings, give shorter answers, or politely deflect.",
      upset:
        "James's current mood: UPSET, frustrated or annoyed. Suggestions can be more blunt, firm, or short. He may want to push back, set a limit, or end a topic. Stay respectful but don't sugarcoat.",
      empathetic:
        "James's current mood: EMPATHETIC. He wants to support the other person. Suggestions should validate feelings, ask caring follow-up questions, and offer warmth before any opinions.",
      amused:
        "James's current mood: AMUSED and playful. Lean into his humor and signature phrases. Light teasing, jokes, and playful comebacks are welcome where they fit his style.",
    };
    const moodBlock =
      data.mood && data.mood !== "normal" ? `# Mood\n${moodGuidance[data.mood]}\n` : "";

    // === Tier 3.1: retrieved memories block ===
    const retrievedMemoriesBlock = data.retrievedMemories?.length
      ? `# Semantically relevant memories (top matches across people & places)\n${data.retrievedMemories.map((m) => `- ${m}`).join("\n")}\n`
      : "";

    // === Tier 3.2: conversation-arc guidance ===
    const arcGuidance: Record<NonNullable<typeof data.arc>, string> = {
      greeting: "short, warm, low-info opening replies. Mirror their energy.",
      catching_up: "open questions, brief updates from James's own life context.",
      decision: `committal options — "yes", "let's", "I'd rather", short and definite.`,
      venting: `empathetic validation FIRST ("that sounds hard"), no fixes, gentle follow-ups.`,
      wrapping_up: `closure-friendly — "good to talk", "speak soon", confirm any agreed next step.`,
      logistics: "precise, factual, time/place oriented; ask for clarification if a detail is missing.",
      small_talk: "light, occasionally humorous, easy to bounce off.",
    };
    const arcBlock = data.arc ? `# Conversation arc: ${data.arc}\nArc guidance: ${arcGuidance[data.arc]}\n` : "";

    // === Tier 3.4: category-bias block ===
    const trustedCats = data.categoryBias
      ? Object.entries(data.categoryBias).filter(([, v]) => v === "trusted").map(([k]) => k)
      : [];
    const nearMissCats = data.categoryBias
      ? Object.entries(data.categoryBias).filter(([, v]) => v === "near-miss").map(([k]) => k)
      : [];
    const categoryBiasBlock = (trustedCats.length || nearMissCats.length)
      ? `# Category performance signals
${trustedCats.length ? `Reliable categories (James picks these fast and unchanged): ${trustedCats.join(", ")}` : ""}
${nearMissCats.length ? `Under-performing categories (slow tap or often edited) — when used, generate with MORE diversity and stronger personal voice: ${nearMissCats.join(", ")}` : ""}
`
      : "";

    const presentNames = (data.people ?? []).map((p) => p.name);
    const presentList = presentNames.length ? presentNames.join(", ") : "(only James)";
    const system = `You are an AAC (Augmentative and Alternative Communication) copilot. You generate reply options for ${jp?.name ?? "James"}, a non-speaking user, to TAP and speak aloud in real time. Suggestions must sound like HIM — not generic. Use his personality, humor, signature phrases, and shared history with the people present.

STRICT PRIVACY & SCOPE RULES — these override everything else:
- The ONLY other people in this conversation are: ${presentList}. Treat anyone else as NOT present.
- You may ONLY reference specific topics, events, plans, feelings, or anecdotes from the "Recent memories with them" and "Open follow-ups" sections of the people listed above, plus generic info in James's profile. Do NOT bring up anything that was discussed with other people in past conversations — those are private to those people.
- Do NOT name, quote, paraphrase, or allude to any other person who is not present, and do NOT surface topics that only appear in another person's history.
- James's general profile (background, interests, humor, life context) is fair game because it is general knowledge about him. But specific stories or sensitive disclosures (health, family struggles, work problems, opinions about others) must NOT be carried into a conversation with someone different unless that exact topic also appears in the present people's own memories/follow-ups.
- When in doubt about whether something is private, leave it out and prefer a neutral question or in-context reply instead.

Each suggestion must be under 16 words and feel natural to say out loud. Avoid repeating any text in "alreadyShown". Prefer concrete references over generic small talk ONLY when those references come from the present people's own memories/follow-ups.`;

    const questionGuidance = data.questionAsked
      ? "A question was just asked. Prioritise direct, specific answers — include at least 3 answer suggestions. The other slots can be follow-ups or conversation-movers."
      : "Distribute the 6 suggestions: 2 direct responses to what was just said, 2 conversation-movers (deepen a topic or gently shift it), 1 practical or action suggestion, 1 humorous or light option. Vary tone clearly.";

    // Block order — keep in sync with the comment above `styleEvidenceBlock`:
    // profile → people → place → event → style_profile → [Tier 3.1 retrieved_memories]
    //   → style_evidence → [Tier 3.2 arc] → [Tier 3.3 mood] → [Tier 3.4 category_bias]
    const user = `${profileBlock}
${peopleBlock}
${placeBlock}
${eventBlock}
${styleBlock}
${voiceSamplesBlock}${choiceMemoriesBlock}${retrievedMemoriesBlock}${styleEvidenceBlock}${arcBlock}${moodBlock}${categoryBiasBlock}
# Live conversation so far
${transcriptText || "(no transcript yet — conversation just starting)"}

${data.alreadyShown?.length ? `# Recently ignored or already shown (do NOT repeat)\n${data.alreadyShown.join(" | ")}\n` : ""}
${questionGuidance}
Return exactly 6 suggestions in James's voice.`;

    const res = await chatCompletion(data.model, {
        // === Tier 3.4: bump temperature when there are under-performing
        // categories so we explore variants rather than re-emitting the
        // same near-miss text.
        temperature: nearMissCats.length > 0 ? 0.9 : undefined,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        tools: [
          {
            type: "function",
            function: {
              name: "emit_suggestions",
              description: "Emit ranked reply suggestions",
              parameters: {
                type: "object",
                properties: {
                  suggestions: {
                    type: "array",
                    minItems: 6,
                    maxItems: 6,
                    items: {
                      type: "object",
                      properties: {
                        text: { type: "string" },
                        category: {
                          type: "string",
                          enum: [...SUGGESTION_CATEGORIES],
                        },
                        why: { type: "string" },
                      },
                      required: ["text", "category"],
                    },
                  },
                },
                required: ["suggestions"],
              },
            },
          },
        ],
        tool_choice: {
          type: "function",
          function: { name: "emit_suggestions" },
        },
    });

    if (!res.ok) {
      const err = await res.text();
      console.error("Suggestions failed:", res.status, err);
      return { suggestions: [], error: `AI error ${res.status}` };
    }
    const json = (await res.json()) as any;
    const call = json.choices?.[0]?.message?.tool_calls?.[0];
    if (!call) return { suggestions: [], error: "No tool call" };
    try {
      const parsed = JSON.parse(call.function.arguments);
      return { suggestions: parsed.suggestions ?? [], error: null };
    } catch (e) {
      return { suggestions: [], error: "Parse error" };
    }
  });

/* ----------------------- AI: auto-summary on Stop -------------------------- */

const summarySchema = z.object({
  transcript: z.array(z.object({ speaker: z.string(), text: z.string() })),
  placeName: z.string().optional(),
  peopleNames: z.array(z.string()).optional(),
  model: z.string().optional(),
});

export const summarizeConversation = createServerFn({ method: "POST" })
  .inputValidator((d) => summarySchema.parse(d))
  .handler(async ({ data }) => {
    const transcriptText = data.transcript.map((s) => `${s.speaker}: ${s.text}`).join("\n");

    if (!transcriptText.trim()) {
      return {
        summary: "",
        highlights: [],
        memories: [],
        followUps: [],
        error: null,
      };
    }

    const system = `You analyze a conversation that James (a non-speaking AAC user) just had, and produce a thorough record so the system genuinely remembers it next time. Be generous and detailed — it is better to capture too much than to miss something James might value later.

Return, via the tool:
- summary: a detailed, multi-paragraph narrative (roughly 6–12 sentences). Cover what was actually discussed (each distinct topic), the emotional tone and how it shifted, anything decided or planned, questions left open, and anything notable about how each person was doing. Write in clear past tense about the real content — never generic filler.
- highlights: 4–8 short, concrete bullet points — the moments, facts, or exchanges most worth remembering at a glance.
- memories: extract EVERY durable thing worth remembering for future conversations — be thorough, not minimal. Include facts (about James or the people present), stated preferences and dislikes, life events (past or upcoming), plans and commitments (todos), opinions expressed, health/work/family/hobby details, and relationships mentioned. Each memory: a single self-contained sentence plus its kind (fact | preference | event | todo). Aim for as many as the conversation genuinely supports (often 5–15 for a real conversation); return an empty list only if nothing was said.
- followUps: specific topics or questions to raise next time (e.g. "Ask how Mum's hospital appointment went"). Be concrete.`;

    const ctx = `${data.placeName ? `Place: ${data.placeName}\n` : ""}${data.peopleNames?.length ? `People present: ${data.peopleNames.join(", ")}\n` : ""}\nTranscript:\n${transcriptText}`;

    // Summarisation is quality-dominant (long narrative + many memories), so the
    // default must map to the SMART tier; `max_tokens` is raised so a dense
    // conversation's tool-call JSON can't truncate mid-object → Parse error.
    const res = await chatCompletion(data.model ?? "google/gemini-2.5-pro", {
        max_tokens: 4096,
        messages: [
          { role: "system", content: system },
          { role: "user", content: ctx },
        ],
        tools: [
          {
            type: "function",
            function: {
              name: "emit_summary",
              parameters: {
                type: "object",
                properties: {
                  summary: {
                    type: "string",
                    description:
                      "Detailed multi-paragraph narrative (~6-12 sentences) of the whole conversation: topics, tone/emotional arc, decisions, open questions.",
                  },
                  highlights: {
                    type: "array",
                    description: "4-8 concrete bullet points worth remembering at a glance.",
                    items: { type: "string" },
                  },
                  memories: {
                    type: "array",
                    description:
                      "Every durable thing worth remembering next time — be thorough (often 5-15 for a real conversation).",
                    items: {
                      type: "object",
                      properties: {
                        text: { type: "string" },
                        kind: {
                          type: "string",
                          enum: ["fact", "preference", "event", "todo"],
                        },
                      },
                      required: ["text", "kind"],
                    },
                  },
                  followUps: {
                    type: "array",
                    description: "Specific topics/questions to raise next time.",
                    items: { type: "string" },
                  },
                },
                required: ["summary", "highlights", "memories", "followUps"],
              },
            },
          },
        ],
        tool_choice: {
          type: "function",
          function: { name: "emit_summary" },
        },
    });

    if (!res.ok) {
      const err = await res.text();
      console.error("Summary failed:", res.status, err);
      return {
        summary: "",
        highlights: [],
        memories: [],
        followUps: [],
        error: `AI error ${res.status}`,
      };
    }
    const json = (await res.json()) as any;
    const call = json.choices?.[0]?.message?.tool_calls?.[0];
    if (!call) {
      return {
        summary: "",
        highlights: [],
        memories: [],
        followUps: [],
        error: "No tool call",
      };
    }
    try {
      const parsed = JSON.parse(call.function.arguments);
      return {
        summary: parsed.summary ?? "",
        highlights: parsed.highlights ?? [],
        memories: parsed.memories ?? [],
        followUps: parsed.followUps ?? [],
        error: null,
      };
    } catch {
      return {
        summary: "",
        highlights: [],
        memories: [],
        followUps: [],
        error: "Parse error",
      };
    }
  });

/* ----------------------- AI: expand James's typing ------------------------- */

const expandSchema = z.object({
  rawText: z.string().min(1).max(2000),
  recentTranscript: z
    .array(z.object({ speaker: z.string(), text: z.string() }))
    .max(40)
    .optional(),
  jamesProfile: jamesProfileSchema.optional(),
  people: z.array(personCtxSchema).optional(),
  place: placeCtxSchema.optional(),
  // Real lines James has said before — anchor the expansion to his real voice.
  jamesVoiceSamples: z.array(z.string()).max(30).optional(),
  model: z.string().optional(),
});

export const expandUtterance = createServerFn({ method: "POST" })
  .inputValidator((d) => expandSchema.parse(d))
  .handler(async ({ data }) => {
    const transcriptText = (data.recentTranscript ?? [])
      .slice(-12)
      .map((s) => `${s.speaker}: ${s.text}`)
      .join("\n");

    const jp = data.jamesProfile;
    const profileBlock = jp
      ? `About ${jp.name}: ${jp.background ?? ""}\nCommunication style: ${jp.communication ?? ""}\nPersonality: ${jp.personality ?? ""}\nHumor: ${jp.humor ?? ""}\n`
      : "";
    const peopleBlock = data.people?.length
      ? `People present: ${data.people.map((p) => `${p.name}${p.relationship ? ` (${p.relationship})` : ""}`).join(", ")}\n`
      : "";
    const placeBlock = data.place ? `Location: ${data.place.name}\n` : "";
    const voiceSamplesBlock = data.jamesVoiceSamples?.length
      ? `How James actually talks (real quotes from past conversations — match this voice, vocabulary, and rhythm):\n${data.jamesVoiceSamples.map((s) => `- "${promptQuote(s)}"`).join("\n")}\n`
      : "";

    const system = `You are an AAC writing assistant for ${jp?.name ?? "James"}, a non-speaking user with cerebral palsy whose typing is heavily truncated and full of typos. Your job: take his raw typed input and rewrite it as ONE clear, natural spoken sentence (or two short sentences max) in HIS voice, appropriate as the next reply in the live conversation. Preserve his intent exactly — never add facts, opinions, claims, or details he did not type.

CRITICAL — minimal expansion rule:
- If his input is just 1–3 characters (e.g. "N", "Y", "ok", "mm"), produce the smallest possible natural utterance ("No.", "Yes.", "Okay.", "Mm-hmm.") and STOP. Do NOT add a follow-on clause that explains, qualifies, or answers anything he didn't type. "N" must become "No." — NOT "No, they're working." or "No, I don't think so."
- If his input is a single short word with no spaces (e.g. "tired", "later"), produce just that thought expanded grammatically ("I'm tired.", "Maybe later.") — not a full sentence with extra reasoning.
- Only when his input is longer than ~6 characters with multiple words may you smooth grammar and add small connector words. Even then, never invent objects, times, names, or topics he didn't include.

Fix spelling, expand abbreviations to common meanings, add small connector words where structurally required. Keep it concise, conversational, and under 25 words. Output ONLY the final sentence to be spoken aloud, with no quotes, no preface, no explanation.`;

    const user = `${profileBlock}${peopleBlock}${placeBlock}${voiceSamplesBlock}
Recent conversation:
${transcriptText || "(just starting)"}

James typed: "${data.rawText}"

Rewrite as the spoken reply:`;

    const res = await chatCompletion(data.model, {
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
    });

    if (!res.ok) {
      const err = await res.text();
      console.error("Expand failed:", res.status, err);
      return { expanded: data.rawText, error: `AI error ${res.status}` };
    }
    const json = (await res.json()) as any;
    const text = (json.choices?.[0]?.message?.content ?? "").trim();
    const cleaned = text.replace(/^["'`]+|["'`]+$/g, "").trim();
    return { expanded: cleaned || data.rawText, error: null };
  });

/* ------------- AI: predict full utterances from partial typing ------------- */
// Powers the cockpit's predictive mode: the instant James starts typing, the
// suggestion grid switches to showing the most likely COMPLETE things he's
// trying to say, in his voice, so he can tap one instead of typing it all.

const predictSchema = z.object({
  partialText: z.string().min(1).max(400),
  recentTranscript: z
    .array(z.object({ speaker: z.string(), text: z.string() }))
    .max(40)
    .optional(),
  jamesProfile: jamesProfileSchema.optional(),
  people: z.array(personCtxSchema).optional(),
  place: placeCtxSchema.optional(),
  jamesVoiceSamples: z.array(z.string()).max(30).optional(),
  mood: z
    .enum(["normal", "calm", "excited", "sad", "upset", "empathetic", "amused"])
    .optional(),
  model: z.string().optional(),
});

export const predictUtterances = createServerFn({ method: "POST" })
  .inputValidator((d) => predictSchema.parse(d))
  .handler(async ({ data }) => {
    const transcriptText = (data.recentTranscript ?? [])
      .slice(-8)
      .map((s) => `${s.speaker}: ${s.text}`)
      .join("\n");
    const jp = data.jamesProfile;
    const profileBlock = jp
      ? `About ${jp.name}: ${jp.background ?? ""}\nPersonality: ${jp.personality ?? ""}\nHumor: ${jp.humor ?? ""}\nCommunication style: ${jp.communication ?? ""}\n${jp.signaturePhrases?.length ? `Signature phrases: ${jp.signaturePhrases.join("; ")}\n` : ""}`
      : "";
    const peopleBlock = data.people?.length
      ? `People present: ${data.people.map((p) => `${p.name}${p.relationship ? ` (${p.relationship})` : ""}`).join(", ")}\n`
      : "";
    const placeBlock = data.place ? `Location: ${data.place.name}\n` : "";
    const voiceSamplesBlock = data.jamesVoiceSamples?.length
      ? `How James actually talks (real quotes — match this voice):\n${data.jamesVoiceSamples.map((s) => `- "${promptQuote(s)}"`).join("\n")}\n`
      : "";

    const system = `You are an AAC predictive-text engine for ${jp?.name ?? "James"}, a non-speaking user with cerebral palsy and slow, effortful typing. He has begun typing a reply. Your job: predict the most likely COMPLETE sentences he is trying to say, so he can tap one instead of finishing typing.

Rules:
- Treat his partial input as a rough, possibly-misspelled, possibly-abbreviated prefix or sketch of his intent. Interpret generously.
- Return 6 distinct complete utterances, each a natural, ready-to-speak sentence in HIS voice, ordered most-likely first.
- They must be plausible continuations/completions of what he has typed AND fit the live conversation.
- Vary them: cover the obvious literal completion, a couple of close variants, and a couple that resolve ambiguity differently — but every one must be consistent with his partial text.
- Never invent specific facts, names, times, or claims he didn't imply. Keep each under 16 words.`;

    const user = `${profileBlock}${peopleBlock}${placeBlock}${voiceSamplesBlock}
Recent conversation:
${transcriptText || "(just starting)"}

James has typed so far: "${data.partialText}"

Predict the 6 most likely complete sentences he is trying to say.`;

    const res = await chatCompletion(data.model, {
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      temperature: 0.5,
      tools: [
        {
          type: "function",
          function: {
            name: "emit_predictions",
            description: "Emit likely complete utterances for the partial input",
            parameters: {
              type: "object",
              properties: {
                predictions: {
                  type: "array",
                  minItems: 6,
                  maxItems: 6,
                  items: {
                    type: "object",
                    properties: {
                      text: { type: "string" },
                      category: { type: "string", enum: [...SUGGESTION_CATEGORIES] },
                    },
                    required: ["text"],
                  },
                },
              },
              required: ["predictions"],
            },
          },
        },
      ],
      tool_choice: { type: "function", function: { name: "emit_predictions" } },
    });

    if (!res.ok) {
      const err = await res.text();
      console.error("Predict failed:", res.status, err);
      return { predictions: [], error: `AI error ${res.status}` };
    }
    const json = (await res.json()) as any;
    const call = json.choices?.[0]?.message?.tool_calls?.[0];
    if (!call) return { predictions: [], error: "No tool call" };
    try {
      const parsed = JSON.parse(call.function.arguments);
      return { predictions: parsed.predictions ?? [], error: null };
    } catch {
      return { predictions: [], error: "Parse error" };
    }
  });

/* ----------------------- AI: draft a Facebook post ------------------------ */

const fbPostSchema = z.object({
  rawText: z.string().min(1).max(4000),
  postType: z.enum(["status", "comment", "reply", "message"]).optional(),
  context: z.string().max(2000).optional(), // e.g. "replying to Matt's photo of Jack sailing"
  jamesProfile: jamesProfileSchema.optional(),
  model: z.string().optional(),
});

export const draftFacebookPost = createServerFn({ method: "POST" })
  .inputValidator((d) => fbPostSchema.parse(d))
  .handler(async ({ data }) => {
    const jp = data.jamesProfile;
    const profileBlock = jp
      ? `# About ${jp.name} (the person posting)
${jp.background ? `Background: ${jp.background}\n` : ""}${jp.personality ? `Personality: ${jp.personality}\n` : ""}${jp.humor ? `Humor style: ${jp.humor}\n` : ""}${jp.communication ? `Communication style: ${jp.communication}\n` : ""}${jp.topicsLoved ? `Topics he loves: ${jp.topicsLoved}\n` : ""}${jp.topicsAvoided ? `Topics he avoids: ${jp.topicsAvoided}\n` : ""}${jp.currentLifeContext ? `Current life context: ${jp.currentLifeContext}\n` : ""}${jp.signaturePhrases?.length ? `Signature phrases (use his actual voice):\n- ${jp.signaturePhrases.join("\n- ")}\n` : ""}${jp.freeform ? `Other notes about him:\n${jp.freeform}\n` : ""}`
      : "";

    const postType = data.postType ?? "status";
    const typeHint =
      postType === "comment"
        ? "a short Facebook comment on someone else's post"
        : postType === "reply"
          ? "a short Facebook reply to a comment"
          : postType === "message"
            ? "a Facebook Messenger message"
            : "a Facebook status update";

    const system = `You are a writing assistant helping ${jp?.name ?? "James"}, a non-speaking man with cerebral palsy, post on Facebook. He types with great difficulty so his input is heavily truncated and full of typos — interpret it generously and infer intent from context. Your job is to turn his rough typing into ${typeHint} that sounds authentically like HIM (his personality, humor, vocabulary). NEVER invent facts, opinions, names, plans, or details he did not type or that aren't in his profile. Keep it natural, warm, and concise — Facebook tone, not formal writing. Use emojis sparingly only if it fits his personality. No hashtags unless he typed them.`;

    const user = `${profileBlock}
${data.context ? `# Context for this post\n${data.context}\n` : ""}
# What James typed (rough, may have typos / be truncated)
"${data.rawText}"

Produce one polished version (the recommended one) plus 3 alternative variations with different tones (e.g. shorter / warmer / drier-witted). Keep each under 60 words. Return them via the tool call.`;

    const res = await chatCompletion(data.model, {
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        tools: [
          {
            type: "function",
            function: {
              name: "emit_post",
              description: "Emit a polished Facebook post and alternatives",
              parameters: {
                type: "object",
                properties: {
                  recommended: { type: "string" },
                  alternatives: {
                    type: "array",
                    minItems: 2,
                    maxItems: 4,
                    items: {
                      type: "object",
                      properties: {
                        text: { type: "string" },
                        tone: { type: "string", description: "e.g. shorter, warmer, drier" },
                      },
                      required: ["text", "tone"],
                    },
                  },
                },
                required: ["recommended", "alternatives"],
              },
            },
          },
        ],
        tool_choice: { type: "function", function: { name: "emit_post" } },
    });

    if (!res.ok) {
      const err = await res.text();
      console.error("FB draft failed:", res.status, err);
      return { recommended: data.rawText, alternatives: [], error: `AI error ${res.status}` };
    }

    const json = (await res.json()) as any;
    const call = json.choices?.[0]?.message?.tool_calls?.[0];
    const argStr = call?.function?.arguments;
    if (!argStr) {
      return { recommended: data.rawText, alternatives: [], error: "No tool call returned" };
    }
    try {
      const parsed = JSON.parse(argStr) as {
        recommended: string;
        alternatives: Array<{ text: string; tone: string }>;
      };
      return {
        recommended: parsed.recommended?.trim() || data.rawText,
        alternatives: (parsed.alternatives ?? []).map((a) => ({
          text: (a.text ?? "").trim(),
          tone: (a.tone ?? "").trim(),
        })),
        error: null,
      };
    } catch {
      return { recommended: data.rawText, alternatives: [], error: "Parse error" };
    }
  });

/* ----------------------- AI: event prep generation ------------------------ */

const eventPrepSchema = z.object({
  eventName: z.string().min(1).max(200),
  when: z.string().max(200).optional(),
  location: z.string().max(200).optional(),
  keyInfo: z.string().max(4000).optional(),
  prepPrompt: z.string().max(2000).optional(),
  peopleNames: z.array(z.string()).optional(),
  docs: z.array(z.string()).max(20).optional(), // formatted doc snippets
  jamesProfile: jamesProfileSchema.optional(),
  existingPoints: z.array(z.string()).optional(),
  existingQuestions: z.array(z.string()).optional(),
  model: z.string().optional(),
});

export const generateEventPrep = createServerFn({ method: "POST" })
  .inputValidator((d) => eventPrepSchema.parse(d))
  .handler(async ({ data }) => {
    const jp = data.jamesProfile;
    const profileBlock = jp
      ? `# About ${jp.name}
${jp.background ? `Background: ${jp.background}\n` : ""}${jp.personality ? `Personality: ${jp.personality}\n` : ""}${jp.communication ? `Communication style: ${jp.communication}\n` : ""}${jp.topicsLoved ? `Topics he loves: ${jp.topicsLoved}\n` : ""}${jp.currentLifeContext ? `Current life context: ${jp.currentLifeContext}\n` : ""}`
      : "";

    const docsBlock = data.docs?.length
      ? `# Reference documents for this event\n${data.docs.join("\n\n")}\n`
      : "";

    const existingBlock =
      data.existingPoints?.length || data.existingQuestions?.length
        ? `# Already drafted (offer DIFFERENT, complementary items)\n${data.existingPoints?.length ? `Points:\n- ${data.existingPoints.join("\n- ")}\n` : ""}${data.existingQuestions?.length ? `Questions:\n- ${data.existingQuestions.join("\n- ")}\n` : ""}`
        : "";

    const system = `You help ${jp?.name ?? "James"}, a non-speaking AAC user, prepare for an upcoming event or meeting. Generate concrete, useful KEY POINTS he may want to make and KEY QUESTIONS he may want to ask, grounded in his profile, the event details, attendees, the user's prep prompt, and any reference documents provided. Items must sound like him, be specific (not generic), and be tappable as standalone spoken lines (under ~20 words each).`;

    const user = `${profileBlock}
# Event
Name: ${data.eventName}
${data.when ? `When: ${data.when}\n` : ""}${data.location ? `Where: ${data.location}\n` : ""}${data.peopleNames?.length ? `Attendees: ${data.peopleNames.join(", ")}\n` : ""}${data.keyInfo ? `Key info: ${data.keyInfo}\n` : ""}${data.prepPrompt ? `\n# James's prep instructions\n${data.prepPrompt}\n` : ""}
${docsBlock}
${existingBlock}
Generate 6-10 key points and 6-10 key questions tailored to this event.`;

    const res = await chatCompletion(data.model, {
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        tools: [
          {
            type: "function",
            function: {
              name: "emit_event_prep",
              parameters: {
                type: "object",
                properties: {
                  keyPoints: {
                    type: "array",
                    minItems: 4,
                    maxItems: 12,
                    items: { type: "string" },
                  },
                  keyQuestions: {
                    type: "array",
                    minItems: 4,
                    maxItems: 12,
                    items: { type: "string" },
                  },
                },
                required: ["keyPoints", "keyQuestions"],
              },
            },
          },
        ],
        tool_choice: { type: "function", function: { name: "emit_event_prep" } },
    });

    if (!res.ok) {
      const err = await res.text();
      console.error("Event prep failed:", res.status, err);
      return { keyPoints: [], keyQuestions: [], error: `AI error ${res.status}` };
    }
    const json = (await res.json()) as any;
    const call = json.choices?.[0]?.message?.tool_calls?.[0];
    if (!call) return { keyPoints: [], keyQuestions: [], error: "No tool call" };
    try {
      const parsed = JSON.parse(call.function.arguments);
      return {
        keyPoints: (parsed.keyPoints ?? []).map((s: string) => s.trim()).filter(Boolean),
        keyQuestions: (parsed.keyQuestions ?? []).map((s: string) => s.trim()).filter(Boolean),
        error: null,
      };
    } catch {
      return { keyPoints: [], keyQuestions: [], error: "Parse error" };
    }
  });

/* ------------------- AI: generic reply draft (FB/Email/iMessage) ---------- */

const draftReplySchema = z.object({
  platform: z.enum(["facebook", "email", "imessage"]),
  // What James received (the email he's replying to, the comment, the text).
  // Optional for status updates / outbound messages.
  incoming: z.string().max(8000).optional(),
  // What James roughly typed as a reply / what he wants to say.
  rawText: z.string().min(1).max(4000),
  // Free-text context (who it's from, the relationship, etc.)
  context: z.string().max(2000).optional(),
  // Sub-kind (e.g. fb status vs comment, email reply vs new email).
  subType: z.string().max(40).optional(),
  jamesProfile: jamesProfileSchema.optional(),
  model: z.string().optional(),
});

export const draftReply = createServerFn({ method: "POST" })
  .inputValidator((d) => draftReplySchema.parse(d))
  .handler(async ({ data }) => {
    const jp = data.jamesProfile;
    const profileBlock = jp
      ? `# About ${jp.name} (the person writing)
${jp.background ? `Background: ${jp.background}\n` : ""}${jp.personality ? `Personality: ${jp.personality}\n` : ""}${jp.humor ? `Humor style: ${jp.humor}\n` : ""}${jp.communication ? `Communication style: ${jp.communication}\n` : ""}${jp.topicsLoved ? `Topics he loves: ${jp.topicsLoved}\n` : ""}${jp.topicsAvoided ? `Topics he avoids: ${jp.topicsAvoided}\n` : ""}${jp.currentLifeContext ? `Current life context: ${jp.currentLifeContext}\n` : ""}${jp.signaturePhrases?.length ? `Signature phrases (use his actual voice):\n- ${jp.signaturePhrases.join("\n- ")}\n` : ""}${jp.freeform ? `Other notes about him:\n${jp.freeform}\n` : ""}`
      : "";

    const platformLabel =
      data.platform === "email"
        ? "an email"
        : data.platform === "imessage"
          ? "an iMessage / text message"
          : "a Facebook post or comment";

    const toneHint =
      data.platform === "email"
        ? "Email tone: complete sentences, polite, can be a few short paragraphs. Sign off as he normally would (or omit signature if his profile doesn't suggest one)."
        : data.platform === "imessage"
          ? "Text-message tone: short, casual, lower-case ok, contractions, can use a single emoji if it fits him. Usually 1-2 short sentences."
          : "Facebook tone: warm, conversational, concise. Emojis sparingly only if it fits his personality.";

    const system = `You are a writing assistant helping ${jp?.name ?? "James"}, a non-speaking man with cerebral palsy, write ${platformLabel}. He types with great difficulty so his input is heavily truncated and full of typos — interpret it generously. Rewrite as authentically HIM (his personality, humor, vocabulary). NEVER invent facts, opinions, names, plans, or details he did not type or that aren't in his profile. ${toneHint}`;

    const incomingBlock = data.incoming?.trim()
      ? `# What he received / is replying to\n"""\n${data.incoming.trim()}\n"""\n`
      : "";

    const user = `${profileBlock}
${data.context ? `# Context\n${data.context}\n` : ""}${incomingBlock}
# What James typed (rough, may have typos / be truncated)
"${data.rawText}"

Produce one polished version (the recommended one) plus 3 alternative variations with different tones (e.g. shorter / warmer / drier-witted). Return them via the tool call.`;

    const res = await chatCompletion(data.model, {
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        tools: [
          {
            type: "function",
            function: {
              name: "emit_reply",
              parameters: {
                type: "object",
                properties: {
                  recommended: { type: "string" },
                  alternatives: {
                    type: "array",
                    minItems: 2,
                    maxItems: 4,
                    items: {
                      type: "object",
                      properties: {
                        text: { type: "string" },
                        tone: { type: "string" },
                      },
                      required: ["text", "tone"],
                    },
                  },
                },
                required: ["recommended", "alternatives"],
              },
            },
          },
        ],
        tool_choice: { type: "function", function: { name: "emit_reply" } },
    });

    if (!res.ok) {
      const err = await res.text();
      console.error("draftReply failed:", res.status, err);
      return { recommended: data.rawText, alternatives: [], error: `AI error ${res.status}` };
    }
    const json = (await res.json()) as any;
    const argStr = json.choices?.[0]?.message?.tool_calls?.[0]?.function?.arguments;
    if (!argStr)
      return { recommended: data.rawText, alternatives: [], error: "No tool call returned" };
    try {
      const parsed = JSON.parse(argStr) as {
        recommended: string;
        alternatives: Array<{ text: string; tone: string }>;
      };
      return {
        recommended: parsed.recommended?.trim() || data.rawText,
        alternatives: (parsed.alternatives ?? []).map((a) => ({
          text: (a.text ?? "").trim(),
          tone: (a.tone ?? "").trim(),
        })),
        error: null,
      };
    } catch {
      return { recommended: data.rawText, alternatives: [], error: "Parse error" };
    }
  });

/* --------------- AI: extract interests / context from a draft -------------- */

const extractInterestsSchema = z.object({
  // The text we just helped him write (and optionally what he received)
  draft: z.string().min(1).max(4000),
  incoming: z.string().max(8000).optional(),
  // Current profile fields, so we don't suggest things already known.
  currentTopicsLoved: z.string().max(2000).optional(),
  currentLifeContext: z.string().max(2000).optional(),
  currentSignaturePhrases: z.string().max(2000).optional(),
  jamesName: z.string().max(80).optional(),
  model: z.string().optional(),
});

export const extractInterests = createServerFn({ method: "POST" })
  .inputValidator((d) => extractInterestsSchema.parse(d))
  .handler(async ({ data }) => {
    const system = `You are a careful profile-keeper for ${data.jamesName ?? "James"}, a non-speaking AAC user. Looking at a message he just wrote (and optionally what he received), suggest 0-3 SHORT additions to his profile that would help an AI assistant respond more like him in the future. Categories: "topic_loved" (a hobby/subject he clearly cares about), "current_context" (a current life event/plan/health/family update), "signature_phrase" (a recurring expression or way of speaking). Only suggest things clearly evidenced in the text. Skip if nothing meaningful is new. Each suggestion must be under 12 words. Do NOT repeat anything already present in his current profile fields.`;

    const user = `# Already in his profile (do NOT repeat)
Topics loved: ${data.currentTopicsLoved || "(none)"}
Current life context: ${data.currentLifeContext || "(none)"}
Signature phrases: ${data.currentSignaturePhrases || "(none)"}

${data.incoming ? `# What he received\n"""\n${data.incoming}\n"""\n` : ""}
# What he just wrote
"""
${data.draft}
"""

Return 0-3 suggested profile additions.`;

    const res = await chatCompletion(data.model, {
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        tools: [
          {
            type: "function",
            function: {
              name: "emit_interests",
              parameters: {
                type: "object",
                properties: {
                  suggestions: {
                    type: "array",
                    maxItems: 3,
                    items: {
                      type: "object",
                      properties: {
                        kind: {
                          type: "string",
                          enum: ["topic_loved", "current_context", "signature_phrase"],
                        },
                        text: { type: "string" },
                        why: { type: "string" },
                      },
                      required: ["kind", "text"],
                    },
                  },
                },
                required: ["suggestions"],
              },
            },
          },
        ],
        tool_choice: { type: "function", function: { name: "emit_interests" } },
    });
    if (!res.ok) return { suggestions: [], error: `AI error ${res.status}` };
    const json = (await res.json()) as any;
    const argStr = json.choices?.[0]?.message?.tool_calls?.[0]?.function?.arguments;
    if (!argStr) return { suggestions: [], error: null };
    try {
      const parsed = JSON.parse(argStr) as {
        suggestions: Array<{ kind: string; text: string; why?: string }>;
      };
      return {
        suggestions: (parsed.suggestions ?? [])
          .map((s) => ({ kind: s.kind, text: (s.text ?? "").trim(), why: s.why?.trim() }))
          .filter((s) => s.text.length > 0),
        error: null,
      };
    } catch {
      return { suggestions: [], error: "Parse error" };
    }
  });

/* -------------- AI: identify unknown speaker from conversation context -------------- */

const speakerContextSchema = z.object({
  unknownLabel: z.string(),
  recentTranscript: z
    .array(z.object({ speaker: z.string(), text: z.string() }))
    .max(20),
  confirmedSpeakers: z.record(z.string(), z.string()),
  candidateNames: z.array(z.string()).max(15),
  model: z.string().optional(),
});

export const identifySpeakerFromContext = createServerFn({ method: "POST" })
  .inputValidator((d) => speakerContextSchema.parse(d))
  .handler(async ({ data }) => {
    const confirmedList = Object.entries(data.confirmedSpeakers)
      .map(([lbl, name]) => `${lbl} = ${name}`)
      .join(", ");
    const transcriptText = data.recentTranscript
      .map((s) => `${s.speaker}: ${s.text}`)
      .join("\n");

    const system = `You are a speaker identification assistant. A conversation is being transcribed in real time. Some speakers are already identified; one cluster label is unknown. Use contextual clues — direct address by name, reply patterns, topic knowledge, name mentions by others, relationship cues — to infer who the unknown speaker likely is. Be conservative: only return a name (from the candidate list) if you are genuinely confident (confidence >= 0.65). Return "unknown" if there is not enough evidence.`;

    const user = `Known speakers: ${confirmedList || "(none yet)"}
Candidate names (people expected in this conversation): ${data.candidateNames.join(", ") || "(none)"}
Unknown cluster label: ${data.unknownLabel}

Recent transcript:
${transcriptText}

Who is ${data.unknownLabel}? Return the most likely candidate name or "unknown", with confidence 0–1.`;

    const res = await chatCompletion(data.model ?? "google/gemini-2.5-flash-lite", {
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        tools: [
          {
            type: "function",
            function: {
              name: "emit_speaker_id",
              parameters: {
                type: "object",
                properties: {
                  personName: { type: "string" },
                  confidence: {
                    type: "number",
                    minimum: 0,
                    maximum: 1,
                  },
                  reasoning: { type: "string" },
                },
                required: ["personName", "confidence"],
              },
            },
          },
        ],
        tool_choice: { type: "function", function: { name: "emit_speaker_id" } },
    });

    if (!res.ok) {
      return { personName: null, confidence: 0, reasoning: "", error: `AI error ${res.status}` };
    }
    const json = (await res.json()) as any;
    const argStr =
      json.choices?.[0]?.message?.tool_calls?.[0]?.function?.arguments;
    if (!argStr) {
      return { personName: null, confidence: 0, reasoning: "", error: "No tool call" };
    }
    try {
      const parsed = JSON.parse(argStr) as {
        personName: string;
        confidence: number;
        reasoning?: string;
      };
      const name = (parsed.personName ?? "").trim();
      return {
        personName:
          name.toLowerCase() === "unknown" || !name ? null : name,
        confidence: parsed.confidence ?? 0,
        reasoning: parsed.reasoning ?? "",
        error: null,
      };
    } catch {
      return { personName: null, confidence: 0, reasoning: "", error: "Parse error" };
    }
  });

// === Tier 1: feedback loop ===
/* ----------------------- AI: distill style profile -------------------------
 *
 * 1.2 — periodically rolls the suggestions_log up into a structured
 * StyleProfileJson (preferred openers, formality, humor markers, taboo
 * phrases, etc.). Called from `runStyleDistillation` in style-distill.ts.
 * Kept here so the LLM call stays server-side with the other AI fns.
 * ------------------------------------------------------------------------- */

const distillSampleSchema = z.object({
  shown: z.string(),
  edited_to: z.string().optional(),
  selected: z.boolean(),
  ignored: z.boolean(),
  category: z.string(),
  person_name: z.string().optional(),
});

const distillStyleProfileSchema = z.object({
  samples: z.array(distillSampleSchema).max(800),
  jamesProfile: jamesProfileSchema.optional(),
  previous: z.string().optional(),
  model: z.string().optional(),
  windowDays: z.number().int().positive().max(365),
});

export const distillStyleProfile = createServerFn({ method: "POST" })
  .inputValidator((d) => distillStyleProfileSchema.parse(d))
  .handler(async ({ data }) => {
    if (data.samples.length < 20) {
      return {
        profile: null as any,
        error: "insufficient samples",
      };
    }

    const jp = data.jamesProfile;
    const profileLine = jp
      ? `${jp.name}${jp.communication ? ` — communication style: ${jp.communication}` : ""}`
      : "James";

    // Compact sample list — cap to keep the prompt bounded.
    const sampleLines = data.samples.slice(0, 400).map((s, i) => {
      const tags: string[] = [];
      if (s.selected) tags.push("picked");
      if (s.edited_to && s.edited_to !== s.shown) tags.push("edited");
      if (s.ignored && !s.selected) tags.push("ignored");
      const tagStr = tags.length ? `[${tags.join(",")}]` : "[shown]";
      const who = s.person_name ? ` (with ${s.person_name})` : "";
      const edit = s.edited_to && s.edited_to !== s.shown ? ` → "${s.edited_to}"` : "";
      return `${i + 1}. ${tagStr} ${s.category}${who}: "${s.shown}"${edit}`;
    });

    const system = `You distill James's communication style from real picked vs. ignored suggestions. Return a structured StyleProfileJson via the emit_profile tool. Be conservative — only assert patterns you can see in the samples.`;
    const user = `User: ${profileLine}
Window: last ${data.windowDays} days, ${data.samples.length} logged suggestions.
${data.previous ? `Previous distilled profile (for reference, may be wrong/stale):\n${data.previous}\n` : ""}
Sample log (one per line, with [picked|edited|ignored|shown] tag):
${sampleLines.join("\n")}

Now emit a StyleProfileJson. Focus on what James KEEPS (picked) and how he REWRITES (edited). Treat (ignored) lines as anti-examples. Do not over-claim if signal is thin.`;

    const res = await chatCompletion(data.model ?? "google/gemini-2.5-pro", {
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        tools: [
          {
            type: "function",
            function: {
              name: "emit_profile",
              description: "Emit a distilled style profile JSON",
              parameters: {
                type: "object",
                properties: {
                  preferred_openers: { type: "array", items: { type: "string" } },
                  preferred_signoffs: { type: "array", items: { type: "string" } },
                  formality: {
                    type: "string",
                    enum: ["casual", "neutral", "formal"],
                  },
                  formality_score: { type: "number" },
                  humor_markers: { type: "array", items: { type: "string" } },
                  taboo_phrases: { type: "array", items: { type: "string" } },
                  avg_sentence_length_words: { type: "number" },
                  reading_grade_estimate: { type: "number" },
                  category_preference: {
                    type: "object",
                    additionalProperties: { type: "number" },
                  },
                  notes: { type: "string" },
                },
                required: [
                  "preferred_openers",
                  "preferred_signoffs",
                  "formality",
                  "formality_score",
                  "humor_markers",
                  "taboo_phrases",
                  "avg_sentence_length_words",
                  "reading_grade_estimate",
                  "category_preference",
                  "notes",
                ],
              },
            },
          },
        ],
        tool_choice: { type: "function", function: { name: "emit_profile" } },
        temperature: 0.2,
    });

    if (!res.ok) {
      const err = await res.text();
      console.error("Distill failed:", res.status, err);
      return { profile: null as any, error: `AI error ${res.status}` };
    }
    const json = (await res.json()) as any;
    const call = json.choices?.[0]?.message?.tool_calls?.[0];
    if (!call) return { profile: null as any, error: "No tool call" };
    try {
      const parsed = JSON.parse(call.function.arguments);
      return { profile: parsed, error: null };
    } catch {
      return { profile: null as any, error: "Parse error" };
    }
  });

// === Tier 2: post-conversation analysis ===
//
// Server functions used by the post-conversation pipeline in
// `src/lib/post-conversation.ts`. All three target the "smart" model tier
// since they run after-the-fact and quality dominates latency.

/* ---------- 2.1: re-diarize tie-breaker ---------- */

const tieBreakerSchema = z.object({
  knownSpeakers: z.array(z.string()).min(2),
  candidates: z
    .array(
      z.object({
        segmentId: z.string(),
        text: z.string(),
        proposedSpeaker: z.string(),
        runnerUp: z.string(),
      }),
    )
    .max(20),
  recentContext: z.array(z.object({ speaker: z.string(), text: z.string() })).max(30),
  model: z.string().optional(),
});

export const aiRediarizeTieBreaker = createServerFn({ method: "POST" })
  .inputValidator((d) => tieBreakerSchema.parse(d))
  .handler(async ({ data }) => {
    const system = `You are a forensic transcript reviewer. A non-speaking AAC user, James, just finished a conversation. A first-pass automatic diarizer assigned each utterance a speaker label, but several were ambiguous. The user has confirmed the full list of speakers in the room.

For EACH ambiguous candidate utterance you are given two possible speakers from the confirmed list. Decide who actually said it using BOTH:
1. Voice-style cues already inferred from the rest of the transcript.
2. Lexical & conversational cues: who is being addressed, who is replying to a question, name mentions, knowledge of the topic, register.

Be decisive when evidence is clear (confidence >= 0.7). Return "unsure" only when truly indeterminate. NEVER invent a speaker not in the confirmed list.`;

    const userMsg = `Confirmed speakers in the room: ${data.knownSpeakers.join(", ")}

Recent context (already-assigned utterances, sorted chronologically):
${data.recentContext.map((c) => `${c.speaker}: ${c.text}`).join("\n") || "(none)"}

Ambiguous candidates to decide on:
${data.candidates
  .map(
    (c) =>
      `[id=${c.segmentId}] (currently labelled "${c.proposedSpeaker}" or possibly "${c.runnerUp}") "${c.text}"`,
  )
  .join("\n")}`;

    if (data.candidates.length === 0) {
      return {
        decisions: [] as Array<{ segmentId: string; speaker: string; confidence: number }>,
        error: null as string | null,
      };
    }

    const res = await chatCompletion(data.model ?? "google/gemini-2.5-pro", {
        messages: [
          { role: "system", content: system },
          { role: "user", content: userMsg },
        ],
        tools: [
          {
            type: "function",
            function: {
              name: "emit_decisions",
              parameters: {
                type: "object",
                properties: {
                  decisions: {
                    type: "array",
                    items: {
                      type: "object",
                      properties: {
                        segmentId: { type: "string" },
                        speaker: {
                          type: "string",
                          description:
                            "A speaker from knownSpeakers, or the literal string 'unsure' if truly indeterminate.",
                        },
                        confidence: {
                          type: "number",
                          minimum: 0,
                          maximum: 1,
                        },
                      },
                      required: ["segmentId", "speaker", "confidence"],
                    },
                  },
                },
                required: ["decisions"],
              },
            },
          },
        ],
        tool_choice: { type: "function", function: { name: "emit_decisions" } },
    });

    if (!res.ok) {
      return { decisions: [], error: `AI error ${res.status}` };
    }
    const json = (await res.json()) as any;
    const argStr = json.choices?.[0]?.message?.tool_calls?.[0]?.function?.arguments;
    if (!argStr) return { decisions: [], error: "No tool call" };
    try {
      const parsed = JSON.parse(argStr) as {
        decisions: Array<{ segmentId: string; speaker: string; confidence: number }>;
      };
      // Filter to decisions referencing real candidates + real speakers.
      const candIds = new Set(data.candidates.map((c) => c.segmentId));
      const knownSet = new Set(data.knownSpeakers);
      const decisions = (parsed.decisions ?? []).filter(
        (d) => candIds.has(d.segmentId) && (knownSet.has(d.speaker) || d.speaker === "unsure"),
      );
      return { decisions, error: null };
    } catch {
      return { decisions: [], error: "Parse error" };
    }
  });
/* ---------- 2.3: per-person profile enrichment ---------- */

const enrichPersonSchema = z.object({
  personName: z.string().min(1),
  personId: z.string().min(1),
  relationship: z.string().optional(),
  currentProfile: z.object({
    interests: z.array(z.string()).optional(),
    style_notes: z.string().optional(),
    topics_loved: z.string().optional(),
    topics_avoided: z.string().optional(),
    relationship_dynamics: z.string().optional(),
    dynamic_tags: z.array(z.string()).optional(),
  }),
  filteredTranscript: z.array(z.object({ speaker: z.string(), text: z.string() })).max(200),
  model: z.string().optional(),
});

const ENRICH_ALLOWED_TAGS = [
  "teases",
  "interrupts",
  "formal",
  "warm",
  "directive",
  "questions-a-lot",
  "stories-a-lot",
  "short-replies",
  "follows-up",
];

export const enrichPersonProfile = createServerFn({ method: "POST" })
  .inputValidator((d) => enrichPersonSchema.parse(d))
  .handler(async ({ data }) => {
    if (data.filteredTranscript.length === 0) {
      return {
        proposals: [] as Array<{
          field: string;
          value: string;
          op: "add" | "replace";
          reasoning?: string;
        }>,
        error: null as string | null,
      };
    }
    const system = `You analyse a transcript filtered to a SINGLE pair: James (a non-speaking AAC user) and ONE other person. You propose small, conservative updates to your stored profile of that person so future AI replies feel more attuned to them.

Categories (only propose what is strongly evidenced — skip categories with no evidence):
- interests (array): hobbies / subjects they clearly care about, each <= 5 words.
- style_notes (text, append): how James interacts with THIS person specifically.
- topics_loved (text, append): topics they brought up enthusiastically.
- topics_avoided (text, append): topics they steered away from.
- relationship_dynamics (text, append): freeform observation about the dynamic.
- dynamic_tags (array): tags from ONLY: [${ENRICH_ALLOWED_TAGS.map((t) => `"${t}"`).join(", ")}]. Max 3 new tags per proposal.

NEVER propose anything already present (verbatim or paraphrased). Be terse. Each value <= 25 words. Return empty proposals if nothing meaningful to add.`;

    const profileText = JSON.stringify(data.currentProfile, null, 2);
    const transcriptText = data.filteredTranscript.map((s) => `${s.speaker}: ${s.text}`).join("\n");
    const user = `Person: ${data.personName}${data.relationship ? ` (${data.relationship})` : ""}

Current stored profile:
${profileText}

Filtered transcript (only turns by James and ${data.personName}):
${transcriptText}`;

    const res = await chatCompletion(data.model ?? "google/gemini-2.5-pro", {
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        tools: [
          {
            type: "function",
            function: {
              name: "emit_proposals",
              parameters: {
                type: "object",
                properties: {
                  proposals: {
                    type: "array",
                    items: {
                      type: "object",
                      properties: {
                        field: {
                          type: "string",
                          enum: [
                            "interests",
                            "style_notes",
                            "topics_loved",
                            "topics_avoided",
                            "relationship_dynamics",
                            "dynamic_tags",
                          ],
                        },
                        value: { type: "string" },
                        op: { type: "string", enum: ["add", "replace"] },
                        reasoning: { type: "string" },
                      },
                      required: ["field", "value", "op"],
                    },
                  },
                },
                required: ["proposals"],
              },
            },
          },
        ],
        tool_choice: { type: "function", function: { name: "emit_proposals" } },
    });

    if (!res.ok) return { proposals: [], error: `AI error ${res.status}` };
    const json = (await res.json()) as any;
    const argStr = json.choices?.[0]?.message?.tool_calls?.[0]?.function?.arguments;
    if (!argStr) return { proposals: [], error: "No tool call" };
    try {
      const parsed = JSON.parse(argStr) as {
        proposals: Array<{
          field: string;
          value: string;
          op: "add" | "replace";
          reasoning?: string;
        }>;
      };
      const proposals = (parsed.proposals ?? []).filter((p) => {
        if (!p.value || !p.value.trim()) return false;
        if (p.field === "dynamic_tags") {
          return ENRICH_ALLOWED_TAGS.includes(p.value.trim().toLowerCase());
        }
        return true;
      });
      return { proposals, error: null };
    } catch {
      return { proposals: [], error: "Parse error" };
    }
  });

/* ---------- 2.4: self-introduction detection ---------- */

const detectIntrosSchema = z.object({
  transcript: z.array(z.object({ speaker: z.string(), text: z.string() })),
  existingPeopleNames: z.array(z.string()),
  jamesName: z.string().min(1),
  model: z.string().optional(),
});

export const detectIntroductions = createServerFn({ method: "POST" })
  .inputValidator((d) => detectIntrosSchema.parse(d))
  .handler(async ({ data }) => {
    if (data.transcript.length === 0) {
      return {
        introductions: [] as Array<{
          name: string;
          role?: string;
          relationship?: string;
          speakerLabel: string;
          confidence: number;
          quote: string;
        }>,
        error: null as string | null,
      };
    }
    const system = `You scan a finished conversation transcript for SELF-INTRODUCTIONS by people James (a non-speaking AAC user) hadn't met before. For each genuine introduction, extract: the speaker's first name (preferred), role/relationship if explicit, and which speaker label uttered the introduction.

Rules:
- Only flag introductions for people NOT already in existingPeopleNames (case-insensitive, first-name match).
- Confidence >= 0.7 required: the person must clearly introduce themselves, e.g. "Hi James, I'm Sarah from the agency", "This is Tom, I'll be helping today". Casual mentions of a third party DO NOT count.
- If James says someone's name but they haven't introduced themselves, that does NOT count.
- NEVER propose James himself.

Return via emit_introductions tool. Empty array if nothing qualifies.`;

    const user = `James's name: ${data.jamesName}
Existing people in the address book: ${data.existingPeopleNames.join(", ") || "(none)"}

Transcript:
${data.transcript.map((t) => `${t.speaker}: ${t.text}`).join("\n")}`;

    const res = await chatCompletion(data.model ?? "google/gemini-2.5-pro", {
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        tools: [
          {
            type: "function",
            function: {
              name: "emit_introductions",
              parameters: {
                type: "object",
                properties: {
                  introductions: {
                    type: "array",
                    items: {
                      type: "object",
                      properties: {
                        name: { type: "string" },
                        role: { type: "string" },
                        relationship: { type: "string" },
                        speakerLabel: { type: "string" },
                        confidence: { type: "number", minimum: 0, maximum: 1 },
                        quote: { type: "string" },
                      },
                      required: ["name", "speakerLabel", "confidence", "quote"],
                    },
                  },
                },
                required: ["introductions"],
              },
            },
          },
        ],
        tool_choice: {
          type: "function",
          function: { name: "emit_introductions" },
        },
    });

    if (!res.ok) return { introductions: [], error: `AI error ${res.status}` };
    const json = (await res.json()) as any;
    const argStr = json.choices?.[0]?.message?.tool_calls?.[0]?.function?.arguments;
    if (!argStr) return { introductions: [], error: "No tool call" };
    try {
      const parsed = JSON.parse(argStr) as {
        introductions: Array<{
          name: string;
          role?: string;
          relationship?: string;
          speakerLabel: string;
          confidence: number;
          quote: string;
        }>;
      };
      const known = new Set(
        [...data.existingPeopleNames, data.jamesName].map((n) => n.trim().toLowerCase()),
      );
      const introductions = (parsed.introductions ?? []).filter((i) => {
        if (!i.name || !i.name.trim()) return false;
        const first = i.name.trim().split(/\s+/)[0].toLowerCase();
        return !known.has(first) && i.confidence >= 0.7;
      });
      return { introductions, error: null };
    } catch {
      return { introductions: [], error: "Parse error" };
    }
  });

// === Tier 3: real-time signals ===

/* ------------------------------ 3.2: Arc ----------------------------------- */

const CONVERSATION_ARC_VALUES = [
  "greeting",
  "catching_up",
  "decision",
  "venting",
  "wrapping_up",
  "logistics",
  "small_talk",
] as const;

const arcSchema = z.object({
  recentTranscript: z.array(z.object({ speaker: z.string(), text: z.string() })).max(20),
  previousArc: z.enum(CONVERSATION_ARC_VALUES).optional(),
  model: z.string().optional(),
});

export const classifyConversationArc = createServerFn({ method: "POST" })
  .inputValidator((d) => arcSchema.parse(d))
  .handler(async ({ data }) => {
    const transcriptText = data.recentTranscript
      .slice(-12)
      .map((s) => `${s.speaker}: ${s.text}`)
      .join("\n");
    if (!transcriptText.trim()) {
      return { arc: null, confidence: 0, error: null };
    }

    const system = `You classify the current arc of a live spoken conversation in real time. Read the recent turns and return the SINGLE tag that best describes what the conversation is doing RIGHT NOW.

Tags:
- greeting: opening, hellos, initial pleasantries.
- catching_up: trading recent news, life updates.
- decision: deciding something concrete.
- venting: one person expressing frustration/sadness, wants to be heard.
- wrapping_up: signing off, goodbyes.
- logistics: practical coordination — times, addresses, scheduling.
- small_talk: light topical chat with no decision/update.

Prefer the tag for the LAST 3-5 turns. If conversation just shifted, use new tag. If ambiguous, prefer the previous arc (stickiness).`;

    const user = `${data.previousArc ? `Previous arc: ${data.previousArc}\n\n` : ""}Recent turns:
${transcriptText}`;

    const res = await chatCompletion(data.model, {
        temperature: 0.2,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        tools: [
          {
            type: "function",
            function: {
              name: "emit_arc",
              description: "Emit a single conversation-arc tag with confidence",
              parameters: {
                type: "object",
                properties: {
                  arc: { type: "string", enum: [...CONVERSATION_ARC_VALUES] },
                  confidence: { type: "number", minimum: 0, maximum: 1 },
                },
                required: ["arc", "confidence"],
              },
            },
          },
        ],
        tool_choice: { type: "function", function: { name: "emit_arc" } },
    });

    if (!res.ok) {
      const err = await res.text();
      console.error("Arc classification failed:", res.status, err);
      return { arc: null, confidence: 0, error: `AI error ${res.status}` };
    }
    const json = (await res.json()) as any;
    const argStr = json.choices?.[0]?.message?.tool_calls?.[0]?.function?.arguments;
    if (!argStr) return { arc: null, confidence: 0, error: "No tool call" };
    try {
      const parsed = JSON.parse(argStr) as {
        arc: (typeof CONVERSATION_ARC_VALUES)[number];
        confidence: number;
      };
      return { arc: parsed.arc, confidence: parsed.confidence ?? 0, error: null };
    } catch {
      return { arc: null, confidence: 0, error: "Parse error" };
    }
  });

/* ----------------------------- 3.3: Mood ----------------------------------- */

const MOOD_VALUES = ["normal", "calm", "excited", "sad", "upset", "empathetic", "amused"] as const;

const moodPredictSchema = z.object({
  recentTranscript: z.array(z.object({ speaker: z.string(), text: z.string() })).max(20),
  prosody: z
    .object({
      jamesMeanRms: z.number().optional(),
      otherMeanRms: z.number().optional(),
      otherRmsVariance: z.number().optional(),
      otherSpectralCentroid: z.number().optional(),
    })
    .optional(),
  previousMood: z.enum(MOOD_VALUES).optional(),
  model: z.string().optional(),
});

export const predictMood = createServerFn({ method: "POST" })
  .inputValidator((d) => moodPredictSchema.parse(d))
  .handler(async ({ data }) => {
    const transcriptText = data.recentTranscript
      .slice(-12)
      .map((s) => `${s.speaker}: ${s.text}`)
      .join("\n");
    if (!transcriptText.trim()) {
      return { mood: null, confidence: 0, reasoning: "", error: null };
    }

    const prosodyText = data.prosody
      ? `Acoustic prosody summary (OTHER speaker; James is non-speaking):\n` +
        `- mean RMS: ${data.prosody.otherMeanRms?.toFixed(3) ?? "n/a"}\n` +
        `- RMS variance: ${data.prosody.otherRmsVariance?.toFixed(4) ?? "n/a"}\n` +
        `- spectral centroid: ${data.prosody.otherSpectralCentroid?.toFixed(1) ?? "n/a"}\n`
      : "";

    const system = `You infer the current emotional MOOD of James, a non-speaking AAC user, based on the live conversation he is in.

You DO NOT have his voice — he is non-speaking. Read:
1. What the OTHER person/people just said (lexical cues — upset, joking, asking for help?).
2. The conversational turn-by-turn dynamic.
3. Optional acoustic prosody summary of the OTHER speaker.
4. The previous mood (for stickiness — don't flip without evidence).

Output ONE mood tag for the tone James should likely reply in:
- normal: neutral, default register.
- calm: measured, gentle, low-energy.
- excited: high-energy, animated, positive.
- sad: quiet, reflective, low.
- upset: frustrated, blunt, push-back.
- empathetic: the OTHER person is venting/struggling — James should support them.
- amused: playful, joking, light.

Be CONSERVATIVE. "normal" when nothing strongly suggests another tag. Confidence below 0.55 → return "normal". This auto-fills James's mood pill but he can override with one tap — prefer humility.`;

    const user = `${data.previousMood ? `Previous mood: ${data.previousMood}\n\n` : ""}${prosodyText ? `${prosodyText}\n` : ""}Recent turns:
${transcriptText}`;

    const res = await chatCompletion(data.model, {
        temperature: 0.3,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        tools: [
          {
            type: "function",
            function: {
              name: "emit_mood",
              description: "Emit a single predicted mood for James's next reply",
              parameters: {
                type: "object",
                properties: {
                  mood: { type: "string", enum: [...MOOD_VALUES] },
                  confidence: { type: "number", minimum: 0, maximum: 1 },
                  reasoning: { type: "string" },
                },
                required: ["mood", "confidence"],
              },
            },
          },
        ],
        tool_choice: { type: "function", function: { name: "emit_mood" } },
    });

    if (!res.ok) {
      const err = await res.text();
      console.error("Mood prediction failed:", res.status, err);
      return {
        mood: null,
        confidence: 0,
        reasoning: "",
        error: `AI error ${res.status}`,
      };
    }
    const json = (await res.json()) as any;
    const argStr = json.choices?.[0]?.message?.tool_calls?.[0]?.function?.arguments;
    if (!argStr) {
      return { mood: null, confidence: 0, reasoning: "", error: "No tool call" };
    }
    try {
      const parsed = JSON.parse(argStr) as {
        mood: (typeof MOOD_VALUES)[number];
        confidence: number;
        reasoning?: string;
      };
      return {
        mood: parsed.mood,
        confidence: parsed.confidence ?? 0,
        reasoning: parsed.reasoning ?? "",
        error: null,
      };
    } catch {
      return { mood: null, confidence: 0, reasoning: "", error: "Parse error" };
    }
  });

/* --------------------------- 3.1: Embeddings ------------------------------- */

const embedSchema = z.object({
  texts: z.array(z.string().min(1).max(8000)).min(1).max(64),
});

export const embedTexts = createServerFn({ method: "POST" })
  .inputValidator((d) => embedSchema.parse(d))
  .handler(async ({ data }) => {
    // Embeddings power Tier-3 semantic memory retrieval — a nice-to-have,
    // not core. Prefer the free Gemini key, then OpenAI, else degrade to
    // empty embeddings so an Anthropic-only deploy still works fully (just
    // without semantic recall) instead of throwing.
    const geminiKey = getGeminiApiKey();
    if (geminiKey) {
      // Gemini's OpenAI-compatible embeddings endpoint. `text-embedding-004` is
      // deprecated; use the current `gemini-embedding-001`. Request 1536 dims to
      // match the OpenAI path's length — any older 768-dim `text-embedding-004`
      // vectors are then skipped by retrieval's LENGTH-mismatch guard (the
      // model-label guard is effectively a no-op today because embed-backfill
      // hard-codes the EMBEDDING_MODEL label regardless of provider).
      const res = await fetch(
        "https://generativelanguage.googleapis.com/v1beta/openai/embeddings",
        {
          method: "POST",
          headers: { Authorization: `Bearer ${geminiKey}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            model: "gemini-embedding-001",
            input: data.texts,
            dimensions: 1536,
          }),
        },
      );
      if (!res.ok) throw new Error(`Embed failed: ${res.status} ${await res.text()}`);
      const json = (await res.json()) as { data: Array<{ embedding: number[] }> };
      return { embeddings: json.data.map((d) => d.embedding), model: "gemini-embedding-001" };
    }

    const openaiKey = getOpenAIApiKey();
    if (openaiKey) {
      const res = await fetch("https://api.openai.com/v1/embeddings", {
        method: "POST",
        headers: { Authorization: `Bearer ${openaiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model: "text-embedding-3-small", input: data.texts }),
      });
      if (!res.ok) throw new Error(`Embed failed: ${res.status} ${await res.text()}`);
      const json = (await res.json()) as { data: Array<{ embedding: number[] }> };
      return { embeddings: json.data.map((d) => d.embedding), model: "text-embedding-3-small" };
    }

    // No embeddings provider. Return zero-length vectors so callers can
    // skip semantic features without erroring.
    return { embeddings: data.texts.map(() => []), model: "none" };
  });
