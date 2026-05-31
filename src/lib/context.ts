import { db, getJamesProfile, type EventItem, type Person, type Place } from "./db";
import { getStyleEvidence, type StyleEvidence } from "./style-evidence";
import { formatMemoryForPrompt, retrieveTopK } from "./retrieval";

export type ConversationContext = {
  jamesProfile: {
    name: string;
    background?: string;
    personality?: string;
    humor?: string;
    communication?: string;
    topicsLoved?: string;
    topicsAvoided?: string;
    signaturePhrases?: string[];
    currentLifeContext?: string;
    freeform?: string;
  };
  people: Array<{
    name: string;
    relationship?: string;
    interests?: string[];
    notes?: string;
    style_notes?: string;
    recentMemories: string[]; // most recent memory texts about this person
    followUps: string[]; // unused follow-ups for this person
  }>;
  place?: {
    name: string;
    notes?: string;
    recentMemories: string[];
    followUps: string[];
  };
  event?: {
    name: string;
    when?: string;
    location?: string;
    keyInfo?: string;
    peopleNames: string[];
    selectedKeyPoints: string[];
    selectedKeyQuestions: string[];
    docs: string[]; // formatted doc snippets
  };
  styleProfileJson?: string;
  /** Cross-conversation voice learning — real lines James has actually spoken
   *  in PAST conversations (prioritising ones with the present people), so the
   *  suggestion + expand prompts can mirror his genuine phrasing. */
  jamesVoiceSamples?: string[];
  /** Preference learning — compact records of past suggestion decisions
   *  (picked vs. passed over, or typed-his-own). Feeds the suggestion prompt. */
  choiceMemories?: string[];
  // === Tier 1: feedback loop ===
  /** Aggregated per-person picks / edits / dead phrases, used to calibrate
   *  the suggestion prompt. Populated by `buildConversationContext`. */
  styleEvidence?: StyleEvidence;
  /** Tier 3.1 — semantically-retrieved memory snippets across all scopes,
   *  populated only when `queryEmbedding` was supplied. The route passes
   *  this verbatim to the suggestion prompt as a top-level block. */
  retrievedMemories?: string[];
};

const RECENT_MEMORY_LIMIT = 4;
const FOLLOW_UP_LIMIT = 3;

// Session-scoped memo cache: stable parts of the context (people, place, event,
// profile) rarely change within a conversation, so we skip re-querying IndexedDB
// on every suggestion refresh unless the participant/place/event set changes.
type CtxCacheEntry = {
  fingerprint: string;
  context: ConversationContext;
  builtAt: number;
};
let _ctxCache: CtxCacheEntry | null = null;
const CTX_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

/** Invalidate the context cache — call after profile or memory edits. */
export function invalidateContextCache() {
  _ctxCache = null;
  _scanMemo.clear();
}

export async function suggestPeopleAtPlace(placeId: string, limit = 6): Promise<Person[]> {
  const convs = await db.conversations.where("place_id").equals(placeId).toArray();
  const counts = new Map<string, number>();
  for (const c of convs) {
    for (const pid of c.person_ids ?? []) {
      counts.set(pid, (counts.get(pid) ?? 0) + 1);
    }
  }
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit);
  const people = await db.people.bulkGet(sorted.map(([id]) => id));
  return people.filter((p): p is Person => !!p);
}

/**
 * Resolve the person IDs the active place and event are associated with, for
 * the speaker-ID context prior (people likely to be in the room get a gentle
 * likelihood boost). Read-only and fail-soft — any error yields empty arrays
 * so the live matcher simply falls back to pure-voice matching.
 *
 * - Place: there is no explicit roster on a Place, so we infer it from past
 *   conversations held there (same signal as `suggestPeopleAtPlace`).
 * - Event: people are declared directly on `event.person_ids`.
 */
export async function getContextPriorPersonIds(opts: {
  place?: Place;
  event?: EventItem;
  /** Cap on inferred place attendees (most-frequent first). */
  placeLimit?: number;
}): Promise<{ placePersonIds: string[]; eventPersonIds: string[] }> {
  let placePersonIds: string[] = [];
  let eventPersonIds: string[] = [];
  try {
    if (opts.place) {
      const people = await suggestPeopleAtPlace(opts.place.id, opts.placeLimit ?? 8);
      placePersonIds = people.map((p) => p.id);
    }
  } catch (err) {
    console.warn("[context] place prior lookup failed", err);
  }
  try {
    if (opts.event) eventPersonIds = [...(opts.event.person_ids ?? [])];
  } catch {
    eventPersonIds = [];
  }
  return { placePersonIds, eventPersonIds };
}

