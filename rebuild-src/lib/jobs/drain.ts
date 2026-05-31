import { db, type LLMProviderId, type PendingJob, type TTSProviderId } from "@/lib/db";
import { makeAI } from "@/lib/ai";
import { getSettingsSnapshot } from "@/lib/settings";
import { updatePersonLexicon } from "@/lib/learning/lexicon-extract";
import { runStyleDistillation } from "@/lib/learning/style-distill";
import { extractMemoriesFromConversation } from "@/lib/learning/memories-extract";
import { rediarizeConversation } from "@/lib/learning/rediarize";
import { rebuildVoiceprintsFromContributions } from "@/lib/learning/voiceprint-rebuild";
import { enrichProfilesFromConversation } from "@/lib/learning/profile-enrich";
import { detectIntroductionsInConversation } from "@/lib/learning/intro-detect";

/**
 * Tier-2 / post-conversation job drainer. Jobs are queued in IndexedDB by
 * `LiveConversation.stop` and replayed here either immediately (the route
 * mounts and calls `drainPendingJobs`) or on the next app open if the tab
 * was closed before they finished.
 *
 * The point of queueing instead of fire-and-forget: a `void Promise.all`
 * call in the cockpit's stop handler gets killed the moment the browser
 * tears the tab down (route change, manual close, OOM). Closing Parley
 * right after tapping Stop would otherwise lose every Tier-2 enrichment.
 * Storing the job descriptor in Dexie first, then running it, means we
 * can resume on the next mount.
 *
 * Each job is idempotent — running it twice produces the same DB state
 * — so the drainer can safely retry. We cap attempts at 3 then mark
 * failed; the operator surfaces failed jobs via the Recent view (later).
 *
 * IMPORTANT: this module is browser-only (it touches Dexie). The cockpit
 * route is the only currently-known caller; the helpers/people routes do
 * not need their own drainer mounts.
 */

const MAX_ATTEMPTS = 3;
const MAX_DRAIN_PASSES = 50;
const SUMMARY_MAX_TRANSCRIPT_CHARS = 12000;

let inflight: Promise<void> | null = null;

export type EnqueueArgs = {
  type: PendingJob["type"];
  conversationId: string;
};

/**
 * Drop a job descriptor into IndexedDB. Called by `LiveConversation.stop`
 * during the synchronous teardown so the descriptor is durable before the
 * mic stream is torn down or the tab navigates.
 */
export async function enqueueJob(args: EnqueueArgs): Promise<void> {
  const now = Date.now();
  const job: PendingJob = {
    id: `${args.type}:${args.conversationId}:${now}`,
    type: args.type,
    conversationId: args.conversationId,
    status: "pending",
    attempts: 0,
    createdAt: now,
    updatedAt: now,
  };
  await db().pendingJobs.put(job);
}

/**
 * Drain every pending and previously-failed-but-not-yet-exhausted job.
 * Single-flight: concurrent callers share one promise so a slow LLM
 * round-trip doesn't fan out into N parallel drains when the user
 * navigates between routes.
 */
