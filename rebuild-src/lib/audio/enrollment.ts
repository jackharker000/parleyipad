import { nanoid } from "nanoid";

import { db, type Voiceprint, type VoiceprintContribution } from "@/lib/db";
import { decodeEmbedding, encodeEmbedding, l2Normalize, rms } from "./utils";
import type { SpeakerEmbedder } from "./embedder";

/**
 * Enroll one sample for a person. Embeds the waveform, appends a
 * VoiceprintContribution, and folds the new embedding into the person's
 * Voiceprint centroid via running mean — so the matcher reads a single,
 * already-aggregated centroid per person at runtime.
 *
 * The caller controls the audio capture (mic, file, segment from VAD).
 * This function does the embed + persist step only.
 */
export async function enrollSample(args: {
  personId: string;
  waveform16k: Float32Array;
  durationSec: number;
  embedder: SpeakerEmbedder;
  source?: VoiceprintContribution["source"];
  conversationId?: string;
  previewText?: string;
}): Promise<VoiceprintContribution> {
  const embedding = await args.embedder.embed(args.waveform16k);
  const sampleRms = rms(args.waveform16k);
  const now = Date.now();

  const contribution: VoiceprintContribution = {
    id: nanoid(),
    personId: args.personId,
    embedding: encodeEmbedding(embedding),
    conversationId: args.conversationId,
    source: args.source ?? "enrollment",
    previewText: args.previewText,
    rms: sampleRms,
    durationSec: args.durationSec,
    createdAt: now,
  };

  await db().transaction("rw", db().voiceprintContributions, db().voiceprints, async () => {
    await db().voiceprintContributions.add(contribution);
    const existing = await db().voiceprints.get(args.personId);
    const updated = foldIntoCentroid(args.personId, existing, embedding, now);
    await db().voiceprints.put(updated);
  });

  return contribution;
}

function foldIntoCentroid(
  personId: string,
  existing: Voiceprint | undefined,
  embedding: Float32Array,
  now: number,
): Voiceprint {
  if (!existing) {
    return {
      personId,
      centroid: encodeEmbedding(l2Normalize(embedding)),
      sampleCount: 1,
      updatedAt: now,
    };
  }
  const prev = decodeEmbedding(existing.centroid);
  const dim = Math.min(prev.length, embedding.length);
  const next = new Float32Array(dim);
  const n = existing.sampleCount;
  for (let i = 0; i < dim; i++) {
    next[i] = (prev[i] * n + embedding[i]) / (n + 1);
  }
  return {
    personId,
    centroid: encodeEmbedding(l2Normalize(next)),
    sampleCount: n + 1,
    confidence: existing.confidence,
    subCentroids: existing.subCentroids,
    updatedAt: now,
  };
}

export async function deleteContribution(id: string): Promise<void> {
  const c = await db().voiceprintContributions.get(id);
  if (!c) return;
  await db().voiceprintContributions.delete(id);
  await recomputeVoiceprint(c.personId);
}

/**
 * Rebuild a person's centroid from all stored contributions. Used by the
 * Tier-2 re-cluster pipeline and by `deleteContribution`.
 */
export async function recomputeVoiceprint(personId: string): Promise<void> {
  const samples = await db().voiceprintContributions.where("personId").equals(personId).toArray();
  if (samples.length === 0) {
    await db().voiceprints.delete(personId);
    return;
  }
  const vectors = samples.map((s) => decodeEmbedding(s.embedding));
  const dim = vectors[0].length;
  const sum = new Float32Array(dim);
  for (const v of vectors) {
    for (let i = 0; i < dim; i++) sum[i] += v[i];
  }
  for (let i = 0; i < dim; i++) sum[i] /= vectors.length;
  const centroid = l2Normalize(sum);
  await db().voiceprints.put({
    personId,
    centroid: encodeEmbedding(centroid),
    sampleCount: samples.length,
    updatedAt: Date.now(),
  });
}

export async function deleteAllContributionsForPerson(personId: string): Promise<void> {
  const samples = await db().voiceprintContributions.where("personId").equals(personId).toArray();
  await db().voiceprintContributions.bulkDelete(samples.map((s) => s.id));
  await db().voiceprints.delete(personId);
}

/**
 * Hard reset for the spike: drop every person, every voiceprint, every
 * contribution. Lets the user wipe a session's enrolments in one tap so
 * they can re-enrol cleanly without picking through the per-person delete.
 */
export async function resetAllEnrolments(): Promise<void> {
  await db().transaction(
    "rw",
    db().people,
    db().voiceprints,
    db().voiceprintContributions,
    async () => {
      await db().voiceprintContributions.clear();
      await db().voiceprints.clear();
      await db().people.clear();
    },
  );
}
