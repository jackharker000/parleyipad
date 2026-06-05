import { useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { nanoid } from "nanoid";
import { toast } from "sonner";
import {
  Sparkles,
  Copy,
  Check,
  Plus,
  X,
  ChevronDown,
  ChevronRight,
  Send,
  History,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/cn";
import {
  makeAI,
  type DraftPlatform,
  type DraftReplyVariation,
  type InterestSuggestion,
} from "@/lib/ai";
import { db, type HelperDraft, type JamesProfile, type StyleProfile } from "@/lib/db";
import { useSettings } from "@/lib/settings";

/**
 * Helpers-tab drafter. Takes James's rough typed input and asks the smart-tier
 * LLM to rewrite it in his voice for the given channel (iMessage / email /
 * Facebook). Shows a recommended draft + 2–4 alternates, and a fire-and-forget
 * "learned from this draft" panel that proposes additions to his profile.
 *
 * Persistence: each successful draft is written to `helperDrafts`, keyed by
 * `id`. The row carries enough state for two things — (1) a per-platform
 * history disclosure that James / a helper can browse and reuse, and (2) the
 * Tier-1 style-distillation loop, which reads `jamesEdit` and `sentAt` as
 * "this is what he actually said" signals (the Helpers-tab equivalent of
 * `suggestionsLog.editedTo` / `selected`).
 *
 * No legacy `createServerFn` here — the rebuild's `makeAI(...)` factory wraps
 * the `/api/llm/*` proxy and the keys live server-side only.
 */
export function DraftHelper(props: {
  platform: DraftPlatform;
  /** Title shown above the incoming-text box, e.g. "Email you received" */
  incomingLabel?: string;
  incomingPlaceholder?: string;
  /** Title shown above the typing box */
  draftLabel: string;
  draftPlaceholder: string;
  /** Optional context input label (defaults to a single freeform "Context" input) */
  contextLabel?: string;
  contextPlaceholder?: string;
  /** Hide the incoming box entirely (e.g. status updates) */
  hideIncoming?: boolean;
  /** Render extra controls inside the right column */
  extraControls?: React.ReactNode;
}) {
  const settings = useSettings();
  const jamesProfile = useLiveQuery<JamesProfile | undefined>(
    () => db().jamesProfile.get("singleton"),
    [],
  );
  const styleProfile = useLiveQuery<StyleProfile | undefined>(
    () => db().styleProfile.get("singleton"),
    [],
  );

  // Live history feed for this platform — newest first, capped at 10.
  const history = useLiveQuery<HelperDraft[]>(
    () =>
      db()
        .helperDrafts.where("platform")
        .equals(props.platform)
        .reverse()
        .sortBy("createdAt")
        .then((rs) => rs.slice(0, 10)),
    [props.platform],
  );

  const [incoming, setIncoming] = useState("");
  const [draft, setDraft] = useState("");
  const [context, setContext] = useState("");
  const [busy, setBusy] = useState(false);
  /** Which tone chip is currently re-running, if any. Disables the others. */
  const [tonePending, setTonePending] = useState<string | null>(null);
  const [recommended, setRecommended] = useState<string | null>(null);
  const [alternatives, setAlternatives] = useState<DraftReplyVariation[]>([]);
  const [copied, setCopied] = useState<string | null>(null);
  const [interestSuggestions, setInterestSuggestions] = useState<InterestSuggestion[]>([]);
  /** Edit-before-sending box. Empty unless the user has touched it. */
  const [jamesEdit, setJamesEdit] = useState("");
  /** Db row id of the current draft so we can patch `jamesEdit` / `sentAt`. */
  const [currentDraftId, setCurrentDraftId] = useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);

  // --------------------------------------------------------------------
  // Draft + persist
  // --------------------------------------------------------------------

  /**
   * Issue a `draftReply` and persist the result. `rawTextOverride` lets the
   * tone-redo chips re-run on the previous recommended text (so the model
   * iterates on the polished version rather than the original typo soup).
   */
  async function runDraft(opts: { rawTextOverride?: string; toneOverride?: string } = {}) {
    const raw = (opts.rawTextOverride ?? draft).trim();
    if (!raw) return;
    if (busy || tonePending) return;

    const isTone = !!opts.toneOverride;
    if (isTone) setTonePending(opts.toneOverride ?? null);
    else setBusy(true);

    if (!isTone) {
      setRecommended(null);
      setAlternatives([]);
      setInterestSuggestions([]);
      setJamesEdit("");
      setCurrentDraftId(null);
    }

    try {
      const ai = makeAI(settings.llmProvider);
      const r = await ai.draftReply({
        platform: props.platform,
        incoming: props.hideIncoming ? undefined : incoming.trim() || undefined,
        rawText: raw,
        context: context.trim() || undefined,
        jamesProfile,
        styleProfile,
        toneOverride: opts.toneOverride,
      });
      if (r.error) toast.error(r.error);
      setRecommended(r.recommended);
      setAlternatives(r.alternatives ?? []);

      // Persist. The tone-redo path writes a NEW row too — it captures a
      // distinct draft attempt, useful for the distillation loop.
      const row: HelperDraft = {
        id: nanoid(),
        platform: props.platform,
        incoming: props.hideIncoming ? undefined : incoming.trim() || undefined,
        rawText: raw,
        recommended: r.recommended,
        alternatives: r.alternatives ?? [],
        createdAt: Date.now(),
      };
      try {
        await db().helperDrafts.put(row);
        setCurrentDraftId(row.id);
      } catch (err) {
        // Persistence isn't load-bearing for the live UI; log + carry on.
        console.warn("helperDrafts.put failed", err);
      }

      // Fire-and-forget interest extraction on the recommended draft. Skip
      // for tone re-dos — the underlying intent didn't change, so we'd just
      // re-propose the same additions.
      if (!isTone && r.recommended) {
        void ai
          .extractInterests({
            draft: r.recommended,
            incoming: props.hideIncoming ? undefined : incoming.trim() || undefined,
            currentTopicsLoved: jamesProfile?.topicsLoved?.join(", "),
            currentLifeContext: jamesProfile?.currentLifeContext,
            currentSignaturePhrases: jamesProfile?.signaturePhrases?.join("\n"),
            jamesName: jamesProfile?.displayName,
          })
          .then((res) => setInterestSuggestions(res.suggestions ?? []))
          .catch(() => {});
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Could not draft";
      toast.error(msg);
    } finally {
      if (isTone) setTonePending(null);
      else setBusy(false);
    }
  }

  function handleDraft() {
    return runDraft();
  }

  function handleToneChip(tone: string) {
    // Tone re-dos iterate on the polished recommended text when we have one;
    // otherwise fall back to the raw draft. Either way the model gets the
    // same `toneOverride` nudge as the final line of its user prompt.
    const seed = recommended ?? draft;
    if (!seed.trim()) return;
    return runDraft({ rawTextOverride: seed, toneOverride: tone });
  }

  async function copyText(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(text);
      toast.success("Copied");
      setTimeout(() => setCopied((c) => (c === text ? null : c)), 1500);
    } catch {
      toast.error("Could not copy");
    }
  }

  function applyDraft(text: string) {
    setDraft(text);
    setRecommended(null);
    setAlternatives([]);
    setInterestSuggestions([]);
    setJamesEdit("");
    setCurrentDraftId(null);
  }

  async function acceptInterest(s: InterestSuggestion) {
    const current = (await db().jamesProfile.get("singleton")) ?? {
      id: "singleton" as const,
      // Empty string = "not yet set" (matches DEFAULT_JAMES_PROFILE so the
      // onboarding checklist still nudges the user to fill it in afterwards).
      displayName: "",
      updatedAt: 0,
    };
    const updates: Partial<JamesProfile> = {};
    if (s.kind === "topic_loved") {
      const arr = [...(current.topicsLoved ?? []), s.text];
      updates.topicsLoved = arr;
    } else if (s.kind === "current_context") {
      const cur = current.currentLifeContext?.trim();
      updates.currentLifeContext = cur ? `${cur}\n${s.text}` : s.text;
    } else if (s.kind === "signature_phrase") {
      const arr = [...(current.signaturePhrases ?? []), s.text];
      updates.signaturePhrases = arr;
    }
    await db().jamesProfile.put({ ...current, ...updates, updatedAt: Date.now() });
    toast.success("Added to your profile");
    setInterestSuggestions((arr) => arr.filter((x) => x !== s));
  }

  function dismissInterest(s: InterestSuggestion) {
    setInterestSuggestions((arr) => arr.filter((x) => x !== s));
  }

  /**
   * "Use this" from a history row. Drops the recommended text into the draft
   * field, then immediately re-runs `draftReply` with that text as `rawText`
   * so the model gets a fresh shot at alternatives. We don't write
   * `jamesEdit` here — that's reserved for the user's edit-before-send box.
   */
  async function reuseHistoryRow(row: HelperDraft) {
    setDraft(row.recommended);
    if (!props.hideIncoming) setIncoming(row.incoming ?? "");
    // Regenerate fresh alternatives from the recommended text as the seed.
    await runDraft({ rawTextOverride: row.recommended });
  }

  /**
   * "Mark sent" on a history row OR the current draft. Persists the
   * edit-before-send text (if any) and stamps `sentAt`. The style-distill
   * job downstream reads both fields as evidence of what James actually
   * spoke / sent.
   */
  async function markSent(rowId: string, editText?: string) {
    try {
      const patch: Partial<HelperDraft> = { sentAt: Date.now() };
      if (editText && editText.trim().length > 0) patch.jamesEdit = editText.trim();
      await db().helperDrafts.update(rowId, patch);
      toast.success("Marked sent");
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Could not mark sent";
      toast.error(msg);
    }
  }

  // --------------------------------------------------------------------
  // Render
  // --------------------------------------------------------------------

  return (
    <>
      <HistoryDisclosure
        history={history ?? []}
        open={historyOpen}
        onToggle={() => setHistoryOpen((x) => !x)}
        onUse={reuseHistoryRow}
        onMarkSent={(row) => markSent(row.id)}
      />

      <Card className="p-5">
        <div className="grid gap-4 md:grid-cols-[1fr_220px]">
          <div className="space-y-3">
            {!props.hideIncoming && (
              <FieldLabel
                htmlFor="dh-incoming"
                text={props.incomingLabel ?? "What you received (optional)"}
              >
                <textarea
                  id="dh-incoming"
                  value={incoming}
                  onChange={(e) => setIncoming(e.target.value)}
                  placeholder={props.incomingPlaceholder}
                  rows={4}
                  className={textareaClass}
                />
              </FieldLabel>
            )}
            <FieldLabel htmlFor="dh-draft" text={props.draftLabel}>
              <textarea
                id="dh-draft"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                    e.preventDefault();
                    void handleDraft();
                  }
                }}
                placeholder={props.draftPlaceholder}
                rows={5}
                className={textareaClass}
              />
              <p className="mt-1 text-xs text-muted-foreground">Tip: Cmd/Ctrl + Enter to draft.</p>
            </FieldLabel>
          </div>
          <div className="flex flex-col gap-3">
            {props.extraControls}
            <FieldLabel htmlFor="dh-ctx" text={props.contextLabel ?? "Context (optional)"}>
              <input
                id="dh-ctx"
                type="text"
                value={context}
                onChange={(e) => setContext(e.target.value)}
                placeholder={props.contextPlaceholder ?? "e.g. from his sister Anna"}
                className={inputClass}
              />
            </FieldLabel>
          </div>
        </div>

        <div className="mt-4 flex justify-end">
          <Button
            size="lg"
            className="gap-2"
            onClick={handleDraft}
            disabled={busy || tonePending !== null || !draft.trim()}
          >
            <Sparkles className={cn("size-5", busy && "animate-pulse")} />
            {busy ? "Drafting…" : "Draft reply"}
          </Button>
        </div>
      </Card>

      {recommended && (
        <section className="mt-6 space-y-3">
          <Card className="border-primary/40 bg-primary/5 p-5">
            <div className="flex items-center gap-2 text-sm font-medium text-primary">
              <Sparkles className="size-4" />
              Recommended
            </div>
            <p className="mt-2 whitespace-pre-wrap text-base leading-relaxed">{recommended}</p>
            <div className="mt-3 flex flex-wrap gap-2">
              <Button size="sm" onClick={() => copyText(recommended)} className="gap-2">
                {copied === recommended ? (
                  <Check className="size-4" />
                ) : (
                  <Copy className="size-4" />
                )}
                {copied === recommended ? "Copied" : "Copy"}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => applyDraft(recommended)}>
                Tweak it
              </Button>
            </div>

            <ToneChips
              busy={busy}
              pending={tonePending}
              onPick={(tone) => void handleToneChip(tone)}
            />

            <div className="mt-4">
              <FieldLabel htmlFor="dh-edit" text="Edit before sending (optional)">
                <textarea
                  id="dh-edit"
                  value={jamesEdit}
                  onChange={(e) => setJamesEdit(e.target.value)}
                  placeholder="Tweak the recommended draft before you send / speak it…"
                  rows={3}
                  className={textareaClass}
                />
              </FieldLabel>
              <div className="mt-2 flex flex-wrap gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  className="gap-2"
                  disabled={!currentDraftId}
                  onClick={() => {
                    if (currentDraftId) void markSent(currentDraftId, jamesEdit);
                  }}
                >
                  <Send className="size-4" /> Mark sent
                </Button>
                {jamesEdit.trim().length > 0 && (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="gap-2"
                    onClick={() => void copyText(jamesEdit)}
                  >
                    {copied === jamesEdit ? (
                      <Check className="size-4" />
                    ) : (
                      <Copy className="size-4" />
                    )}
                    {copied === jamesEdit ? "Copied edit" : "Copy edit"}
                  </Button>
                )}
              </div>
            </div>
          </Card>

          {alternatives.length > 0 && (
            <div className="grid gap-3 md:grid-cols-2">
              {alternatives.map((alt, i) => (
                <Card key={i} className="p-4">
                  <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    {alt.tone || "Alternative"}
                  </div>
                  <p className="mt-2 whitespace-pre-wrap text-sm leading-relaxed">{alt.text}</p>
                  <div className="mt-3 flex gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => copyText(alt.text)}
                      className="gap-2"
                    >
                      {copied === alt.text ? (
                        <Check className="size-4" />
                      ) : (
                        <Copy className="size-4" />
                      )}
                      {copied === alt.text ? "Copied" : "Copy"}
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => applyDraft(alt.text)}>
                      Tweak
                    </Button>
                  </div>
                </Card>
              ))}
            </div>
          )}

          {interestSuggestions.length > 0 && (
            <Card className="border-amber-500/40 bg-amber-500/5 p-4">
              <div className="text-xs font-medium uppercase tracking-wide text-amber-700 dark:text-amber-400">
                Learned from this draft — add to your profile?
              </div>
              <ul className="mt-2 space-y-2">
                {interestSuggestions.map((s, i) => (
                  <li key={i} className="flex items-start gap-2">
                    <span className="mt-1 inline-block min-w-[110px] rounded bg-secondary px-2 py-0.5 text-[11px] text-muted-foreground">
                      {s.kind === "topic_loved"
                        ? "Interest"
                        : s.kind === "current_context"
                          ? "Life context"
                          : "Phrase"}
                    </span>
                    <span className="flex-1 text-sm">{s.text}</span>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="gap-1"
                      onClick={() => acceptInterest(s)}
                    >
                      <Plus className="size-4" /> Add
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => dismissInterest(s)}
                      aria-label="Dismiss"
                    >
                      <X className="size-4" />
                    </Button>
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </section>
      )}
    </>
  );
}

