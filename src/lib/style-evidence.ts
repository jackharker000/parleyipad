/**
 * Tier 1 — style evidence aggregation.
 *
 * Reads `db.suggestions_log` rows back into a compact, per-person summary
 * the suggestion prompt can use to calibrate length, category and phrasing
 * toward what James actually picks vs. ignores.
 *
 * This module is intentionally pure I/O against Dexie + a small TTL cache —
 * no AI calls. It is read on every suggestion refresh, so the hot path must
 * stay cheap.
 */

import { db, newId, type SuggestionLog } from "./db";

export type StyleEvidencePerPerson = {
  personId: string;
  name: string;
  topCategories: Array<{ category: string; pickRate: number; n: number }>;
  avgLenPicked: number;
  avgLenEdited: number;
  avgWordsAddedOnEdit: number;
  avgWordsRemovedOnEdit: number;
  editFormalityShift: "more_casual" | "more_formal" | "neutral";
  deadPhrases: string[];
  recentPickedSamples: string[]; // last 6
  recentEditedSamples: Array<{ from: string; to: string }>; // last 4
};

export type StyleEvidence = {
  perPerson: StyleEvidencePerPerson[];
  global: {
    avgLenPicked: number;
    topPickedCategories: Array<{ category: string; pickRate: number }>;
  };
};

const DEFAULT_LIMIT = 50;
const DEFAULT_LOOKBACK_MS = 60 * 24 * 3600 * 1000; // 60 days
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 min

/**
 * Compute a stable cache key from a list of personIds. Sorted so the cache
 * is order-independent.
 */
function cacheKeyFor(personIds: string[]): string {
  return [...personIds].sort().join(",") || "__none__";
}

function wordsOf(s: string | undefined | null): string[] {
  if (!s) return [];
  return s.trim().split(/\s+/).filter(Boolean);
}

function countContractions(s: string): number {
  // Rough proxy: contractions and informal markers correlate with casual tone.
  const re = /'(s|re|ve|ll|d|t|m)\b|\bn't\b/gi;
  const m = s.match(re);
  return m ? m.length : 0;
}

function avgWordLen(words: string[]): number {
  if (!words.length) return 0;
  let total = 0;
  for (const w of words) total += w.length;
  return total / words.length;
}

function classifyEditShift(
  text: string,
  editedTo: string,
): "more_casual" | "more_formal" | "neutral" {
  const cFrom = countContractions(text);
  const cTo = countContractions(editedTo);
  const wFrom = avgWordLen(wordsOf(text));
  const wTo = avgWordLen(wordsOf(editedTo));
  // More contractions or shorter words => casual; fewer contractions or
  // longer words => formal. Require a small margin to avoid noise.
  if (cTo > cFrom + 0.5 || wFrom - wTo > 0.5) return "more_casual";
  if (cTo + 0.5 < cFrom || wTo - wFrom > 0.5) return "more_formal";
  return "neutral";
}

