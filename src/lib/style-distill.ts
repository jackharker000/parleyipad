/**
 * Tier 1.2 — periodic distillation of `suggestions_log` into a structured
 * style profile.
 *
 * Each Stop or manual trigger pulls the last ~30 days of picks/edits/ignored
 * suggestions, asks the smart-tier LLM to roll them up into a compact
 * `StyleProfileJson`, and writes the result to `style_profile.singleton`.
 *
 * Cadence is gated so we never distil more than once per 12 hours unless
 * `force` is set. Failures are logged but never thrown — distillation is
 * strictly best-effort polish on top of the live style-evidence loop.
 */

import { db, getJamesProfile, getSettings, newId, type StyleProfileJson } from "./db";
import { distillStyleProfile } from "./aac.functions";

const MIN_INTERVAL_MS = 12 * 60 * 60 * 1000; // 12 h
const WINDOW_DAYS = 30;
const MAX_SAMPLES = 800;
const MIN_SAMPLES = 20;

export type RunStyleDistillationOptions = {
  /** Force a run even if we already ran in the last 12 h. */
  force?: boolean;
};

/**
 * Distil the recent suggestion log into a style profile. Safe to call from
 * any handler — returns silently if cadence isn't due or there aren't
 * enough samples yet.
 */
export async function runStyleDistillation(opts?: RunStyleDistillationOptions): Promise<void> {
  try {
    if (typeof window === "undefined") return;

    // Cadence guard
    if (!opts?.force) {
      const lastRun = await db.style_distill_runs.orderBy("ran_at").reverse().first();
      if (lastRun && Date.now() - lastRun.ran_at < MIN_INTERVAL_MS) {
        return;
      }
    }

    const cutoff = Date.now() - WINDOW_DAYS * 24 * 3600 * 1000;
    const rawRows = await db.suggestions_log
      .where("shown_at")
      .above(cutoff)
      .reverse()
      .sortBy("shown_at");
    const rows = rawRows.slice(0, MAX_SAMPLES);

    if (rows.length < MIN_SAMPLES) {
      await db.style_distill_runs.add({
        id: newId(),
        ran_at: Date.now(),
        conversations_seen: 0,
        samples_used: rows.length,
        ok: false,
        error: "insufficient samples",
      });
      return;
    }

    // Build a quick personId → name map for the few people in this window.
    const personIds = Array.from(
      new Set(rows.map((r) => r.person_id).filter((v): v is string => !!v)),
    );
    const people = personIds.length ? await db.people.bulkGet(personIds) : [];
    const nameById = new Map(
      people.filter((p): p is NonNullable<typeof p> => !!p).map((p) => [p.id, p.name] as const),
    );

    const samples = rows.map((r) => ({
      shown: r.text,
      edited_to: r.edited_to && r.edited_to !== r.text ? r.edited_to : undefined,
      selected: r.selected,
      ignored: !!r.ignored,
      category: r.category || "answer",
      person_name: r.person_id ? nameById.get(r.person_id) : undefined,
    }));

    const conversationsSeen = new Set(rows.map((r) => r.conversation_id)).size;

    const profileRow = await getJamesProfile();
    const prior = await db.style_profile.get("singleton");
    const settings = await getSettings().catch(() => undefined);

    const res = await distillStyleProfile({
      data: {
        samples,
        jamesProfile: {
          name: profileRow.display_name || "James",
          background: profileRow.background,
          personality: profileRow.personality,
          humor: profileRow.humor_style,
          communication: profileRow.communication_style,
          topicsLoved: profileRow.topics_loved,
          topicsAvoided: profileRow.topics_avoided,
          signaturePhrases: profileRow.signature_phrases
            ?.split(/\r?\n/)
            .map((s) => s.trim())
            .filter(Boolean),
          currentLifeContext: profileRow.current_life_context,
          freeform: profileRow.freeform_notes,
        },
        previous: prior?.json,
        model: settings?.smart_model,
        windowDays: WINDOW_DAYS,
      },
    });

    if (res.error || !res.profile) {
      await db.style_distill_runs.add({
        id: newId(),
        ran_at: Date.now(),
        conversations_seen: conversationsSeen,
        samples_used: rows.length,
        ok: false,
        error: res.error ?? "no profile",
      });
      return;
    }

    const distilled = res.profile as Omit<
      StyleProfileJson,
      "version" | "generated_at" | "source_window_days" | "source_sample_count"
    >;
    const profile: StyleProfileJson = {
      version: 1,
      generated_at: Date.now(),
      source_window_days: WINDOW_DAYS,
      source_sample_count: rows.length,
      preferred_openers: distilled.preferred_openers ?? [],
      preferred_signoffs: distilled.preferred_signoffs ?? [],
      formality: distilled.formality ?? "neutral",
      formality_score: distilled.formality_score ?? 0.5,
      humor_markers: distilled.humor_markers ?? [],
      taboo_phrases: distilled.taboo_phrases ?? [],
      avg_sentence_length_words: distilled.avg_sentence_length_words ?? 0,
      reading_grade_estimate: distilled.reading_grade_estimate ?? 0,
      category_preference: distilled.category_preference ?? {},
      notes: distilled.notes ?? "",
    };

    await db.style_profile.put({
      id: "singleton",
      updated_at: Date.now(),
      json: JSON.stringify(profile),
    });
    await db.style_distill_runs.add({
      id: newId(),
      ran_at: Date.now(),
      conversations_seen: conversationsSeen,
      samples_used: rows.length,
      ok: true,
    });
  } catch (e) {
    console.warn("style distill failed", e);
    try {
      await db.style_distill_runs.add({
        id: newId(),
        ran_at: Date.now(),
        conversations_seen: 0,
        samples_used: 0,
        ok: false,
        error: (e as Error)?.message ?? "unknown",
      });
    } catch {
      // ignore secondary failure
    }
  }
}