// --------------------------------------------------------------------------
// Tone-redo chip row
// --------------------------------------------------------------------------

const TONE_CHIPS: readonly string[] = [
  "shorter",
  "warmer",
  "drier",
  "more formal",
  "more casual",
] as const;

function ToneChips({
  busy,
  pending,
  onPick,
}: {
  busy: boolean;
  pending: string | null;
  onPick: (tone: string) => void;
}) {
  return (
    <div className="mt-3 flex flex-wrap items-center gap-2">
      <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        Re-do
      </span>
      {TONE_CHIPS.map((tone) => {
        const isThisPending = pending === tone;
        const disabled = busy || (pending !== null && !isThisPending);
        return (
          <button
            key={tone}
            type="button"
            disabled={disabled}
            onClick={() => onPick(tone)}
            className={cn(
              "rounded-full border border-input bg-background px-3 py-1 text-xs font-medium transition-colors",
              "hover:bg-muted hover:text-foreground",
              "disabled:cursor-not-allowed disabled:opacity-50",
              isThisPending && "animate-pulse border-primary text-primary",
            )}
          >
            {isThisPending ? `${tone}…` : tone}
          </button>
        );
      })}
    </div>
  );
}

// --------------------------------------------------------------------------
// History disclosure (per-platform, last 10, collapsed by default)
// --------------------------------------------------------------------------

