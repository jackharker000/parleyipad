/**
 * Post-conversation analysis pipeline (Tier 2).
 *
 * Orchestrators that run after the user presses Stop and the live summary
 * has been saved. Each orchestrator is independent except where noted:
 *
 *  - rediarizeAfterStop       (2.1) — cleans up speaker labels using stored
 *                                     voiceprints + LLM tie-breakers.
 *  - rebuildVoiceprintsAfterStop (2.2) — re-clusters each person's contributions
 *                                     and writes back sharper centroids.
 *  - enrichProfilesAfterStop  (2.3) — proposes Person profile updates.
 *  - detectIntroductionsAfterStop (2.4) — auto-creates new Person records from
 *                                     self-introductions. Depends on 2.1's
 *                                     cluster_centroids.
 *
 * The orchestrator in `src/routes/index.tsx#handleStop` awaits 2.1 first
 * then runs 2.2 / 2.3 / 2.4 in `Promise.all`.
 */

import {
  db,
  newId,
  getJamesProfile,
  type Person,
  type Voiceprint,
  type ProfileProposal,
  type TranscriptSegment,
  MFCC_COEFFS,
} from "./db";
import { cosineSim, rebuildVoiceprintFromContributions } from "./voiceprint";
import { kmeansRediarize, type UtteranceVec } from "./rediarize";
import { aiRediarizeTieBreaker, enrichPersonProfile, detectIntroductions } from "./aac.functions";
import { extractIntroducedNames } from "./auto-person";
import { toast } from "sonner";

export type Tier2Ctx = {
  conversationId: string;
  segs: TranscriptSegment[];
  /** Names of confirmed participants (excluding James). */
  peopleNames: string[];
  /** Person ids of confirmed participants in this conversation. */
  personIds: string[];
  smartModel: string;
  fastModel: string;
};

/** Per-cluster label used internally for the non-James speakers. The label
 *  is `person::<personId>` so we can map directly back to a person row
 *  after k-means. */
const labelForPerson = (id: string) => `person::${id}`;
const personIdFromLabel = (label: string): string | null =>
  label.startsWith("person::") ? label.slice("person::".length) : null;

/* -------------------------------------------------------------------------- */
/* 2.1 — Re-diarize                                                           */
/* -------------------------------------------------------------------------- */

export type RediarizeAfterStopResult = {
  reassignedCount: number;
  /** Map of cluster label -> centroid vector. Used by detectIntroductions to
   *  seed voiceprints for newly-introduced people. */
  cluster_centroids: Record<string, number[]>;
  /** Map of cluster_label -> mean intra-cluster confidence. */
  cluster_confidence: Record<string, number>;
};

