import { nanoid } from "nanoid";

import { cosine, l2Normalize } from "./utils";

/**
 * Online speaker diarizer — clusters utterances as they arrive, with no
 * prior enrolment. Used by the spike's "diarization" mode to validate
 * that the embedder actually discriminates voices without needing real
 * humans pre-registered.
 *
 * Algorithm: for each incoming embedding, find the most-similar existing
 * cluster centroid. If its cosine similarity clears `threshold`, fold the
 * embedding into that cluster (running mean, re-normalized). Otherwise
 * spawn a new cluster labelled "Speaker A", "Speaker B", …
 *
 * Not state-of-the-art. Doesn't merge clusters that drift together,
 * doesn't handle overlap, doesn't re-cluster with hindsight. Good enough
 * to verify the embedder discriminates two real voices in the room.
 */
export class OnlineDiarizer {
  private clusters: DiarCluster[] = [];
  private nextLetterCode = 65; // 'A'
  private threshold: number;

  constructor(threshold = 0.7) {
    this.threshold = threshold;
  }

  setThreshold(threshold: number): void {
    this.threshold = threshold;
  }

  assign(embedding: Float32Array): DiarAssignment {
    if (this.clusters.length === 0) {
      const cluster = this.createCluster(embedding);
      return { cluster, similarity: 1, isNew: true, ranked: [{ cluster, similarity: 1 }] };
    }

    const ranked = this.clusters
      .map((cluster) => ({ cluster, similarity: cosine(embedding, cluster.centroid) }))
      .sort((a, b) => b.similarity - a.similarity);

    const top = ranked[0];
    if (top.similarity >= this.threshold) {
      this.updateCentroid(top.cluster, embedding);
      return { cluster: top.cluster, similarity: top.similarity, isNew: false, ranked };
    }

    const cluster = this.createCluster(embedding);
    return {
      cluster,
      similarity: 1,
      isNew: true,
      ranked: [{ cluster, similarity: 1 }, ...ranked],
    };
  }

  rename(clusterId: string, label: string): void {
    const cluster = this.clusters.find((c) => c.id === clusterId);
    if (cluster) cluster.label = label;
  }

  reset(): void {
    this.clusters = [];
    this.nextLetterCode = 65;
  }

  getClusters(): DiarCluster[] {
    // Defensive copy so callers can't mutate centroids.
    return this.clusters.map((c) => ({ ...c, centroid: new Float32Array(c.centroid) }));
  }

  private createCluster(embedding: Float32Array): DiarCluster {
    const letter = String.fromCharCode(this.nextLetterCode++);
    const cluster: DiarCluster = {
      id: nanoid(),
      label: `Speaker ${letter}`,
      centroid: l2Normalize(embedding),
      sampleCount: 1,
    };
    this.clusters.push(cluster);
    return cluster;
  }

  private updateCentroid(cluster: DiarCluster, embedding: Float32Array): void {
    const n = cluster.sampleCount;
    const dim = cluster.centroid.length;
    const next = new Float32Array(dim);
    for (let i = 0; i < dim; i++) {
      next[i] = (cluster.centroid[i] * n + embedding[i]) / (n + 1);
    }
    cluster.centroid = l2Normalize(next);
    cluster.sampleCount = n + 1;
  }
}

export type DiarCluster = {
  id: string;
  label: string;
  centroid: Float32Array;
  sampleCount: number;
};

export type DiarAssignment = {
  cluster: DiarCluster;
  similarity: number;
  isNew: boolean;
  /** All clusters ranked by similarity for this assignment, top first. */
  ranked: { cluster: DiarCluster; similarity: number }[];
};