async function memoriesForPerson(
  personId: string,
  queryEmbedding?: number[],
  queryModel?: string,
): Promise<string[]> {
  // Tier 3.1 — when we have a query embedding, prefer semantic top-K
  // (with recency fallback inside retrieveTopK). Otherwise keep the
  // original behaviour of "most recent N".
  if (queryEmbedding && queryEmbedding.length > 0) {
    const top = await retrieveTopK({
      queryEmbedding,
      queryModel,
      personId,
      k: RECENT_MEMORY_LIMIT,
    });
    return top.map(formatMemoryForPrompt);
  }
  const mems = await db.memories.where("person_id").equals(personId).reverse().sortBy("created_at");
  return mems
    .filter((m) => m.status !== "hidden")
    .slice(0, RECENT_MEMORY_LIMIT)
    .map((m) => `[${m.kind}] ${m.text}`);
}

async function followUpsForPerson(personId: string): Promise<string[]> {
  const fs = await db.follow_ups
    .where("for_person_id")
    .equals(personId)
    .reverse()
    .sortBy("created_at");
  return fs
    .filter((f) => !f.used)
    .slice(0, FOLLOW_UP_LIMIT)
    .map((f) => f.text);
}

const PERSON_DOC_PER = 3000;
const PERSON_DOC_TOTAL = 9000;
async function notesWithDocsForPerson(
  personId: string,
  baseNotes: string | undefined,
): Promise<string | undefined> {
  const docs = await db.person_documents.where("person_id").equals(personId).toArray();
  if (!docs.length) return baseNotes;
  let block = "";
  let used = 0;
  for (const d of docs) {
    const remaining = PERSON_DOC_TOTAL - used;
    if (remaining <= 200) break;
    const slice = (d.text ?? "").slice(0, Math.min(PERSON_DOC_PER, remaining));
    if (!slice.trim()) continue;
    block += `\n\n## Document: ${d.name}${d.note ? ` — ${d.note}` : ""}\n${slice}`;
    used += slice.length;
  }
  if (!block.trim()) return baseNotes;
  return [baseNotes ?? "", `Background documents:${block}`].filter(Boolean).join("\n\n");
}

async function memoriesForPlace(
  placeId: string,
  presentPersonIds: Set<string>,
  queryEmbedding?: number[],
  queryModel?: string,
): Promise<string[]> {
  if (queryEmbedding && queryEmbedding.length > 0) {
    const top = await retrieveTopK({
      queryEmbedding,
      queryModel,
      placeId,
      presentPersonIds,
      k: RECENT_MEMORY_LIMIT,
    });
    return top.map(formatMemoryForPrompt);
  }
  const mems = await db.memories.where("place_id").equals(placeId).reverse().sortBy("created_at");
  return (
    mems
      .filter((m) => m.status !== "hidden")
      // Privacy: skip place memories tied to a specific person who is NOT in
      // this conversation. Generic place memories (no person_id) are kept.
      .filter((m) => !m.person_id || presentPersonIds.has(m.person_id))
      .slice(0, RECENT_MEMORY_LIMIT)
      .map((m) => `[${m.kind}] ${m.text}`)
  );
}

async function followUpsForPlace(
  placeId: string,
  presentPersonIds: Set<string>,
): Promise<string[]> {
  const fs = await db.follow_ups
    .where("for_place_id")
    .equals(placeId)
    .reverse()
    .sortBy("created_at");
  return fs
    .filter((f) => !f.used)
    .filter((f) => !f.for_person_id || presentPersonIds.has(f.for_person_id))
    .slice(0, FOLLOW_UP_LIMIT)
    .map((f) => f.text);
}

/** Label every line James speaks via TTS is recorded under (see cockpit). */
const JAMES_SELF_LABEL = "__james_self__";

/** Quick phrases + safety phrases carry no style signal — exclude from samples. */
const VOICE_SAMPLE_STOPWORDS = new Set(
  [
    "yes",
    "no",
    "give me a moment",
    "could you repeat that?",
    "sorry, who am i speaking with?",
    "wait",
    "i'm not finished",
    "i need help",
  ].map((s) => s.toLowerCase()),
);

/** Make a string safe to embed inside a double-quoted prompt bullet: collapse
 *  whitespace/newlines and neutralise quote chars so a transcript line can't
 *  break out of its quotes and read as prompt instructions. */