export function drainPendingJobs(): Promise<void> {
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const settings = await getSettingsSnapshot();
      // Loop until the queue drains. Re-querying each pass is what stops
      // jobs enqueued *during* a drain — e.g. the cockpit Stop handler
      // firing while a prior drain is still running — from being stranded
      // until the next app mount. Bounded by MAX_DRAIN_PASSES so a job that
      // perpetually re-queues can't spin forever in one drain.
      for (let pass = 0; pass < MAX_DRAIN_PASSES; pass++) {
        const now = Date.now();
        const all = await db().pendingJobs.where("status").equals("pending").toArray();
        const due = all.filter((job) => isDue(job, now));
        if (due.length === 0) break;
        for (const job of due) {
          await runJob(job, settings.llmProvider, settings.ttsProvider);
        }
      }
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

/**
 * A freshly-enqueued job (attempts === 0) is always due. A job that failed
 * and was re-queued as pending waits an exponential backoff window before
 * the next attempt, so a rate-limited provider isn't hammered through all
 * three attempts within the same drain. There's no timer that re-triggers
 * the drain — a not-yet-due job is simply picked up by the next
 * drainPendingJobs() call (next mount, or the next Stop).
 */
function isDue(job: PendingJob, now: number): boolean {
  if (job.attempts <= 0) return true;
  const backoff = Math.min(2 ** job.attempts * 1000, 60_000);
  return now - job.updatedAt >= backoff;
}

async function runJob(
  job: PendingJob,
  llmProvider: LLMProviderId,
  // ttsProvider is here for symmetry with future jobs (e.g. pre-render a
  // summary read-aloud); the summarise job itself doesn't need it.
  _ttsProvider: TTSProviderId,
): Promise<void> {
  if (job.attempts >= MAX_ATTEMPTS) return;

  await db().pendingJobs.update(job.id, {
    status: "running",
    attempts: job.attempts + 1,
    updatedAt: Date.now(),
  });

  try {
    switch (job.type) {
      case "summariseConversation":
        await runSummariseConversation(job, llmProvider);
        // Tier-1 cadence-guarded; runStyleDistillation early-exits if the
        // last run was within 12h. Always safe to call here — keeps the
        // style profile reasonably fresh without a manual rebuild.
        await runStyleDistillation({ force: false });
        break;
      case "updateLexicon":
        await runUpdateLexicon(job, llmProvider);
        break;
      case "rediarize":
        await rediarizeConversation(job.conversationId);
        break;
      case "rebuildVoiceprints": {
        const conv = await db().conversations.get(job.conversationId);
        if (conv && conv.personIds.length > 0) {
          await rebuildVoiceprintsFromContributions({ personIds: conv.personIds });
        }
        break;
      }
      case "enrichProfiles":
        await enrichProfilesFromConversation(job.conversationId);
        break;
      case "distillStyle":
        // Manual rebuild (System tab) sets force=true; passing through here
        // so the user always sees the run happen even if it's within 12h.
        await runStyleDistillation({ force: true });
        break;
      case "extractMemories":
        await extractMemoriesFromConversation(job.conversationId);
        break;
      case "detectIntroductions":
        await detectIntroductionsInConversation(job.conversationId);
        break;
    }

    await db().pendingJobs.update(job.id, {
      status: "done",
      updatedAt: Date.now(),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const exhausted = job.attempts + 1 >= MAX_ATTEMPTS;
    await db().pendingJobs.update(job.id, {
      status: exhausted ? "failed" : "pending",
      lastError: message,
      updatedAt: Date.now(),
    });
    console.warn(`[jobs] ${job.type} ${job.id} ${exhausted ? "failed" : "retry"}: ${message}`);
  }
}

async function runSummariseConversation(
  job: PendingJob,
  llmProvider: LLMProviderId,
): Promise<void> {
  const conv = await db().conversations.get(job.conversationId);
  if (!conv) return;
  // Already done. The Recent page's "Re-summarise" button works around
  // this by clearing `summary` + `highlights` on the conversation row
  // before enqueueing — once that lands the drainer treats the row as
  // un-summarised and re-runs. TODO: replace the clear-then-enqueue
  // dance with an explicit `force?: boolean` flag on EnqueueArgs +
  // PendingJob so the prior summary survives until the new one writes.
  if (conv.summary) return;

  const segments = await db()
    .transcriptSegments.where("conversationId")
    .equals(job.conversationId)
    .toArray();
  if (segments.length === 0) return;

  const ordered = segments.sort((a, b) => a.startedAt - b.startedAt);

  // Resolve personId -> name lookups so the AI sees friendly labels.
  const personIds = Array.from(
    new Set(ordered.map((s) => s.personId).filter((id): id is string => !!id)),
  );
  const people = personIds.length > 0 ? await db().people.bulkGet(personIds) : [];
  const nameById = new Map(
    people.filter((p): p is NonNullable<typeof p> => !!p).map((p) => [p.id, p.name]),
  );

  const transcriptLines = ordered
    .map((s) => {
      const speaker =
        s.speakerKind === "self"
          ? "James"
          : (s.personId && nameById.get(s.personId)) || s.speakerLabel || "Unknown";
      return `${speaker}: ${s.text}`;
    })
    .join("\n");

  // Cap the transcript so we never push past the LLM's context for a
  // long conversation. Trimming the head loses early context, but the
  // last N chars are typically what the summary needs to reflect.
  const truncated =
    transcriptLines.length > SUMMARY_MAX_TRANSCRIPT_CHARS
      ? transcriptLines.slice(-SUMMARY_MAX_TRANSCRIPT_CHARS)
      : transcriptLines;

  const ai = makeAI(llmProvider);
  const result = await ai.summarizeConversation({ transcript: truncated });

  await db().conversations.update(job.conversationId, {
    summary: result.summary,
    highlights: result.highlights,
  });
}

async function runUpdateLexicon(job: PendingJob, llmProvider: LLMProviderId): Promise<void> {
  const conv = await db().conversations.get(job.conversationId);
  if (!conv) return;
  const ai = makeAI(llmProvider);
  await updatePersonLexicon(job.conversationId, ai);
}