export async function rediarizeAfterStop(ctx: Tier2Ctx): Promise<RediarizeAfterStopResult> {
  const empty: RediarizeAfterStopResult = {
    reassignedCount: 0,
    cluster_centroids: {},
    cluster_confidence: {},
  };

  // Need at least 2 non-James speakers to be worth re-diarizing.
  if (ctx.personIds.length < 2) return empty;

  // Pull MFCC vectors for this conversation. If none captured (older
  // conversation before Tier 2 shipped) we gracefully no-op.
  const mfccs = await db.segment_mfccs
    .where("conversation_id")
    .equals(ctx.conversationId)
    .toArray();
  if (mfccs.length === 0) return empty;
  const mfccBySegmentId = new Map(mfccs.map((m) => [m.segment_id, m.mfcc]));

  // Load the speaker_map for this conversation to identify which segments
  // belong to James and which to confirmed participants.
  const conv = await db.conversations.get(ctx.conversationId);
  const speakerMap = conv?.speaker_map ?? {};
  const profile = await getJamesProfile();
  const jamesName = profile.display_name?.toLowerCase() ?? "james";
  const jamesLabels = new Set<string>();
  for (const [label, personId] of Object.entries(speakerMap)) {
    const person = await db.people.get(personId);
    if (person?.name?.toLowerCase() === jamesName) jamesLabels.add(label);
  }

  // Build the list of utterances to re-cluster: any segment with an MFCC that
  // is NOT attributed to James.
  const utterances: UtteranceVec[] = [];
  for (const seg of ctx.segs) {
    if (jamesLabels.has(seg.speaker_label)) continue;
    const mfcc = mfccBySegmentId.get(seg.id);
    if (!mfcc || mfcc.length !== MFCC_COEFFS) continue;
    utterances.push({
      segment_id: seg.id,
      mfcc,
      text: seg.text,
      ts: seg.ts,
      current_label: seg.speaker_label,
    });
  }
  if (utterances.length === 0) return empty;

  // Seed centroids from stored voiceprints of confirmed participants (minus James).
  const allPeople = await db.people.bulkGet(ctx.personIds);
  const seeds: { label: string; centroid: number[] }[] = [];
  for (const p of allPeople) {
    if (!p) continue;
    if (p.name?.toLowerCase() === jamesName) continue;
    const vp = await db.voiceprints.get(p.id);
    if (vp && vp.centroid.length === MFCC_COEFFS) {
      seeds.push({ label: labelForPerson(p.id), centroid: vp.centroid });
    }
  }
  // If we don't have enough seeded voiceprints (e.g. a person was added
  // mid-conversation), top up from this conversation's live cluster centroids.
  if (seeds.length < 2) {
    const live = new Map<string, { sum: number[]; count: number }>();
    for (const u of utterances) {
      const agg = live.get(u.current_label) ?? {
        sum: new Array(MFCC_COEFFS).fill(0),
        count: 0,
      };
      for (let i = 0; i < MFCC_COEFFS; i++) agg.sum[i] += u.mfcc[i];
      agg.count += 1;
      live.set(u.current_label, agg);
    }
    const taken = new Set(seeds.map((s) => s.label));
    for (const [label, agg] of live) {
      const liveLabel = `live::${label}`;
      if (taken.has(liveLabel)) continue;
      if (agg.count === 0) continue;
      seeds.push({
        label: liveLabel,
        centroid: agg.sum.map((v) => v / agg.count),
      });
      if (seeds.length >= ctx.personIds.length) break;
    }
  }
  if (seeds.length < 2) return empty;

  const result = kmeansRediarize(utterances, seeds);

  // Resolve ambiguous segments via LLM tie-breaker.
  const finalLabels = { ...result.label_for_segment };
  if (result.ambiguous.length > 0) {
    const knownSpeakers = seeds.map((s) => labelToHumanName(s.label, ctx));
    const candidates = result.ambiguous.slice(0, 20).map((a) => {
      const seg = ctx.segs.find((s) => s.id === a.segment_id);
      return {
        segmentId: a.segment_id,
        text: seg?.text ?? "",
        proposedSpeaker: labelToHumanName(a.best_label, ctx),
        runnerUp: labelToHumanName(a.runner_up_label, ctx),
      };
    });
    const recentContext = ctx.segs.slice(0, 30).map((s) => ({
      speaker: humanNameForSegment(s, speakerMap, allPeople),
      text: s.text,
    }));
    try {
      const tieRes = await aiRediarizeTieBreaker({
        data: {
          knownSpeakers,
          candidates,
          recentContext,
          model: ctx.smartModel,
        },
      });
      const humanToLabel = new Map<string, string>();
      for (const s of seeds) humanToLabel.set(labelToHumanName(s.label, ctx), s.label);
      for (const d of tieRes.decisions) {
        if (d.speaker === "unsure") continue;
        const lab = humanToLabel.get(d.speaker);
        if (lab && d.confidence >= 0.7) {
          finalLabels[d.segmentId] = lab;
        }
      }
    } catch (e) {
      console.warn("[tier2.1] tie-breaker failed", e);
    }
  }

  // Apply label changes back to Dexie.
  let reassignedCount = 0;
  const speakerMapUpdate: Record<string, string> = {};
  const now = Date.now();
  for (const u of utterances) {
    const newLabel = finalLabels[u.segment_id];
    if (!newLabel) continue;
    const personId = personIdFromLabel(newLabel);
    if (!personId) continue;
    // Find a stable speaker_label for that person.
    let canonicalSpeakerLabel: string | undefined;
    for (const [lbl, pid] of Object.entries(speakerMap)) {
      if (pid === personId) {
        canonicalSpeakerLabel = lbl;
        break;
      }
    }
    if (!canonicalSpeakerLabel) {
      canonicalSpeakerLabel = u.current_label;
      speakerMapUpdate[canonicalSpeakerLabel] = personId;
    }
    const centroid = result.cluster_centroids[newLabel];
    const conf = centroid && centroid.length === u.mfcc.length ? cosineSim(u.mfcc, centroid) : 0;
    const patch: Partial<TranscriptSegment> = {
      person_id: personId,
      confidence: Math.max(0, Math.min(1, conf)),
      rediarized_at: now,
    };
    const previousSeg = ctx.segs.find((s) => s.id === u.segment_id);
    const changed =
      u.current_label !== canonicalSpeakerLabel || previousSeg?.person_id !== personId;
    if (u.current_label !== canonicalSpeakerLabel) {
      patch.speaker_label = canonicalSpeakerLabel;
    }
    await db.transcript_segments.update(u.segment_id, patch);
    if (changed) reassignedCount += 1;
  }
  if (Object.keys(speakerMapUpdate).length > 0) {
    await db.conversations.update(ctx.conversationId, {
      speaker_map: { ...speakerMap, ...speakerMapUpdate },
    });
  }

  if (reassignedCount > 0) {
    toast.success(
      `Cleaned up transcript: ${reassignedCount} segment${
        reassignedCount === 1 ? "" : "s"
      } reassigned`,
      { id: "tier2-rediarize" },
    );
  }

  return {
    reassignedCount,
    cluster_centroids: result.cluster_centroids,
    cluster_confidence: result.cluster_confidence,
  };
}