function summarizePerson(
  personId: string,
  name: string,
  rows: SuggestionLog[],
): StyleEvidencePerPerson {
  // Bucket by category (only count rows where the suggestion was shown).
  const byCat = new Map<string, { picks: number; shown: number }>();
  for (const r of rows) {
    const cat = r.category || "answer";
    const b = byCat.get(cat) ?? { picks: 0, shown: 0 };
    b.shown += 1;
    if (r.selected) b.picks += 1;
    byCat.set(cat, b);
  }
  const topCategories: StyleEvidencePerPerson["topCategories"] = [...byCat.entries()]
    .filter(([, b]) => b.shown >= 3)
    .map(([category, b]) => ({
      category,
      pickRate: b.shown === 0 ? 0 : b.picks / b.shown,
      n: b.shown,
    }))
    .sort((a, b) => b.pickRate - a.pickRate)
    .slice(0, 4);

  // Picked length stats
  const picked = rows.filter((r) => r.selected);
  const avgLenPicked = picked.length
    ? Math.round(picked.reduce((a, r) => a + (r.text?.length ?? 0), 0) / picked.length)
    : 0;

  // Edit stats
  const edited = rows.filter((r) => r.edited_to && r.edited_to !== r.text);
  const avgLenEdited = edited.length
    ? Math.round(edited.reduce((a, r) => a + (r.edited_to?.length ?? 0), 0) / edited.length)
    : 0;

  let addedTotal = 0;
  let removedTotal = 0;
  let shiftCasual = 0;
  let shiftFormal = 0;
  for (const r of edited) {
    const fromWs = new Set(wordsOf(r.text).map((w) => w.toLowerCase()));
    const toWs = new Set(wordsOf(r.edited_to).map((w) => w.toLowerCase()));
    let added = 0;
    let removed = 0;
    for (const w of toWs) if (!fromWs.has(w)) added += 1;
    for (const w of fromWs) if (!toWs.has(w)) removed += 1;
    addedTotal += added;
    removedTotal += removed;
    const shift = classifyEditShift(r.text, r.edited_to!);
    if (shift === "more_casual") shiftCasual += 1;
    else if (shift === "more_formal") shiftFormal += 1;
  }
  const avgWordsAddedOnEdit = edited.length ? +(addedTotal / edited.length).toFixed(1) : 0;
  const avgWordsRemovedOnEdit = edited.length ? +(removedTotal / edited.length).toFixed(1) : 0;
  let editFormalityShift: StyleEvidencePerPerson["editFormalityShift"] = "neutral";
  if (shiftCasual > shiftFormal && shiftCasual >= 2) editFormalityShift = "more_casual";
  else if (shiftFormal > shiftCasual && shiftFormal >= 2) editFormalityShift = "more_formal";

  // Dead phrases: same text shown >=3 times AND never selected.
  const byText = new Map<string, { count: number; sampleText: string; everSelected: boolean }>();
  for (const r of rows) {
    const k = (r.text ?? "").trim().toLowerCase();
    if (!k) continue;
    const e = byText.get(k) ?? { count: 0, sampleText: r.text, everSelected: false };
    e.count += 1;
    if (r.selected) e.everSelected = true;
    byText.set(k, e);
  }
  const deadPhrases = [...byText.values()]
    .filter((e) => e.count >= 3 && !e.everSelected)
    .sort((a, b) => b.sampleText.length - a.sampleText.length) // longest first
    .slice(0, 12)
    .map((e) => e.sampleText);

  // Recent samples
  const sortedNewest = [...rows].sort((a, b) => b.shown_at - a.shown_at);
  const recentPickedSamples = sortedNewest
    .filter((r) => r.selected)
    .slice(0, 6)
    .map((r) => r.text);
  const recentEditedSamples = sortedNewest
    .filter((r) => r.edited_to && r.edited_to !== r.text)
    .slice(0, 4)
    .map((r) => ({ from: r.text, to: r.edited_to! }));

  return {
    personId,
    name,
    topCategories,
    avgLenPicked,
    avgLenEdited,
    avgWordsAddedOnEdit,
    avgWordsRemovedOnEdit,
    editFormalityShift,
    deadPhrases,
    recentPickedSamples,
    recentEditedSamples,
  };
}

/**
 * Compute style evidence for the people currently in the conversation.
 *
 * Caps inputs aggressively to keep token budget bounded:
 *  - last `limit` log rows per person (default 50)
 *  - rows within `lookbackMs` (default 60 days)
 *  - first 6 people only
 */
export async function getStyleEvidence(
  personIds: string[],
  opts?: { limit?: number; lookbackMs?: number },
): Promise<StyleEvidence> {
  const limit = opts?.limit ?? DEFAULT_LIMIT;
  const lookbackMs = opts?.lookbackMs ?? DEFAULT_LOOKBACK_MS;
  const ids = personIds.slice(0, 6);

  // TTL cache lookup
  const key = cacheKeyFor(ids);
  const cached = await db.style_evidence_cache.get(key);
  if (cached && Date.now() - cached.computed_at < CACHE_TTL_MS) {
    try {
      return JSON.parse(cached.json) as StyleEvidence;
    } catch {
      // fall through and recompute
    }
  }

  const cutoff = Date.now() - lookbackMs;
  const people = ids.length ? await db.people.bulkGet(ids) : [];
  const personById = new Map(
    people.filter((p): p is NonNullable<typeof p> => !!p).map((p) => [p.id, p] as const),
  );

  // Pull rows per person and trim to `limit` newest after the lookback filter.
  const perPerson: StyleEvidencePerPerson[] = [];
  for (const pid of ids) {
    const rowsRaw = await db.suggestions_log
      .where("person_id")
      .equals(pid)
      .reverse()
      .sortBy("shown_at");
    const rows = rowsRaw.filter((r) => r.shown_at >= cutoff).slice(0, limit);
    const name = personById.get(pid)?.name ?? "this person";
    perPerson.push(summarizePerson(pid, name, rows));
  }

  // Global stats across the same lookback window, capped to a sane row count.
  const globalRows = await db.suggestions_log
    .where("shown_at")
    .above(cutoff)
    .reverse()
    .sortBy("shown_at");
  const globalCapped = globalRows.slice(0, 600);
  const globalPicked = globalCapped.filter((r) => r.selected);
  const globalAvgLenPicked = globalPicked.length
    ? Math.round(globalPicked.reduce((a, r) => a + (r.text?.length ?? 0), 0) / globalPicked.length)
    : 0;
  const globalByCat = new Map<string, { picks: number; shown: number }>();
  for (const r of globalCapped) {
    const cat = r.category || "answer";
    const b = globalByCat.get(cat) ?? { picks: 0, shown: 0 };
    b.shown += 1;
    if (r.selected) b.picks += 1;
    globalByCat.set(cat, b);
  }
  const topPickedCategories = [...globalByCat.entries()]
    .filter(([, b]) => b.shown >= 5)
    .map(([category, b]) => ({ category, pickRate: b.picks / b.shown }))
    .sort((a, b) => b.pickRate - a.pickRate)
    .slice(0, 4);

  const result: StyleEvidence = {
    perPerson,
    global: {
      avgLenPicked: globalAvgLenPicked,
      topPickedCategories,
    },
  };

  // Write through TTL cache. `id` is the cache key (sorted personIds).
  try {
    await db.style_evidence_cache.put({
      id: key,
      person_id: ids[0] ?? "",
      computed_at: Date.now(),
      json: JSON.stringify(result),
    });
  } catch {
    // Cache failures are non-fatal — we can always recompute next call.
  }
  return result;
}

