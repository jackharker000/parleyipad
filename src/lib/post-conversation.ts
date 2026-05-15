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

import { db, getJamesProfile, type Person, type TranscriptSegment, MFCC_COEFFS } from "./db";
import { cosineSim } from "./voiceprint";
import { kmeansRediarize, type UtteranceVec } from "./rediarize";
import { aiRediarizeTieBreaker } from "./aac.functions";
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
/* 2.2 / 2.3 / 2.4 stubs — implementations land in subsequent feature commits.*/
/* -------------------------------------------------------------------------- */

export async function rebuildVoiceprintsAfterStop(_ctx: Tier2Ctx): Promise<void> {
  /* Implemented in 2.2 commit. */
}

export async function enrichProfilesAfterStop(_ctx: Tier2Ctx): Promise<void> {
  /* Implemented in 2.3 commit. */
}

export async function detectIntroductionsAfterStop(
  _ctx: Tier2Ctx,
  _rediarize: RediarizeAfterStopResult,
): Promise<void> {
  /* Implemented in 2.4 commit. */
}
