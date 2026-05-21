import { nanoid } from "nanoid";

import { db, type VoiceSample } from "@/lib/db";
import { encodeEmbedding, rms } from "./utils";
import type { SpeakerEmbedder } from "./embedder";

/**
 * Enroll one sample for a person. Embeds the waveform, writes a
 * VoiceSample row, and returns it. RMS is recorded so we can later filter
 * out near-silent enrollments without consulting the audio again.
 *
 * The caller controls the audio capture (mic, file, segment from VAD).
 * This function does the embed+persist step only.
 */
export async function enrollSample(args: {
  personId: string;
  waveform16k: Float32Array;
  durationSec: number;
  embedder: SpeakerEmbedder;
  source?: VoiceSample["source"];
}): Promise<VoiceSample> {
  const embedding = await args.embedder.embed(args.waveform16k);
  const record: VoiceSample = {
    id: nanoid(),
    personId: args.personId,
    embedding: encodeEmbedding(embedding),
    rms: rms(args.waveform16k),
    durationSec: args.durationSec,
    source: args.source ?? "enrollment",
    createdAt: Date.now(),
  };
  await db().voiceSamples.add(record);
  return record;
}

export async function deleteSample(sampleId: string): Promise<void> {
  await db().voiceSamples.delete(sampleId);
}

export async function deleteAllSamplesForPerson(personId: string): Promise<void> {
  const samples = await db().voiceSamples.where("personId").equals(personId).toArray();
  await db().voiceSamples.bulkDelete(samples.map((s) => s.id));
}