function HistoryDisclosure({
  history,
  open,
  onToggle,
  onUse,
  onMarkSent,
}: {
  history: HelperDraft[];
  open: boolean;
  onToggle: () => void;
  onUse: (row: HelperDraft) => void | Promise<void>;
  onMarkSent: (row: HelperDraft) => void | Promise<void>;
}) {
  if (history.length === 0) return null;

  return (
    <Card className="mb-4 p-3">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="flex w-full items-center gap-2 text-left text-sm font-medium text-muted-foreground hover:text-foreground"
      >
        {open ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
        <History className="size-4" />
        <span>
          History <span className="text-xs">({history.length})</span>
        </span>
      </button>
      {open && (
        <ul className="mt-3 space-y-2">
          {history.map((row) => (
            <HistoryRow
              key={row.id}
              row={row}
              onUse={() => void onUse(row)}
              onMarkSent={() => void onMarkSent(row)}
            />
          ))}
        </ul>
      )}
    </Card>
  );
}

function HistoryRow({
  row,
  onUse,
  onMarkSent,
}: {
  row: HelperDraft;
  onUse: () => void;
  onMarkSent: () => void;
}) {
  const now = Date.now();
  return (
    <li className="rounded-md border border-border/60 bg-background p-3">
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
        <span>{formatRelative(row.createdAt, now)}</span>
        {row.sentAt && (
          <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-emerald-700 dark:text-emerald-400">
            Sent
          </span>
        )}
      </div>
      {row.rawText && (
        <p className="mt-1 truncate text-xs italic text-muted-foreground" title={row.rawText}>
          You typed: {row.rawText}
        </p>
      )}
      <p className="mt-1 line-clamp-3 whitespace-pre-wrap text-sm leading-snug">
        {row.recommended}
      </p>
      <div className="mt-2 flex gap-2">
        <Button size="sm" variant="outline" onClick={onUse}>
          Use this
        </Button>
        <Button size="sm" variant="ghost" disabled={!!row.sentAt} onClick={onMarkSent}>
          {row.sentAt ? "Marked sent" : "Mark sent"}
        </Button>
      </div>
    </li>
  );
}

/**
 * Same relative-time format as the Recent view's `formatRelative` —
 * duplicated here so we don't reach across into a route file. Cheap and
 * keeps the boundary clean.
 */
function formatRelative(ts: number, now: number): string {
  const diff = now - ts;
  if (diff < 0) return "in the future";
  const sec = Math.round(diff / 1000);
  if (sec < 60) return "just now";
  const min = Math.round(sec / 60);
  if (min < 60) return `${min} min${min === 1 ? "" : "s"} ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr} hour${hr === 1 ? "" : "s"} ago`;
  const day = Math.round(hr / 24);
  if (day < 30) return `${day} day${day === 1 ? "" : "s"} ago`;
  const month = Math.round(day / 30);
  if (month < 12) return `${month} month${month === 1 ? "" : "s"} ago`;
  const yr = Math.round(month / 12);
  return `${yr} year${yr === 1 ? "" : "s"} ago`;
}

// --------------------------------------------------------------------------
// Tiny hand-rolled primitives (no shadcn Tabs/Textarea/Input/Label in the
// rebuild yet — keep the dep tree small).
// --------------------------------------------------------------------------

function FieldLabel(props: { htmlFor: string; text: string; children: React.ReactNode }) {
  return (
    <div>
      <label htmlFor={props.htmlFor} className="block text-base font-medium">
        {props.text}
      </label>
      <div className="mt-1">{props.children}</div>
    </div>
  );
}

const baseFieldClass =
  "w-full rounded-md border border-input bg-background px-3 text-base text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:opacity-50";

const inputClass = cn(baseFieldClass, "h-10");
const textareaClass = cn(baseFieldClass, "min-h-[80px] py-2 leading-relaxed");