export function sanitizeForPrompt(s: string, max = 160): string {
  const t = (s ?? "")
    .replace(/\s+/g, " ")
    .replace(/["“”`]/g, "'")
    .trim();
  return t.length > max ? t.slice(0, max - 1) + "…" : t;
}

/**
 * Collect real lines James has spoken in PAST conversations, so the AI can
 * mirror his genuine voice.
 *
 * Privacy: when participants are known, we only mirror lines from conversations
 * held EXCLUSIVELY among the present people (so a line that quotes/relates to an
 * absent person can't surface in a different chat). With no participants
 * selected there's nothing to leak relative to, so we fall back to recent
 * global lines. Deduped; trivial/quick-phrase/single-word lines dropped.
 *
 * Bounded scans keep this cheap: ≤60 recent conversations and a ≤600-segment
 * global recency window (only when no participants are set).
 */
/** Short-TTL memo for the two expensive per-turn scans below, so that with
 *  Tier-3 semantic memory active (which rebuilds context every turn) we don't
 *  re-run the 600-segment voice-sample scan and 200-row choice scan on every
 *  turn. Keyed by sorted personIds; slow-moving signal, so ~90s is plenty. */
const _scanMemo = new Map<string, { at: number; value: string[] }>();
const SCAN_MEMO_TTL_MS = 90_000;
async function memoScan(
  key: string,
  compute: () => Promise<string[]>,
): Promise<string[]> {
  const hit = _scanMemo.get(key);
  if (hit && Date.now() - hit.at < SCAN_MEMO_TTL_MS) return hit.value;
  const value = await compute();
  _scanMemo.set(key, { at: Date.now(), value });
  return value;
}

export async function getJamesVoiceSamples(
  personIds: string[],
  limit = 24,
): Promise<string[]> {
  return memoScan(`voice|${limit}|${[...personIds].sort().join(",")}`, () =>
    getJamesVoiceSamplesUncached(personIds, limit),
  );
}

async function getJamesVoiceSamplesUncached(
  personIds: string[],
  limit = 24,
): Promise<string[]> {
  const seen = new Set<string>();
  const out: string[] = [];

  const push = (raw: string) => {
    if (out.length >= limit) return;
    const text = (raw ?? "").trim();
    if (!text) return;
    const norm = text.toLowerCase().replace(/[.!?,…]+$/g, "").trim();
    if (seen.has(norm) || VOICE_SAMPLE_STOPWORDS.has(norm)) return;
    // Single-word lines carry little phrasing signal.
    if (text.split(/\s+/).length < 2) return;
    seen.add(norm);
    out.push(text);
  };

  try {
    if (personIds.length) {
      // Only mirror lines from conversations held exclusively among the present
      // people — no absent identified person was in the room, so nothing of
      // theirs can leak through James's phrasing.
      const present = new Set(personIds);
      const convos = await db.conversations
        .orderBy("started_at")
        .reverse()
        .limit(60)
        .toArray();
      const safeIds = convos
        .filter((c) => {
          const ids = c.person_ids ?? [];
          return ids.length > 0 && ids.every((pid) => present.has(pid));
        })
        .slice(0, 20)
        .map((c) => c.id);
      for (const cid of safeIds) {
        if (out.length >= limit) break;
        const segs = await db.transcript_segments
          .where("conversation_id")
          .equals(cid)
          .toArray();
        segs.sort((a, b) => b.ts - a.ts);
        for (const s of segs) {
          if (s.speaker_label === JAMES_SELF_LABEL) push(s.text);
          if (out.length >= limit) break;
        }
      }
    } else {
      // No participants selected → recent global lines (nothing to leak against).
      const recent = await db.transcript_segments
        .orderBy("ts")
        .reverse()
        .limit(600)
        .toArray();
      for (const s of recent) {
        if (out.length >= limit) break;
        if (s.speaker_label === JAMES_SELF_LABEL) push(s.text);
      }
    }
  } catch (err) {
    console.warn("james voice samples lookup failed", err);
  }
  return out.slice(0, limit);
}

/**
 * Compact, human-readable records of James's past suggestion decisions for the
 * people currently present (falling back to global recent). Each line tells the
 * model what he picked vs. passed over, or that he rejected everything and typed
 * his own — so the suggestion prompt can learn his preferences. Bounded scan.
 */
export async function getRecentChoiceMemories(
  personIds: string[],
  limit = 12,
): Promise<string[]> {
  return memoScan(`choice|${limit}|${[...personIds].sort().join(",")}`, () =>
    getRecentChoiceMemoriesUncached(personIds, limit),
  );
}

async function getRecentChoiceMemoriesUncached(
  personIds: string[],
  limit = 12,
): Promise<string[]> {
  const trim = (s: string, n = 80) => sanitizeForPrompt(s, n);
  try {
    let rows = await db.suggestion_choices
      .orderBy("ts")
      .reverse()
      .limit(200)
      .toArray();
    // Privacy: when we know who's present, only surface choices tied to one of
    // them. A choice's `context`/`typed_own` can quote what a DIFFERENT person
    // said, so we drop both other-person AND person-less rows (which may carry
    // content from a session with someone we can't attribute) rather than risk
    // leaking one person's conversation into a chat with someone else.
    if (personIds.length) {
      const present = new Set(personIds);
      rows = rows.filter((r) => !!r.person_id && present.has(r.person_id));
    }
    const out: string[] = [];
    for (const r of rows) {
      if (out.length >= limit) break;
      const ctx = r.context ? `Replying to "${trim(r.context)}", ` : "";
      if (r.outcome === "manual" && r.typed_own) {
        out.push(
          `${ctx}he rejected all suggestions and said "${trim(r.typed_own)}" instead.`,
        );
      } else if (r.outcome === "feedback" && r.chosen) {
        const fb = (r.feedback ?? "").replace(/_/g, " ");
        out.push(`He marked "${trim(r.chosen)}" as ${fb || "feedback"}.`);
      } else if (r.outcome === "selected" && r.chosen) {
        const alts = r.alternatives?.length
          ? ` over: ${r.alternatives.slice(0, 3).map((a) => `"${trim(a, 50)}"`).join(", ")}`
          : "";
        out.push(`${ctx}he chose "${trim(r.chosen)}"${alts}.`);
      }
    }
    return out.slice(0, limit);
  } catch (err) {
    console.warn("choice memories lookup failed", err);
    return [];
  }
}

export async function buildConversationContext(opts: {
  personIds: string[];
  place?: Place;
  event?: EventItem;
  /** Tier 3.1 — when provided, person/place memories are retrieved by
   *  semantic similarity (top-K cosine) rather than pure recency. */
  queryEmbedding?: number[];
  /** Tier 3.1 — the model that produced `queryEmbedding`, so retrieval only
   *  compares against stored vectors from a compatible embedding space. */
  queryEmbeddingModel?: string;
}): Promise<ConversationContext> {
  const fingerprint = [
    [...opts.personIds].sort().join(","),
    opts.place?.id ?? "",
    opts.event?.id ?? "",
  ].join(":");
  const now = Date.now();
  // Skip the cache when a query embedding is supplied — semantic retrieval
  // results depend on the live transcript window, so cached entries would be
  // stale.
  if (
    !opts.queryEmbedding &&
    _ctxCache &&
    _ctxCache.fingerprint === fingerprint &&
    now - _ctxCache.builtAt < CTX_CACHE_TTL_MS
  ) {
    return _ctxCache.context;
  }

  const profile = await getJamesProfile();
  const styleProfile = await db.style_profile.get("singleton");

  // Reference documents attached to James's profile — fold into freeform
  // notes so they reach the model without changing the prompt schema.
  const docs = await db.james_documents.orderBy("created_at").toArray();
  const PER_DOC_CHARS = 4000;
  const TOTAL_DOC_CHARS = 16000;
  let docsBlock = "";
  let used = 0;
  for (const d of docs) {
    const remaining = TOTAL_DOC_CHARS - used;
    if (remaining <= 200) break;
    const slice = (d.text ?? "").slice(0, Math.min(PER_DOC_CHARS, remaining));
    if (!slice.trim()) continue;
    docsBlock += `\n\n## Reference document: ${d.name}${d.note ? ` — ${d.note}` : ""}\n${slice}`;
    used += slice.length;
  }
  const freeformCombined = [
    profile.freeform_notes,
    docsBlock.trim() ? `Reference documents about James:${docsBlock}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");

  const peopleRows = (await db.people.bulkGet(opts.personIds)).filter((p): p is Person => !!p);
  const people = await Promise.all(
    peopleRows.map(async (p) => ({
      name: p.name,
      relationship: p.relationship,
      interests: p.interests,
      notes: await notesWithDocsForPerson(p.id, p.notes),
      style_notes: p.style_notes,
      recentMemories: await memoriesForPerson(p.id, opts.queryEmbedding, opts.queryEmbeddingModel),
      followUps: await followUpsForPerson(p.id),
    })),
  );

  let place: ConversationContext["place"] | undefined;
  if (opts.place) {
    const presentIds = new Set(opts.personIds);
    place = {
      name: opts.place.name,
      notes: opts.place.notes,
      recentMemories: await memoriesForPlace(
        opts.place.id,
        presentIds,
        opts.queryEmbedding,
        opts.queryEmbeddingModel,
      ),
      followUps: await followUpsForPlace(opts.place.id, presentIds),
    };
  }

  let event: ConversationContext["event"] | undefined;
  if (opts.event) {
    const ev = opts.event;
    const eventPeople = (await db.people.bulkGet(ev.person_ids ?? []))
      .filter((p): p is Person => !!p)
      .map((p) => p.name);
    const evDocs = await db.event_documents.where("event_id").equals(ev.id).toArray();
    const PER_DOC = 3000;
    const TOTAL = 12000;
    let used = 0;
    const docSnippets: string[] = [];
    for (const d of evDocs) {
      const remaining = TOTAL - used;
      if (remaining <= 200) break;
      const slice = (d.text ?? "").slice(0, Math.min(PER_DOC, remaining));
      if (!slice.trim()) continue;
      docSnippets.push(`### ${d.name}${d.note ? ` — ${d.note}` : ""}\n${slice}`);
      used += slice.length;
    }
    event = {
      name: ev.name,
      when: ev.when,
      location: ev.location,
      keyInfo: ev.key_info,
      peopleNames: eventPeople,
      selectedKeyPoints: (ev.key_points ?? []).filter((k) => k.selected).map((k) => k.text),
      selectedKeyQuestions: (ev.key_questions ?? []).filter((k) => k.selected).map((k) => k.text),
      docs: docSnippets,
    };
  }

  // === Tier 1: feedback loop ===
  // Fold in the rolled-up per-person picks/edits so the suggestion prompt
  // can calibrate toward what James actually picks. Failures here must not
  // break suggestion generation — the field is optional.
  let styleEvidence: StyleEvidence | undefined;
  try {
    styleEvidence = await getStyleEvidence(opts.personIds);
  } catch (err) {
    console.warn("style evidence lookup failed", err);
  }

  // === Cross-conversation voice learning ===
  // Real lines James has spoken before, so suggestions sound like him.
  let jamesVoiceSamples: string[] | undefined;
  try {
    const samples = await getJamesVoiceSamples(opts.personIds);
    if (samples.length) jamesVoiceSamples = samples;
  } catch (err) {
    console.warn("james voice samples failed", err);
  }

  // === Preference learning ===
  // What James picked vs. passed over before, so suggestions skew to his taste.
  let choiceMemories: string[] | undefined;
  try {
    const choices = await getRecentChoiceMemories(opts.personIds);
    if (choices.length) choiceMemories = choices;
  } catch (err) {
    console.warn("choice memories failed", err);
  }

  // Tier 3.1 — when a query embedding was supplied, hoist the per-person
  // and place semantic top-K into a deduped top-level block so the model
  // sees the cross-scope picture at a glance. Capped to keep token budget
  // identical to today (≤12 entries).
  let retrievedMemories: string[] | undefined;
  if (opts.queryEmbedding && opts.queryEmbedding.length > 0) {
    const seen = new Set<string>();
    const flat: string[] = [];
    for (const p of people) {
      for (const m of p.recentMemories) {
        if (!seen.has(m)) {
          seen.add(m);
          flat.push(m);
        }
      }
    }
    if (place) {
      for (const m of place.recentMemories) {
        if (!seen.has(m)) {
          seen.add(m);
          flat.push(m);
        }
      }
    }
    if (flat.length > 0) retrievedMemories = flat.slice(0, 12);
  }

  const context: ConversationContext = {
    jamesProfile: {
      name: profile.display_name || "James",
      background: profile.background,
      personality: profile.personality,
      humor: profile.humor_style,
      communication: profile.communication_style,
      topicsLoved: profile.topics_loved,
      topicsAvoided: profile.topics_avoided,
      signaturePhrases: profile.signature_phrases
        ?.split(/\r?\n/)
        .map((s) => s.trim())
        .filter(Boolean),
      currentLifeContext: profile.current_life_context,
      freeform: freeformCombined || undefined,
    },
    people,
    place,
    event,
    styleProfileJson: styleProfile?.json,
    jamesVoiceSamples,
    choiceMemories,
    styleEvidence,
    retrievedMemories,
  };
  _ctxCache = { fingerprint, context, builtAt: Date.now() };
  return context;
}