function labelToHumanName(label: string, ctx: Tier2Ctx): string {
  const pid = personIdFromLabel(label);
  if (pid) {
    const idx = ctx.personIds.indexOf(pid);
    if (idx >= 0 && ctx.peopleNames[idx]) return ctx.peopleNames[idx];
    return `Person ${pid.slice(0, 4)}`;
  }
  return label;
}

function humanNameForSegment(
  s: TranscriptSegment,
  speakerMap: Record<string, string>,
  people: (Person | undefined)[],
): string {
  const pid = speakerMap[s.speaker_label];
  if (pid) {
    const p = people.find((p) => p?.id === pid);
    if (p) return p.name;
  }
  return s.speaker_label;
}

/* -------------------------------------------------------------------------- */
/* 2.2 — Voiceprint rebuild                                                   */
/* -------------------------------------------------------------------------- */

export async function rebuildVoiceprintsAfterStop(ctx: Tier2Ctx): Promise<void> {
  // Touch everyone in this conversation + anyone with stale prints (>7 days).
  const STALE_MS = 7 * 24 * 60 * 60 * 1000;
  const stale = await db.voiceprints
    .filter((vp: Voiceprint) => (vp.last_rebuilt_at ?? 0) < Date.now() - STALE_MS)
    .toArray();
  const ids = new Set<string>([...ctx.personIds, ...stale.map((vp) => vp.person_id)]);

  let rebuilt = 0;
  for (const pid of ids) {
    try {
      const outcome = await rebuildVoiceprintFromContributions(pid);
      if (outcome && !outcome.aborted) rebuilt += 1;
    } catch (e) {
      console.warn("[tier2.2] rebuild failed for", pid, e);
    }
  }
  if (rebuilt > 0) {
    toast.success(`Rebuilt ${rebuilt} voiceprint${rebuilt === 1 ? "" : "s"}`, {
      id: "tier2-rebuild",
    });
  }
}

/* -------------------------------------------------------------------------- */
/* 2.3 — Per-person profile enrichment                                        */
/* -------------------------------------------------------------------------- */

const MAX_PROPOSALS_PER_PERSON_PER_CONV = 5;
const MIN_PERSON_TURNS_FOR_ENRICH = 4;

