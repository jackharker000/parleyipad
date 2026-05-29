import { nanoid } from "nanoid";

import { db, type StyleDistillRun, type SuggestionLog } from "@/lib/db";
import { makeAI } from "@/lib/ai";
import { getJamesProfile } from "@/lib/jamesProfile";
import { getSettingsSnapshot } from "@/lib/settings";
import { getHelperDraftEvidence, getStyleEvidence } from "@/lib/learning/style-evidence";

/**
 * Tier-1 style distillation job. Pulls recent suggestion + helper-draft
 * evidence and asks the smart-tier LLM to roll it into a typed
 * `StyleProfile` that downstream suggestion prompts inject as part of the
 * cached system block.
 *
 * Cadence-guarded to once per 12h via `styleDistillRuns`. Pass `force: true`
 * to override (the System tab's "re-run" button).
 */

const MIN_INTERVAL_MS = 12 * 60 * 60 * 1000;
const WINDOW_DAYS = 30;
const MAX_SUGGESTION_ROWS = 400;
const MAX_HELPER_ROWS = 200;
const MAX_SAMPLES_CHARS = 30_000;

export type StyleDistillationResult = {
  status: "ok" | "skipped" | "failed";
  samplesUsed: number;
  error?: string;
};

export async function runStyleDistillation(args?: {
  force?: boolean;
}): Promise<StyleDistillationResult> {
  // Cadence guard
  if (!args?.force) {
    const lastRun = await db().styleDistillRuns.orderBy("startedAt").reverse().first();
    if (lastRun && Date.now() - lastRun.startedAt < MIN_INTERVAL_MS) {
      return { status: "skipped", samplesUsed: 0 };
    }
  }

  const runId = nanoid();
  const startedAt = Date.now();
  const runRow: StyleDistillRun = {
    id: runId,
    startedAt,
    samplesUsed: 0,
    status: "ok",
  };
  await db().styleDistillRuns.put(runRow);

  try {
    const since = startedAt - WINDOW_DAYS * 24 * 60 * 60 * 1000;
    const allSuggestionRows = await db().suggestionsLog.where("createdAt").above(since).toArray();
    allSuggestionRows.sort((a, b) => b.createdAt - a.createdAt);
    const suggestionRows = allSuggestionRows.slice(0, MAX_SUGGESTION_ROWS);

    const helperRows = await getHelperDraftEvidence({
      windowDays: WINDOW_DAYS,
      max: MAX_HELPER_ROWS,
    });

    const samples = buildSamples(suggestionRows);
    samples.helperEdits = helperRows
      .filter((r) => r.jamesEdit && r.jamesEdit !== r.recommended)
      .slice(0, 80)
      .map((r) => ({
        platform: r.platform,
        recommended: r.recommended,
        jamesEdit: r.jamesEdit ?? "",
      }));
    truncateSamples(samples, MAX_SAMPLES_CHARS);

    const samplesUsed =
      samples.tappedExamples.length +
      samples.ignoredExamples.length +
      samples.editedExamples.length +
      samples.helperEdits.length;

    // Resolve per-person names on the tapped rows so the model sees
    // friendly labels rather than opaque ids.
    await annotateTappedWithNames(samples, suggestionRows);

    const jamesProfile = await getJamesProfile();
    const previous = await db().styleProfile.get("singleton");
    const settings = await getSettingsSnapshot();
    const ai = makeAI(settings.llmProvider);

    const distilled = await ai.distillStyleProfile({
      samples,
      jamesProfile,
      previous,
    });

    const now = Date.now();
    await db().styleProfile.put({
      id: "singleton",
      preferredOpeners: distilled.preferredOpeners,
      preferredSignOffs: distilled.preferredSignOffs,
      formality: distilled.formality,
      humorMarkers: distilled.humorMarkers,
      tabooPhrases: distilled.tabooPhrases,
      averageSentenceLength: distilled.averageSentenceLength,
      readingGradeEstimate: distilled.readingGradeEstimate,
      categoryPreferenceScores: distilled.categoryPreferenceScores,
      updatedAt: now,
    });

    const summary =
      distilled.summary && distilled.summary.length > 0
        ? firstSentence(distilled.summary)
        : `${samplesUsed} samples distilled`;

    await db().styleDistillRuns.update(runId, {
      endedAt: now,
      samplesUsed,
      summary,
    });

    return { status: "ok", samplesUsed };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await db().styleDistillRuns.update(runId, {
      endedAt: Date.now(),
      status: "failed",
      error: message,
    });
    return { status: "failed", samplesUsed: 0, error: message };
  }
}

function buildSamples(rows: SuggestionLog[]): {
  tappedExamples: Array<{ personName?: string; text: string; category: string; personId?: string }>;
  ignoredExamples: Array<{ text: string; category: string }>;
  editedExamples: Array<{ from: string; to: string }>;
  helperEdits: Array<{ platform: string; recommended: string; jamesEdit: string }>;
} {
  const tapped: Array<{
    personName?: string;
    personId?: string;
    text: string;
    category: string;
  }> = [];
  const ignored: Array<{ text: string; category: string }> = [];
  const edited: Array<{ from: string; to: string }> = [];

  for (const r of rows) {
    if (r.editedTo && r.editedTo.trim() && r.editedTo !== r.text) {
      edited.push({ from: r.text, to: r.editedTo });
    }
    if (r.selected) {
      tapped.push({ personId: r.personId, text: r.text, category: r.category });
    } else if (r.ignored) {
      ignored.push({ text: r.text, category: r.category });
    }
  }

  return {
    tappedExamples: tapped,
    ignoredExamples: ignored,
    editedExamples: edited,
    helperEdits: [],
  };
}

async function annotateTappedWithNames(
  samples: ReturnType<typeof buildSamples>,
  rows: SuggestionLog[],
): Promise<void> {
  const personIds = Array.from(
    new Set(rows.filter((r) => r.selected && r.personId).map((r) => r.personId as string)),
  );
  if (personIds.length === 0) return;
  const people = await db().people.bulkGet(personIds);
  const nameById = new Map(
    people.filter((p): p is NonNullable<typeof p> => !!p).map((p) => [p.id, p.name]),
  );
  for (const t of samples.tappedExamples) {
    if (!t.personId) continue;
    const name = nameById.get(t.personId);
    if (name) t.personName = name;
    delete (t as { personId?: string }).personId;
  }
}

/**
 * Bound the samples blob so a year of dense logs doesn't blow past the
 * prompt budget. We trim the lower-signal channels (ignored first, then
 * tapped) before touching editedExamples / helperEdits which are the
 * highest-quality signal.
 */
function truncateSamples(samples: ReturnType<typeof buildSamples>, maxChars: number): void {
  const size = (): number => JSON.stringify(samples).length;
  const order: Array<keyof typeof samples> = [
    "ignoredExamples",
    "tappedExamples",
    "editedExamples",
    "helperEdits",
  ];
  for (const channel of order) {
    while (size() > maxChars && samples[channel].length > 0) {
      samples[channel].pop();
    }
    if (size() <= maxChars) return;
  }
}

function firstSentence(text: string): string {
  const trimmed = text.trim();
  const match = trimmed.match(/^[^.!?]+[.!?]/);
  return (match ? match[0] : trimmed).slice(0, 200);
}
