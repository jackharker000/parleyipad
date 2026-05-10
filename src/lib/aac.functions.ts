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

/* ----------------------------- AI: suggestions ----------------------------- */

const suggestionsSchema = z.object({
  recentTranscript: z
    .array(z.object({ speaker: z.string(), text: z.string() }))
    .max(40),
  speakerContext: z.string().optional(),
  placeContext: z.string().optional(),
  styleHints: z.string().optional(),
  alreadyShown: z.array(z.string()).max(40).optional(),
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
    const apiKey = requireLovableApiKey();

    const transcriptText = data.recentTranscript
      .slice(-20)
      .map((s) => `${s.speaker}: ${s.text}`)
      .join("\n");

    const system = `You are an AAC (Augmentative and Alternative Communication) copilot for James, a non-speaking user. Generate 6 short, natural reply options he could tap to speak aloud. Match HIS voice: concise, warm, conversational. Mix categories. Avoid repeating any text in "alreadyShown". Each suggestion under 14 words.`;

    const user = `Conversation so far:
${transcriptText || "(no transcript yet — conversation just starting)"}

${data.speakerContext ? `Speaker context: ${data.speakerContext}\n` : ""}${data.placeContext ? `Location context: ${data.placeContext}\n` : ""}${data.styleHints ? `James's style: ${data.styleHints}\n` : ""}${data.alreadyShown?.length ? `Already shown (don't repeat): ${data.alreadyShown.join(" | ")}\n` : ""}
Return 6 ranked suggestions.`;

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
                    minItems: 4,
                    maxItems: 8,
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