/** Drop cached style evidence so the next call recomputes. */
export async function invalidateStyleEvidence(personIds?: string[]): Promise<void> {
  if (!personIds) {
    await db.style_evidence_cache.clear();
    return;
  }
  await db.style_evidence_cache.delete(cacheKeyFor(personIds.slice(0, 6)));
}

/* === Tier 1.3: cross-session dead phrases ================================ */

/**
 * Return canonical-cased texts that were shown >=N times to the given people
 * and ignored every time within the lookback window. Used to extend the
 * `alreadyShown` list in the suggestion prompt so the model stops re-emitting
 * suggestions James has consistently passed over across sessions.
 *
 * Texts that were ever `selected===true` in the lookback are never returned,
 * even if their ignore count also crosses the threshold — picks beat misses.
 */
export async function getCrossSessionDeadPhrases(
  personIds: string[],
  opts?: { lookbackMs?: number; minIgnoredCount?: number; max?: number },
): Promise<string[]> {
  const lookbackMs = opts?.lookbackMs ?? 7 * 24 * 3600 * 1000;
  const minIgnoredCount = opts?.minIgnoredCount ?? 3;
  const max = opts?.max ?? 40;
  const cutoff = Date.now() - lookbackMs;
  const ids = personIds.slice(0, 6);
  if (ids.length === 0) return [];

  const rows = await db.suggestions_log.where("person_id").anyOf(ids).toArray();

  type Acc = {
    count: number;
    everSelected: boolean;
    canonical: string; // most-recent original-cased variant
    lastShown: number;
  };
  const grouped = new Map<string, Acc>();
  for (const r of rows) {
    if (r.shown_at < cutoff) continue;
    if (!r.text) continue;
    const k = r.text.trim().toLowerCase();
    if (!k) continue;
    const a = grouped.get(k) ?? {
      count: 0,
      everSelected: false,
      canonical: r.text,
      lastShown: 0,
    };
    if (r.selected) a.everSelected = true;
    if (r.ignored && !r.selected) a.count += 1;
    if (r.shown_at >= a.lastShown) {
      a.lastShown = r.shown_at;
      a.canonical = r.text;
    }
    grouped.set(k, a);
  }

  return [...grouped.values()]
    .filter((a) => !a.everSelected && a.count >= minIgnoredCount)
    .sort((a, b) => b.count - a.count)
    .slice(0, max)
    .map((a) => a.canonical);
}

/* === Tier 1: helpers used at log-write time ============================== */

/**
 * Build a `SuggestionLog` row for a freshly emitted suggestion. Centralized
 * so the caller does not have to repeat the boilerplate.
 */
export function buildSuggestionLogRow(args: {
  conversation_id: string;
  text: string;
  category: string;
  source: string;
  person_id?: string;
  shown_at?: number;
}): SuggestionLog {
  return {
    id: newId(),
    conversation_id: args.conversation_id,
    text: args.text,
    category: args.category,
    source: args.source,
    shown_at: args.shown_at ?? Date.now(),
    selected: false,
    ignored: false,
    spoken: false,
    person_id: args.person_id,
  };
}
