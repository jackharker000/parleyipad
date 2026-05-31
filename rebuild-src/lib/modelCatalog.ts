/**
 * Local-only catalogue of LLM models the user can pick in Settings → Voice
 * & Models. Adding a new model here makes it selectable; it's then forwarded
 * to the upstream provider via the per-tier override on `SettingsRecord`.
 *
 * Server-side proxies fall back to env-var defaults when no override is set
 * (`PARLEY_ANTHROPIC_FAST_MODEL`, etc.) so this list can be edited without
 * a deploy.
 */

export type ModelProviderId = "anthropic" | "openai";
export type ModelTier = "fast" | "smart";

export type ModelEntry = {
  id: string;
  label: string;
  provider: ModelProviderId;
  tier: ModelTier;
};

export const MODEL_OPTIONS: ModelEntry[] = [
  { id: "claude-haiku-4-5", label: "Claude Haiku 4.5", provider: "anthropic", tier: "fast" },
  { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6", provider: "anthropic", tier: "smart" },
  { id: "claude-opus-4-7", label: "Claude Opus 4.7", provider: "anthropic", tier: "smart" },
  { id: "gpt-5-mini", label: "GPT-5 mini", provider: "openai", tier: "fast" },
  { id: "gpt-5", label: "GPT-5", provider: "openai", tier: "smart" },
];

export function modelsForProviderTier(provider: ModelProviderId, tier: ModelTier): ModelEntry[] {
  return MODEL_OPTIONS.filter((m) => m.provider === provider && m.tier === tier);
}
