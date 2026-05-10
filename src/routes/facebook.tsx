import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { ArrowLeft, Sparkles, Copy, Facebook, Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { draftFacebookPost } from "@/lib/aac.functions";
import { buildConversationContext } from "@/lib/context";
import { getSettings } from "@/lib/db";

export const Route = createFileRoute("/facebook")({
  component: FacebookPage,
  head: () => ({
    meta: [
      { title: "Facebook helper — AAC" },
      {
        name: "description",
        content:
          "Type roughly and let the AI turn it into a polished Facebook post in James's voice.",
      },
    ],
  }),
});

type Variation = { text: string; tone: string };
type PostType = "status" | "comment" | "reply" | "message";

function FacebookPage() {
  const draftFn = useServerFn(draftFacebookPost);
  const [draft, setDraft] = useState("");
  const [context, setContext] = useState("");
  const [postType, setPostType] = useState<PostType>("status");
  const [busy, setBusy] = useState(false);
  const [recommended, setRecommended] = useState<string | null>(null);
  const [alternatives, setAlternatives] = useState<Variation[]>([]);
  const [model, setModel] = useState<string | undefined>(undefined);
  const [copied, setCopied] = useState<string | null>(null);

  useEffect(() => {
    getSettings().then((s) => {
      setModel(s.suggestion_model ?? s.expand_model);
    });
  }, []);

  async function handleDraft() {
    const raw = draft.trim();
    if (!raw || busy) return;
    setBusy(true);
    setRecommended(null);
    setAlternatives([]);
    try {
      const ctx = await buildConversationContext({ personIds: [] });
      const r = await draftFn({
        data: {
          rawText: raw,
          postType,
          context: context.trim() || undefined,
          jamesProfile: ctx.jamesProfile,
          model,
        },
      });
      if (r.error) toast.error(r.error);
      setRecommended(r.recommended);
      setAlternatives(r.alternatives ?? []);
    } catch (e: any) {
      toast.error(e?.message ?? "Could not draft post");
    } finally {
      setBusy(false);
    }
  }

  async function copyText(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(text);
      toast.success("Copied — paste it into Facebook");
      setTimeout(() => setCopied((c) => (c === text ? null : c)), 1500);
    } catch {
      toast.error("Could not copy");
    }
  }

  function useAsDraft(text: string) {
    setDraft(text);
    setRecommended(null);
    setAlternatives([]);
  }

  return (
    <main className="mx-auto max-w-3xl px-4 py-6">
      <header className="flex items-center gap-3 pb-4">
        <Link
          to="/"
          className="flex size-10 items-center justify-center rounded-lg text-muted-foreground hover:bg-secondary"
          aria-label="Back"
        >
          <ArrowLeft className="size-5" />
        </Link>
        <Facebook className="size-6 text-[#1877f2]" />
        <h1 className="text-xl font-semibold">Facebook helper</h1>
      </header>

      <Card className="p-5">
        <div className="grid gap-4 md:grid-cols-[1fr_220px]">
          <div>
            <Label htmlFor="fb-draft" className="text-base">
              Type roughly — what do you want to post?
            </Label>
            <Textarea
              id="fb-draft"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  handleDraft();
                }
              }}
              placeholder="e.g. happy bday matt great day sail"
              rows={5}
              className="mt-1 text-base"
            />
            <p className="mt-1 text-xs text-muted-foreground">
              Tip: press Cmd/Ctrl + Enter to draft.
            </p>
          </div>
          <div className="flex flex-col gap-3">
            <div>
              <Label className="text-base">Post type</Label>
              <Select
                value={postType}
                onValueChange={(v) => setPostType(v as PostType)}
              >
                <SelectTrigger className="mt-1">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="status">Status update</SelectItem>
                  <SelectItem value="comment">Comment on a post</SelectItem>
                  <SelectItem value="reply">Reply to a comment</SelectItem>
                  <SelectItem value="message">Messenger message</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label htmlFor="fb-ctx" className="text-base">
                Context (optional)
              </Label>
              <Input
                id="fb-ctx"
                value={context}
                onChange={(e) => setContext(e.target.value)}
                placeholder="e.g. replying to Matt's photo"
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
            {busy ? "Drafting…" : "Draft post"}
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
            <p className="mt-2 whitespace-pre-wrap text-base leading-relaxed">
              {recommended}
            </p>
            <div className="mt-3 flex gap-2">
              <Button size="sm" onClick={() => copyText(recommended)} className="gap-2">
                {copied === recommended ? (
                  <Check className="size-4" />
                ) : (
                  <Copy className="size-4" />
                )}
                {copied === recommended ? "Copied" : "Copy"}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => useAsDraft(recommended)}
              >
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
                  <p className="mt-2 whitespace-pre-wrap text-sm leading-relaxed">
                    {alt.text}
                  </p>
                  <div className="mt-3 flex gap-2">
                    <Button
                      size="sm"
                      variant="secondary"
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
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => useAsDraft(alt.text)}
                    >
                      Tweak
                    </Button>
                  </div>
                </Card>
              ))}
            </div>
          )}
        </section>
      )}
    </main>
  );
}