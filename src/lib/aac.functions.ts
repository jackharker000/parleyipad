import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

function requireElevenLabsApiKey(): string {
  const key = process.env.ELEVENLABS_API_KEY;
  if (!key) throw new Error("ELEVENLABS_API_KEY is not configured");
  return key;
}

function requireLovableApiKey(): string {
  const key = process.env.LOVABLE_API_KEY;
  if (!key) throw new Error("LOVABLE_API_KEY is not configured");
  return key;
}

function requireOpenAIApiKey(): string {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error("OPENAI_API_KEY is not configured. Add it in Settings → AI model.");
  return key;
}

/**
 * Resolve the chat-completions endpoint + auth + model id for a given
 * model selector. Selectors prefixed with "openai-direct/" call the OpenAI
 * API directly using the user-provided OPENAI_API_KEY; everything else
 * routes through the Lovable AI Gateway.
 */
function resolveChatTarget(model: string | undefined): {
  url: string;
  headers: Record<string, string>;
  model: string;
} {
  const m = model ?? "google/gemini-2.5-flash-lite";
  if (m.startsWith("openai-direct/")) {
    const apiKey = requireOpenAIApiKey();
    return {
      url: "https://api.openai.com/v1/chat/completions",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      model: m.slice("openai-direct/".length),
    };
  }
  const apiKey = requireLovableApiKey();
  return {
    url: "https://ai.gateway.lovable.dev/v1/chat/completions",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    model: m,
  };
}

/* ------------------------- ElevenLabs: Scribe token ------------------------- */

export const createScribeToken = createServerFn({ method: "POST" }).handler(
  async () => {
    const apiKey = requireElevenLabsApiKey();
    const res = await fetch(
      "https://api.elevenlabs.io/v1/single-use-token/realtime_scribe",
      { method: "POST", headers: { "xi-api-key": apiKey } },
    );
    if (!res.ok) {
      const err = await res.text();
      throw new Error(err || `Token request failed: ${res.status}`);
    }
    const data = (await res.json()) as { token: string };
    return { token: data.token };
  },
);

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
      `https://api.elevenlabs.io/v1/text-to-speech/${data.voiceId}?output_format=mp3_44100_128`,
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
            style: 0.3,
            use_speaker_boost: true,
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

export const listVoices = createServerFn({ method: "GET" }).handler(
  async () => {
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
  },
);

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

