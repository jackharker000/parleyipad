import type { Person, TranscriptSegment } from "./db";

const JAMES_SELF_LABEL = "__james_self__";

/** Replace speaker labels with mapped person names for prompt context. */
export function labelTranscriptForPrompt(
  segments: { speaker: string; text: string }[],
  mapping: Record<string, string>,
  peopleById: Map<string, Person>,
  jamesLabel?: string,
  jamesName = "the user",
): { speaker: string; text: string }[] {
  return segments.map((s) => {
    if (s.speaker === "__james_self__") return { ...s, speaker: jamesName };
    if (s.speaker === jamesLabel) return { ...s, speaker: jamesName };
    const pid = mapping[s.speaker];
    if (pid) {
      const p = peopleById.get(pid);
      if (p) return { ...s, speaker: p.name };
    }
    return s;
  });
}

// Re-export for any future callers (kept to minimise churn).
export { JAMES_SELF_LABEL };
// Suppress unused import warning until a caller needs the type.
export type { TranscriptSegment };