import { useEffect, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { Sparkles, Copy, Check, Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { draftReply, extractInterests } from "@/lib/aac.functions";
import { buildConversationContext } from "@/lib/context";
import { getSettings, getJamesProfile, updateJamesProfile } from "@/lib/db";

type Variation = { text: string; tone: string };
type InterestSuggestion = { kind: string; text: string; why?: string };

export type DraftPlatform = "facebook" | "email" | "imessage";

export function DraftHelper(props: {
  platform: DraftPlatform;
  /** Title shown above the incoming-text box, e.g. "Email you received" */
  incomingLabel?: string;
  incomingPlaceholder?: string;
  /** Title shown above the typing box */
  draftLabel: string;
  draftPlaceholder: string;
  /** Optional context input (defaults to a single freeform "Context" input) */
  contextLabel?: string;
  contextPlaceholder?: string;
  /** Hide the incoming box entirely (e.g. status updates) */
  hideIncoming?: boolean;
  /** Render extra controls inside the right column */
  extraControls?: React.ReactNode;
}) {
  const draftFn = useServerFn(draftReply);
  const extractFn = useServerFn(extractInterests);

  const [incoming, setIncoming] = useState("");
  const [draft, setDraft] = useState("");
  const [context, setContext] = useState("");
  const [busy, setBusy] = useState(false);
  const [recommended, setRecommended] = useState<string | null>(null);
  const [alternatives, setAlternatives] = useState<Variation[]>([]);
  const [model, setModel] = useState<string | undefined>(undefined);
  const [copied, setCopied] = useState<string | null>(null);
  const [interestSuggestions, setInterestSuggestions] = useState<InterestSuggestion[]>([]);

  useEffect(() => {
    // Drafts and interest extraction are quality-critical, not latency-critical.
    getSettings().then((s) =>
      setModel(s.smart_model ?? s.suggestion_model ?? s.expand_model),
    );
  }, []);

  async function handleDraft() {
    const raw = draft.trim();
    if (!raw || busy) return;
    setBusy(true);
    setRecommended(null);
    setAlternatives([]);
    setInterestSuggestions([]);
    try {
      const ctx = await buildConversationContext({ personIds: [] });
      const r = await draftFn({
        data: {
          platform: props.platform,
          incoming: props.hideIncoming ? undefined : incoming.trim() || undefined,
          rawText: raw,
          context: context.trim() || undefined,
          jamesProfile: ctx.jamesProfile,
          model,
        },
      });
      if (r.error) toast.error(r.error);
      setRecommended(r.recommended);
      setAlternatives(r.alternatives ?? []);

      // Fire-and-forget interest extraction on the recommended draft.
      if (r.recommended) {
        const profile = await getJamesProfile();
        extractFn({
          data: {
            draft: r.recommended,
            incoming: props.hideIncoming ? undefined : incoming.trim() || undefined,
            currentTopicsLoved: profile.topics_loved,
            currentLifeContext: profile.current_life_context,
            currentSignaturePhrases: profile.signature_phrases,
            jamesName: profile.display_name,
            model,
          },
        })
          .then((res) => setInterestSuggestions(res.suggestions ?? []))
          .catch(() => {});
      }
    } catch (e: any) {
      toast.error(e?.message ?? "Could not draft");
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

  function useAsDraft(text: string) {
    setDraft(text);
    setRecommended(null);
    setAlternatives([]);
    setInterestSuggestions([]);
  }

  async function acceptInterest(s: InterestSuggestion) {
    const profile = await getJamesProfile();
    if (s.kind === "topic_loved") {
      const cur = profile.topics_loved?.trim();
      await updateJamesProfile({
        topics_loved: cur ? `${cur}, ${s.text}` : s.text,
      });
    } else if (s.kind === "current_context") {
      const cur = profile.current_life_context?.trim();
      await updateJamesProfile({
        current_life_context: cur ? `${cur}\n${s.text}` : s.text,
      });
    } else if (s.kind === "signature_phrase") {
      const cur = profile.signature_phrases?.trim();
      await updateJamesProfile({
        signature_phrases: cur ? `${cur}\n${s.text}` : s.text,
      });
    }
    toast.success("Added to your profile");
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
              <div>
                <Label htmlFor="dh-incoming" className="text-base">
                  {props.incomingLabel ?? "What you received (optional)"}
                </Label>
                <Textarea
                  id="dh-incoming"
                  value={incoming}
                  onChange={(e) => setIncoming(e.target.value)}
                  placeholder={props.incomingPlaceholder}
                  rows={4}
                  className="mt-1 text-base"
                />
              </div>
            )}
            <div>
              <Label htmlFor="dh-draft" className="text-base">
                {props.draftLabel}
              </Label>
              <Textarea
                id="dh-draft"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                    e.preventDefault();
                    handleDraft();
                  }
                }}
                placeholder={props.draftPlaceholder}
                rows={5}
                className="mt-1 text-base"
              />
              <p className="mt-1 text-xs text-muted-foreground">
                Tip: Cmd/Ctrl + Enter to draft.
              </p>
            </div>
          </div>
          <div className="flex flex-col gap-3">
            {props.extraControls}
            <div>
              <Label htmlFor="dh-ctx" className="text-base">
                {props.contextLabel ?? "Context (optional)"}
              </Label>
              <Input
                id="dh-ctx"
                value={context}
                onChange={(e) => setContext(e.target.value)}
                placeholder={props.contextPlaceholder ?? "e.g. from his sister Anna"}
                className="mt-1"
              />
            </div>
          </div>
        </div>

        <div className="mt-4 flex justify-end">
          <Button
            size="lg"
            className="gap-2"
            onClick={handleDraft}
            disabled={busy || !draft.trim()}
          >
            <Sparkles className={`size-5 ${busy ? "animate-pulse" : ""}`} />
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
                {copied === recommended ? <Check className="size-4" /> : <Copy className="size-4" />}
                {copied === recommended ? "Copied" : "Copy"}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => useAsDraft(recommended)}>
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
                    <Button size="sm" variant="secondary" onClick={() => copyText(alt.text)} className="gap-2">
                      {copied === alt.text ? <Check className="size-4" /> : <Copy className="size-4" />}
                      {copied === alt.text ? "Copied" : "Copy"}
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => useAsDraft(alt.text)}>
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
                    <Button size="sm" variant="ghost" className="gap-1" onClick={() => acceptInterest(s)}>
                      <Plus className="size-4" /> Add
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => dismissInterest(s)} aria-label="Dismiss">
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