export async function enrichProfilesAfterStop(ctx: Tier2Ctx): Promise<void> {
  // Re-read transcript fresh in case 2.1 just rewrote person_ids.
  const allSegs = await db.transcript_segments
    .where("conversation_id")
    .equals(ctx.conversationId)
    .toArray();
  allSegs.sort((a, b) => a.ts - b.ts);

  const conv = await db.conversations.get(ctx.conversationId);
  const speakerMap = conv?.speaker_map ?? {};
  const profile = await getJamesProfile();
  const jamesName = profile.display_name ?? "James";

  const labelToPerson = new Map<string, string>(Object.entries(speakerMap));

  for (const personId of ctx.personIds) {
    try {
      const person = await db.people.get(personId);
      if (!person) continue;
      if (person.name.toLowerCase() === jamesName.toLowerCase()) continue;

      // Find indices of segments belonging to this person.
      const indices: number[] = [];
      for (let i = 0; i < allSegs.length; i++) {
        const s = allSegs[i];
        const pid = s.person_id ?? labelToPerson.get(s.speaker_label);
        if (pid === personId) indices.push(i);
      }
      if (indices.length < MIN_PERSON_TURNS_FOR_ENRICH) continue;

      // Build filtered transcript: person's turns + 2 surrounding segments
      // (but only emit James/person turns into the LLM input, for privacy).
      const keep = new Set<number>();
      for (const i of indices) {
        for (let j = Math.max(0, i - 2); j <= Math.min(allSegs.length - 1, i + 2); j++) {
          keep.add(j);
        }
      }
      // Pre-resolve speaker identities for filtered slots so we don't do
      // async lookups inside the loop in a hot path.
      const slotIsPerson = new Array<boolean>(allSegs.length).fill(false);
      const slotIsJames = new Array<boolean>(allSegs.length).fill(false);
      for (let i = 0; i < allSegs.length; i++) {
        if (!keep.has(i)) continue;
        const s = allSegs[i];
        const pid = s.person_id ?? labelToPerson.get(s.speaker_label);
        if (pid === personId) slotIsPerson[i] = true;
        else if (pid) {
          const other = await db.people.get(pid);
          if (other && other.name?.toLowerCase() === jamesName.toLowerCase()) {
            slotIsJames[i] = true;
          }
        }
      }
      const filtered: { speaker: string; text: string }[] = [];
      for (let i = 0; i < allSegs.length; i++) {
        if (!keep.has(i)) continue;
        const s = allSegs[i];
        if (slotIsPerson[i]) {
          filtered.push({ speaker: person.name, text: s.text });
        } else if (slotIsJames[i]) {
          filtered.push({ speaker: jamesName, text: s.text });
        }
      }
      if (filtered.length === 0) continue;

      const r = await enrichPersonProfile({
        data: {
          personName: person.name,
          personId: person.id,
          relationship: person.relationship,
          currentProfile: {
            interests: person.interests,
            style_notes: person.style_notes,
            topics_loved: person.topics_loved,
            topics_avoided: person.topics_avoided,
            relationship_dynamics: person.relationship_dynamics,
            dynamic_tags: person.dynamic_tags,
          },
          filteredTranscript: filtered.slice(0, 200),
          model: ctx.smartModel,
        },
      });

      const capped = (r.proposals ?? []).slice(0, MAX_PROPOSALS_PER_PERSON_PER_CONV);
      if (capped.length === 0) continue;

      const now = Date.now();
      const rows: ProfileProposal[] = capped.map((p) => ({
        id: newId(),
        person_id: personId,
        conversation_id: ctx.conversationId,
        field: p.field as ProfileProposal["field"],
        value: p.value,
        op: p.op,
        status: "auto",
        reasoning: p.reasoning,
        created_at: now,
      }));
      await db.profile_proposals.bulkAdd(rows);
    } catch (e) {
      console.warn("[tier2.3] enrich failed for", personId, e);
    }
  }
}

/* -------------------------------------------------------------------------- */
/* 2.4 — Self-introduction detection                                          */
/* -------------------------------------------------------------------------- */

