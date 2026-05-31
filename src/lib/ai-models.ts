/**
 * AI model catalog, grouped by provider.
 *
 * The Settings page lets the user pick a provider first (Gemini / Anthropic /
 * OpenAI), then a specific model for each tier (Fast = live suggestions +
 * predictions + expansion; Smart = summaries, drafts, event prep). Model ids
 * carry a provider prefix so the server's `resolveChatChain` routes them to the
 * right provider — and falls back to the others automatically if that provider
 * errors or is rate-limited.
 */

export type AiProviderId = "anthropic" | "gemini" | "openai";

export type AiModel = {
  /** Provider-prefixed id sent to the server (e.g. "anthropic/claude-haiku-4-5"). */
  id: string;
  label: string;
  hint: string;
};

export type AiProvider = {
  id: AiProviderId;
  label: string;
  /** One-line note shown under the provider buttons. */
  note: string;
  models: AiModel[];
  defaultFast: string;
  defaultSmart: string;
};

export const AI_PROVIDERS: AiProvider[] = [
  {
    id: "gemini",
    label: "Gemini",
    note: "Google — the default. If the free tier rate-limits, Parley auto-falls-back to Anthropic/OpenAI so suggestions keep working.",
    models: [
      {
        id: "gemini/gemini-2.5-flash-lite",
        label: "Gemini 2.5 Flash-Lite",
        hint: "Fastest · free tier",
      },
      {
        id: "gemini/gemini-2.5-flash",
        label: "Gemini 2.5 Flash",
        hint: "Balanced · free tier",
      },
      {
        id: "gemini/gemini-2.5-pro",
        label: "Gemini 2.5 Pro",
        hint: "Smartest · needs paid tier",
      },
    ],
    defaultFast: "gemini/gemini-2.5-flash-lite",
    defaultSmart: "gemini/gemini-2.5-flash",
  },
  {
    id: "anthropic",
    label: "Anthropic",
    note: "Claude. Paid key — most reliable/lowest-latency; pick this if the Gemini free tier rate-limits too often.",
    models: [
      {
        id: "anthropic/claude-haiku-4-5",
        label: "Claude Haiku 4.5",
        hint: "Fastest · cheapest",
      },
      {
        id: "anthropic/claude-sonnet-4-5",
        label: "Claude Sonnet 4.5",
        hint: "Balanced · smart",
      },
    ],
    defaultFast: "anthropic/claude-haiku-4-5",
    defaultSmart: "anthropic/claude-sonnet-4-5",
  },
  {
    id: "openai",
    label: "OpenAI",
    note: "GPT. Uses your OpenAI key.",
    models: [
      {
        id: "openai-direct/gpt-4o-mini",
        label: "GPT-4o mini",
        hint: "Fast · cheap",
      },
      { id: "openai-direct/gpt-4o", label: "GPT-4o", hint: "Balanced" },
      { id: "openai-direct/gpt-5", label: "GPT-5", hint: "Most capable" },
    ],
    defaultFast: "openai-direct/gpt-4o-mini",
    defaultSmart: "openai-direct/gpt-4o",
  },
];

/** Which provider a stored model id belongs to. Anthropic / OpenAI by explicit
 *  prefix; everything else (gemini/, legacy google/, unknown) → Gemini, the
 *  default provider — matching DEFAULT_SETTINGS, getSettings healing, and the
 *  auto-pick order, so an unrecognised id never shows the wrong provider. */
export function providerIdForModel(modelId: string | undefined): AiProviderId {
  if (modelId?.startsWith("anthropic/")) return "anthropic";
  if (modelId?.startsWith("openai-direct/") || modelId?.startsWith("openai/"))
    return "openai";
  return "gemini";
}

export function getProvider(id: AiProviderId): AiProvider {
  return AI_PROVIDERS.find((p) => p.id === id) ?? AI_PROVIDERS[0];
}

/** The smartest model within a given model's provider, for quality-dominant,
 *  latency-insensitive work (conversation summaries, drafts, profile
 *  enrichment). Keeps the user's chosen provider but upgrades the tier so a
 *  fast/cheap "smart" pick (e.g. Gemini Flash) doesn't produce thin, inaccurate
 *  summaries. If the flagship is rate-limited the server's fallback chain still
 *  covers it. */
export function flagshipModelFor(modelId: string | undefined): string {
  switch (providerIdForModel(modelId)) {
    case "anthropic":
      return "anthropic/claude-sonnet-4-5";
    case "openai":
      return "openai-direct/gpt-5";
    case "gemini":
    default:
      return "gemini/gemini-2.5-pro";
  }
}