const suggestionsSchema = z.object({
  recentTranscript: z
    .array(z.object({ speaker: z.string(), text: z.string() }))
    .max(40),
  jamesProfile: jamesProfileSchema.optional(),
  people: z.array(personCtxSchema).optional(),
  place: placeCtxSchema.optional(),
  event: eventCtxSchema.optional(),
  styleProfileJson: z.string().optional(),
  alreadyShown: z.array(z.string()).max(40).optional(),
  model: z.string().optional(),
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
      .slice(-20)
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

    const system = `You are an AAC (Augmentative and Alternative Communication) copilot. You generate reply options for ${jp?.name ?? "James"}, a non-speaking user, to TAP and speak aloud in real time. Suggestions must sound like HIM — not generic. Use his personality, humor, signature phrases, and shared history with the people present. Mix categories: direct answers, questions back, follow-ups about past topics, planned points, light humor when appropriate, "give me a moment" stalls. Avoid repeating any text in "alreadyShown". Each suggestion must be under 16 words and feel natural to say out loud. Prefer concrete references over generic small talk when memories or follow-ups are available.`;

    const user = `${profileBlock}
${peopleBlock}
${placeBlock}
${eventBlock}
${styleBlock}
# Live conversation so far
${transcriptText || "(no transcript yet — conversation just starting)"}

${data.alreadyShown?.length ? `# Already shown (do NOT repeat)\n${data.alreadyShown.join(" | ")}\n` : ""}
Return 16 ranked suggestions in James's voice. Provide a wide variety so James has plenty of useful options to pick from.`;

    const target = resolveChatTarget(data.model);
    const res = await fetch(target.url, {
      method: "POST",
      headers: target.headers,
      body: JSON.stringify({
        model: target.model,
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
                    minItems: 8,
                    maxItems: 16,
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
      }),
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
  transcript: z.array(
    z.object({ speaker: z.string(), text: z.string() }),
  ),
  placeName: z.string().optional(),
  peopleNames: z.array(z.string()).optional(),
});

export const summarizeConversation = createServerFn({ method: "POST" })
  .inputValidator((d) => summarySchema.parse(d))
  .handler(async ({ data }) => {
    const apiKey = requireLovableApiKey();
    const transcriptText = data.transcript
      .map((s) => `${s.speaker}: ${s.text}`)
      .join("\n");

    if (!transcriptText.trim()) {
      return {
        summary: "",
        highlights: [],
        memories: [],
        followUps: [],
        error: null,
      };
    }

    const system = `You analyze a conversation that James (a non-speaking AAC user) just had. Return: a 2-4 sentence narrative summary, 2-5 short highlight bullets, durable memory candidates (facts/preferences/events/todos worth remembering for next time), and follow-up topics for the next conversation. Be concise and concrete.`;

    const ctx = `${data.placeName ? `Place: ${data.placeName}\n` : ""}${data.peopleNames?.length ? `People present: ${data.peopleNames.join(", ")}\n` : ""}\nTranscript:\n${transcriptText}`;

    const res = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "google/gemini-2.5-flash",
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
                  summary: { type: "string" },
                  highlights: { type: "array", items: { type: "string" } },
                  memories: {
                    type: "array",
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
                  followUps: { type: "array", items: { type: "string" } },
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
      }),
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

    const system = `You are an AAC writing assistant for ${jp?.name ?? "James"}, a non-speaking user with cerebral palsy whose typing is heavily truncated and full of typos. Your job: take his raw typed input and rewrite it as ONE clear, natural spoken sentence (or two short sentences max) in HIS voice, appropriate as the next reply in the live conversation. Preserve his intent exactly — never add facts, opinions, or details he did not type. Fix spelling, expand abbreviations, add small connector words. Keep it concise, conversational, and under 25 words. Output ONLY the final sentence to be spoken aloud, with no quotes, no preface, no explanation.`;

    const user = `${profileBlock}${peopleBlock}${placeBlock}
Recent conversation:
${transcriptText || "(just starting)"}

James typed: "${data.rawText}"

Rewrite as the spoken reply:`;

    const target = resolveChatTarget(data.model);
    const res = await fetch(target.url, {
      method: "POST",
      headers: target.headers,
      body: JSON.stringify({
        model: target.model,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      }),
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

    const target = resolveChatTarget(data.model);
    const res = await fetch(target.url, {
      method: "POST",
      headers: target.headers,
      body: JSON.stringify({
        model: target.model,
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
      }),
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
      (data.existingPoints?.length || data.existingQuestions?.length)
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

    const target = resolveChatTarget(data.model);
    const res = await fetch(target.url, {
      method: "POST",
      headers: target.headers,
      body: JSON.stringify({
        model: target.model,
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
      }),
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

    const target = resolveChatTarget(data.model);
    const res = await fetch(target.url, {
      method: "POST",
      headers: target.headers,
      body: JSON.stringify({
        model: target.model,
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
      }),
    });

    if (!res.ok) {
      const err = await res.text();
      console.error("draftReply failed:", res.status, err);
      return { recommended: data.rawText, alternatives: [], error: `AI error ${res.status}` };
    }
    const json = (await res.json()) as any;
    const argStr = json.choices?.[0]?.message?.tool_calls?.[0]?.function?.arguments;
    if (!argStr) return { recommended: data.rawText, alternatives: [], error: "No tool call returned" };
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

    const target = resolveChatTarget(data.model);
    const res = await fetch(target.url, {
      method: "POST",
      headers: target.headers,
      body: JSON.stringify({
        model: target.model,
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
      }),
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