export async function detectIntroductionsAfterStop(
  ctx: Tier2Ctx,
  rediarize: RediarizeAfterStopResult,
): Promise<void> {
  // Cheap pre-filter: use the existing regex-based introduction detector.
  // If it finds zero candidates we skip the LLM call entirely.
  const transcriptForRegex = ctx.segs.map((s) => ({
    text: s.text,
    speaker_label: s.speaker_label,
  }));
  const regexHits = extractIntroducedNames(transcriptForRegex);
  if (regexHits.length === 0) return;

  const profile = await getJamesProfile();
  const jamesName = profile.display_name ?? "James";

  // Build the full transcript for the LLM with current human labels where
  // available.
  const conv = await db.conversations.get(ctx.conversationId);
  const speakerMap = conv?.speaker_map ?? {};
  const personById = new Map<string, Person>();
  for (const pid of Object.values(speakerMap)) {
    const p = await db.people.get(pid);
    if (p) personById.set(p.id, p);
  }
  const fullTranscript = ctx.segs
    .slice()
    .sort((a, b) => a.ts - b.ts)
    .map((s) => {
      const pid = s.person_id ?? speakerMap[s.speaker_label];
      const p = pid ? personById.get(pid) : undefined;
      return { speaker: p ? p.name : s.speaker_label, text: s.text };
    });

  const existing = await db.people.toArray();
  const existingNames = existing.map((p) => p.name);

  let llmRes: Awaited<ReturnType<typeof detectIntroductions>> = {
    introductions: [],
    error: null,
  };
  try {
    llmRes = await detectIntroductions({
      data: {
        transcript: fullTranscript.slice(0, 400),
        existingPeopleNames: existingNames,
        jamesName,
        model: ctx.smartModel,
      },
    });
  } catch (e) {
    console.warn("[tier2.4] detectIntroductions failed", e);
    return;
  }

  const intros = (llmRes.introductions ?? []).filter((i) => i.confidence >= 0.7);
  if (intros.length === 0) return;

  // Build a quick lookup: speaker_label -> aggregate centroid (from this
  // conversation's MFCCs if available).
  const mfccsThisConv = await db.segment_mfccs
    .where("conversation_id")
    .equals(ctx.conversationId)
    .toArray();
  const segIdToLabel = new Map(ctx.segs.map((s) => [s.id, s.speaker_label]));
  const labelCentroids = new Map<string, { sum: number[]; count: number }>();
  for (const m of mfccsThisConv) {
    const lbl = segIdToLabel.get(m.segment_id);
    if (!lbl) continue;
    if (m.mfcc.length !== MFCC_COEFFS) continue;
    const agg = labelCentroids.get(lbl) ?? {
      sum: new Array(MFCC_COEFFS).fill(0),
      count: 0,
    };
    for (let i = 0; i < MFCC_COEFFS; i++) agg.sum[i] += m.mfcc[i];
    agg.count += 1;
    labelCentroids.set(lbl, agg);
  }

  // Process each intro: dedup by first name and by speakerLabel cluster.
  const seenByCluster = new Set<string>();
  let createdAny = false;
  // Sort by confidence desc so highest-confidence intro wins per cluster.
  intros.sort((a, b) => b.confidence - a.confidence);

  // rediarize.cluster_centroids is provided for future-proofing — if a
  // downstream variant of this function wants to align speakerLabel ↔ rediarize
  // cluster, the map is available. Today we use the per-label aggregate above.
  void rediarize;

  for (const intro of intros) {
    const firstName = intro.name.trim().split(/\s+/)[0];
    if (!firstName) continue;
    if (firstName.toLowerCase() === jamesName.toLowerCase()) continue;

    if (seenByCluster.has(intro.speakerLabel)) continue;
    seenByCluster.add(intro.speakerLabel);

    // Build a centroid for this speakerLabel.
    let centroid: number[] | undefined;
    const agg = labelCentroids.get(intro.speakerLabel);
    if (agg && agg.count > 0) {
      centroid = agg.sum.map((v) => v / agg.count);
    }
    if (!centroid) continue; // No voice samples available for this speaker.

    // Check for an existing person with the same first name (case-insensitive).
    const refreshedPeople = await db.people.toArray();
    const matchingPerson = refreshedPeople.find(
      (p) => p.name.trim().split(/\s+/)[0].toLowerCase() === firstName.toLowerCase(),
    );

    const now = Date.now();
    let targetPersonId: string;
    if (matchingPerson) {
      targetPersonId = matchingPerson.id;
    } else {
      // Create a new Person with status "auto".
      targetPersonId = newId();
      const noteLine = `Heard them say: "${intro.quote ?? ""}"`;
      const newPerson: Person = {
        id: targetPersonId,
        name: firstName,
        relationship: intro.relationship || intro.role || undefined,
        notes: noteLine,
        status: "auto",
        created_at: now,
      };
      await db.people.add(newPerson);
      createdAny = true;
    }

    // Write the voiceprint (only if none exists yet for this person).
    const existingVp = await db.voiceprints.get(targetPersonId);
    if (!existingVp) {
      const vp: Voiceprint = {
        id: targetPersonId,
        person_id: targetPersonId,
        centroid: centroid.slice(),
        sample_count: 1,
        updated_at: now,
      };
      await db.voiceprints.put(vp);
    }

    // Record a voiceprint contribution for traceability.
    await db.voiceprint_contributions.add({
      id: newId(),
      person_id: targetPersonId,
      conversation_id: ctx.conversationId,
      source: "auto",
      mfcc: centroid.slice(),
      ts: now,
      preview_text: intro.quote,
    });

    // Backfill transcript_segments.person_id for that speaker label.
    const segsForLabel = await db.transcript_segments
      .where("conversation_id")
      .equals(ctx.conversationId)
      .and((s) => s.speaker_label === intro.speakerLabel)
      .toArray();
    for (const seg of segsForLabel) {
      await db.transcript_segments.update(seg.id, { person_id: targetPersonId });
    }
    // Update the conversation's speaker_map.
    await db.conversations.update(ctx.conversationId, {
      speaker_map: { ...speakerMap, [intro.speakerLabel]: targetPersonId },
    });
    speakerMap[intro.speakerLabel] = targetPersonId;

    if (createdAny) {
      toast.message(`Detected new person: ${firstName} — review in Settings → People`, {
        id: `tier2-intro-${targetPersonId}`,
      });
    }
  }
}
