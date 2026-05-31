import { db } from "@/lib/db";
import { cosine, decodeEmbedding, encodeEmbedding, l2Normalize } from "@/lib/audio/utils";

/**
 * Tier-2 voiceprint rebuild. For each `personId`, pulls every stored
 * `voiceprintContributions` row plus the corresponding `segmentEmbeddings`
 * the rediarize pass produced, averages them, L2-normalises, and writes
 * the result back to `voiceprints`.
 *
 * Confidence heuristic: mean cosine between every contribution sample and
 * the new centroid, clamped 0..1. Useful as a quick health signal in the
 * People list ("Speaker is well-modelled" vs "low confidence — re-enrol?").
 *
 * Idempotent — running twice with no new contributions produces the same
 * centroid (modulo floating-point).
 */

export type VoiceprintRebuildResult = {
  rebuilt: number;
  error?: string;
};

export async function rebuildVoiceprintsFromContributions(args: {
  personIds: string[];
}): Promise<VoiceprintRebuildResult> {
  try {
    let rebuilt = 0;
    const ids = Array.from(new Set(args.personIds.filter((id) => id && id.length > 0)));
    for (const personId of ids) {
      const ok = await rebuildOne(personId);
      if (ok) rebuilt++;
    }
    return { rebuilt };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { rebuilt: 0, error: message };
  }
}

async function rebuildOne(personId: string): Promise<boolean> {
  const contributions = await db()
    .voiceprintContributions.where("personId")
    .equals(personId)
    .toArray();
  if (contributions.length === 0) return false;

  // Decode each contribution. Some rows may store the embedding directly;
  // others (rediarize-produced rows) reference a stored segmentEmbedding
  // via the same encoded blob, so the decode path is identical.
  const samples: Float32Array[] = [];
  for (const c of contributions) {
    try {
      samples.push(l2Normalize(decodeEmbedding(c.embedding)));
    } catch {
      // skip undecodable
    }
  }
  if (samples.length === 0) return false;

  const dim = samples[0].length;
  const sum = new Float32Array(dim);
  for (const v of samples) {
    if (v.length !== dim) continue;
    for (let i = 0; i < dim; i++) sum[i] += v[i];
  }
  for (let i = 0; i < dim; i++) sum[i] /= samples.length;
  const centroid = l2Normalize(sum);

  // Confidence = mean cosine between each sample and the centroid, clamped.
  let simSum = 0;
  let simCount = 0;
  for (const v of samples) {
    if (v.length !== centroid.length) continue;
    simSum += cosine(v, centroid);
    simCount++;
  }
  const confidence = simCount > 0 ? Math.max(0, Math.min(1, simSum / simCount)) : 0;

  const existing = await db().voiceprints.get(personId);
  if (existing) {
    await db().voiceprints.update(personId, {
      centroid: encodeEmbedding(centroid),
      sampleCount: samples.length,
      confidence,
      updatedAt: Date.now(),
    });
  } else {
    await db().voiceprints.put({
      personId,
      centroid: encodeEmbedding(centroid),
      sampleCount: samples.length,
      confidence,
      updatedAt: Date.now(),
    });
  }
  return true;
}
