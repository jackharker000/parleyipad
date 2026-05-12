import type { Person, TranscriptSegment } from "./db";
import { extractIntroducedNames } from "./auto-person";

const JAMES_SELF_LABEL = "__james_self__";

/**
 * Try to auto-map diarized speaker labels (e.g. "Speaker 2") to known Person ids.
 * Returns a NEW mapping: { [speaker_label]: person_id }.
 *
 * IMPORTANT: James never speaks aloud — he only types/taps suggestions, which
 * appear in the transcript with the synthetic label `__james_self__`. So every
 * diarized voice label must map to a non-James person. We never assign a
 * spoken label to James.
 */
export function autoMapSpeakers(opts: {
  segments: TranscriptSegment[];
  candidates: Person[];
  current: Record<string, string>;
  /** Deprecated — James never speaks. Kept for backwards compatibility, ignored. */
  jamesSpeakerLabel?: string;
}): { mapping: Record<string, string>; jamesLabel?: string } {
  const mapping: Record<string, string> = { ...opts.current };
  const used = new Set(Object.values(mapping));
  // James is the typist, never a diarized voice. Treat as fixed synthetic label.
  const jamesLabel = JAMES_SELF_LABEL;

  // Index candidates by lowercase first name and full name
  const byFirstName = new Map<string, Person[]>();
  for (const p of opts.candidates) {
    const first = p.name.trim().split(/\s+/)[0].toLowerCase();
    const arr = byFirstName.get(first) ?? [];
    arr.push(p);
    byFirstName.set(first, arr);
  }

  // Group segments by speaker label
  const bySpeaker = new Map<string, TranscriptSegment[]>();
  for (const s of opts.segments) {
    const arr = bySpeaker.get(s.speaker_label) ?? [];
    arr.push(s);
    bySpeaker.set(s.speaker_label, arr);
  }

  function nameToPerson(name: string): Person | undefined {
    const matches = byFirstName.get(name.toLowerCase()) ?? [];
    if (matches.length === 1) return matches[0];
    return undefined; // ambiguous — skip
  }

  // 1. Self-introduction patterns inside any speaker's lines.
  // Reuse the same hardened extractor as auto-person creation so the two
  // stay in sync (same stoplist, same normalisation, same confidence order).
  const intros = extractIntroducedNames(
    opts.segments.map((s) => ({ text: s.text, speaker_label: s.speaker_label })),
  );
  for (const { name, speaker_label: label } of intros) {
    if (label === jamesLabel || mapping[label]) continue;
    const person = nameToPerson(name);
    if (person && !used.has(person.id)) {
      mapping[label] = person.id;
      used.add(person.id);
    }
  }

  // Bare-name reply fallback ("Sarah." in <= 3 words) for unmapped speakers.
  for (const [label, segs] of bySpeaker) {
    if (mapping[label] || label === jamesLabel) continue;
    for (const seg of segs) {
      const words = seg.text.trim().replace(/[.!?,]/g, "").split(/\s+/);
      if (words.length > 3) continue;
      for (const w of words) {
        if (!/^[A-Z][a-zA-Z'-]+$/.test(w)) continue;
        const p = nameToPerson(w);
        if (p && !used.has(p.id)) {
          mapping[label] = p.id;
          used.add(p.id);
          break;
        }
      }
      if (mapping[label]) break;
    }
  }

  // 2. James-addresses-them: "Hey Sarah, …" then a new speaker replies
  // Heuristic: find James's typed segments mentioning a candidate name; the
  // next spoken segment by an unmapped speaker is likely that person.
  {
    const sorted = [...opts.segments].sort((a, b) => a.ts - b.ts);
    for (let i = 0; i < sorted.length; i++) {
      const cur = sorted[i];
      if (cur.speaker_label !== jamesLabel) continue;
      // Find any candidate first-name in this utterance
      const tokens = cur.text.match(/\b[A-Z][a-zA-Z'-]+\b/g) ?? [];
      const named = tokens
        .map((t) => nameToPerson(t))
        .find((p): p is Person => !!p && !used.has(p.id));
      if (!named) continue;
      // Next segment by a different, unmapped label
      const next = sorted
        .slice(i + 1)
        .find(
          (s) =>
            s.speaker_label !== jamesLabel &&
            !mapping[s.speaker_label],
        );
      if (next) {
        mapping[next.speaker_label] = named.id;
        used.add(named.id);
      }
    }
  }

  // 3. Selected-people fallback. Since James never speaks, every diarized
  // label must be one of the people currently in the conversation. Pair
  // unmapped labels (in first-heard order) with unmapped candidates (in the
  // order they were selected). This handles the common case of 1-vs-1 chats
  // and gracefully degrades for groups.
  const labelFirstSeen = new Map<string, number>();
  for (const s of opts.segments) {
    if (s.speaker_label === jamesLabel) continue;
    if (!labelFirstSeen.has(s.speaker_label)) {
      labelFirstSeen.set(s.speaker_label, s.ts);
    }
  }
  const unmappedLabels = [...bySpeaker.keys()]
    .filter((l) => !mapping[l] && l !== jamesLabel)
    .sort(
      (a, b) =>
        (labelFirstSeen.get(a) ?? 0) - (labelFirstSeen.get(b) ?? 0),
    );
  const unusedCandidates = opts.candidates.filter((c) => !used.has(c.id));
  for (let i = 0; i < unmappedLabels.length && i < unusedCandidates.length; i++) {
    mapping[unmappedLabels[i]] = unusedCandidates[i].id;
    used.add(unusedCandidates[i].id);
  }

  return { mapping, jamesLabel };
}

/** Replace speaker labels with mapped person names for prompt context. */
export function labelTranscriptForPrompt(
  segments: { speaker: string; text: string }[],
  mapping: Record<string, string>,
  peopleById: Map<string, Person>,
  jamesLabel?: string,
  jamesName = "James",
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