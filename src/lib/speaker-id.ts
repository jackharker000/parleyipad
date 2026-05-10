import type { Person, TranscriptSegment } from "./db";

/**
 * Try to auto-map diarized speaker labels (e.g. "Speaker 2") to known Person ids.
 * Returns a NEW mapping: { [speaker_label]: person_id }.
 * Only assigns when confidence is high; never overwrites an existing mapping
 * unless `override` is true.
 */
export function autoMapSpeakers(opts: {
  segments: TranscriptSegment[];
  candidates: Person[];
  current: Record<string, string>;
  jamesSpeakerLabel?: string; // if known
}): { mapping: Record<string, string>; jamesLabel?: string } {
  const mapping: Record<string, string> = { ...opts.current };
  const used = new Set(Object.values(mapping));
  let jamesLabel = opts.jamesSpeakerLabel;

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

  // 1. Self-introduction patterns inside any speaker's lines
  const selfIntroRegexes = [
    /\bi['’]?m\s+([A-Z][a-zA-Z'-]+)\b/,
    /\bi am\s+([A-Z][a-zA-Z'-]+)\b/i,
    /\bit['’]?s\s+([A-Z][a-zA-Z'-]+)\b/,
    /\bthis is\s+([A-Z][a-zA-Z'-]+)\b/i,
    /\b([A-Z][a-zA-Z'-]+)\s+here\b/,
    /\bmy name is\s+([A-Z][a-zA-Z'-]+)\b/i,
    /\bcall me\s+([A-Z][a-zA-Z'-]+)\b/i,
  ];

  for (const [label, segs] of bySpeaker) {
    if (mapping[label]) continue;
    for (const seg of segs) {
      let matchedName: string | undefined;
      for (const rx of selfIntroRegexes) {
        const m = seg.text.match(rx);
        if (m?.[1]) {
          matchedName = m[1];
          break;
        }
      }
      // Bare name reply (just "Sarah" or "Sarah." in <= 3 words)
      if (!matchedName) {
        const words = seg.text.trim().replace(/[.!?]/g, "").split(/\s+/);
        if (words.length <= 3) {
          for (const w of words) {
            if (/^[A-Z][a-zA-Z'-]+$/.test(w)) {
              const p = nameToPerson(w);
              if (p) {
                matchedName = w;
                break;
              }
            }
          }
        }
      }
      if (matchedName) {
        const person = nameToPerson(matchedName);
        if (person && !used.has(person.id)) {
          mapping[label] = person.id;
          used.add(person.id);
          break;
        }
      }
    }
  }

  // 2. James-addresses-them: "Hey Sarah, …" then a new speaker replies
  // Heuristic: find James's segments mentioning a candidate name; the next
  // segment by an unmapped speaker is likely that person.
  if (jamesLabel) {
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

  // 3. Sole-candidate prior: if exactly one unmapped non-James speaker label
  // exists AND exactly one unused candidate remains, assign.
  const unmappedLabels = [...bySpeaker.keys()].filter(
    (l) => !mapping[l] && l !== jamesLabel,
  );
  const unusedCandidates = opts.candidates.filter((c) => !used.has(c.id));
  if (unmappedLabels.length === 1 && unusedCandidates.length === 1) {
    mapping[unmappedLabels[0]] = unusedCandidates[0].id;
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
    if (s.speaker === jamesLabel) return { ...s, speaker: jamesName };
    const pid = mapping[s.speaker];
    if (pid) {
      const p = peopleById.get(pid);
      if (p) return { ...s, speaker: p.name };
    }
    return s;
  });
}