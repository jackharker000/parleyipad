import { useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { toast } from "sonner";
import { Sparkles, Copy, Check, Plus, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/cn";
import {
  makeAI,
  type DraftPlatform,
  type DraftReplyVariation,
  type InterestSuggestion,
} from "@/lib/ai";
import { db, type JamesProfile } from "@/lib/db";
import { useSettings } from "@/lib/settings";

/**
 * Helpers-tab drafter. Takes James's rough typed input and asks the smart-tier
 * LLM to rewrite it in his voice for the given channel (iMessage / email /
 * Facebook). Shows a recommended draft + 2–4 alternates, and a fire-and-forget
 * "learned from this draft" panel that proposes additions to his profile.
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

  const [incoming, setIncoming] = useState("");
  const [draft, setDraft] = useState("");
  const [context, setContext] = useState("");
  const [busy, setBusy] = useState(false);
  const [recommended, setRecommended] = useState<string | null>(null);
  const [alternatives, setAlternatives] = useState<DraftReplyVariation[]>([]);
  const [copied, setCopied] = useState<string | null>(null);
  const [interestSuggestions, setInterestSuggestions] = useState<InterestSuggestion[]>([]);

  async function handleDraft() {
    const raw = draft.trim();
    if (!raw || busy) return;
    setBusy(true);
    setRecommended(null);
    setAlternatives([]);
    setInterestSuggestions([]);
    try {
      const ai = makeAI(settings.llmProvider);
      const r = await ai.draftReply({
        platform: props.platform,
        incoming: props.hideIncoming ? undefined : incoming.trim() || undefined,
        rawText: raw,
        context: context.trim() || undefined,
        jamesProfile,
      });
      if (r.error) toast.error(r.error);
      setRecommended(r.recommended);
      setAlternatives(r.alternatives ?? []);

      // Fire-and-forget interest extraction on the recommended draft.
      if (r.recommended) {
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
      setBusy(false);
    }
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
  }

  async function acceptInterest(s: InterestSuggestion) {
    const current = (await db().jamesProfile.get("singleton")) ?? {
      id: "singleton" as const,
      displayName: "James",
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
    toast.success("Added to James's profile");
    setInterestSuggestions((arr) => arr.filter((x) => x !== s));
  }

  function dismissInterest(s: InterestSuggestion) {
    setInterestSuggestions((arr) => arr.filter((x) => x !== s));
  }

  return (
    <>
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
            disabled={busy || !draft.trim()}
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
            <div className="mt-3 flex gap-2">
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
                Learned from this draft — add to James's profile?
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
