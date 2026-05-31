import { makeLLM } from "@/lib/providers";
import type { LLMProviderId } from "@/lib/db";

import { DomainAI } from "./domain";

export { DomainAI } from "./domain";
export { MOODS } from "./domain";
export type {
  Mood,
  SuggestionContext,
  SuggestionDraft,
  ExpandContext,
  DraftPlatform,
  DraftReplyContext,
  DraftReplyResult,
  DraftReplyVariation,
  InterestSuggestion,
  ExtractInterestsContext,
  ExtractLexiconContext,
  ExtractLexiconEntry,
  ExtractLexiconResult,
  EventPrepContext,
  EventPrepResult,
} from "./domain";

/**
 * Build a DomainAI client for the given provider. Cheap to construct —
 * just wraps an HTTP client. Callers should rebuild on settings change.
 */
export function makeAI(providerId: LLMProviderId): DomainAI {
  return new DomainAI(makeLLM(providerId));
}
