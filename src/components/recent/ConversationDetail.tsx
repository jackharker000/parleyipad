import { useLiveQuery } from "dexie-react-hooks";
import { ArrowLeft, RefreshCcw } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { TranscriptView } from "@/components/recent/TranscriptView";
import {
  db,
  type EventRecord,
  type Person,
  type Place,
  type SuggestionLog,
  type TranscriptSegment,
} from "@/lib/db";
import { drainPendingJobs, enqueueJob } from "@/lib/jobs/drain";
import { cn } from "@/lib/cn";

const CATEGORY_LABEL: Record<string, string> = {
  answer: "Answer",
  question: "Question",
  followup: "Follow-up",
  planned: "Planned",
  humor: "Humour",
  clarify: "Clarify",
  "give-me-a-moment": "Give me a moment",
};

export function ConversationDetail({
  conversationId,
  peopleById,
  placesById,
  eventsById,
  onBack,
}: {
  conversationId: string;
  peopleById: Map<string, Person>;
  placesById: Map<string, Place>;
  eventsById: Map<string, EventRecord>;
  onBack: () => void;
}) {
  // James's display name. Hard-coded here for now to match what drain.ts
  // uses when it stitches the transcript for the summariser. Will swap to
  // the JamesProfile singleton lookup once that lands.
  const jamesName = "James";

  const conversation = useLiveQuery(() => db().conversations.get(conversationId), [conversationId]);
  const segments = useLiveQuery(
    () => db().transcriptSegments.where("conversationId").equals(conversationId).toArray(),
    [conversationId],
  );
  const suggestions = useLiveQuery(
    () => db().suggestionsLog.where("conversationId").equals(conversationId).toArray(),
    [conversationId],
  );

  const orderedSegments = useMemo(() => {
    if (!segments) return [];
    return [...segments].sort((a, b) => a.startedAt - b.startedAt);
  }, [segments]);

  const [resummarising, setResummarising] = useState(false);

  if (!conversation) {
    return (
      <div className="space-y-4">
        <BackButton onBack={onBack} />
        <Card>
          <CardContent className="py-6 text-sm text-muted-foreground">
            Conversation not found.
          </CardContent>
        </Card>
      </div>
    );
  }

  const place = conversation.placeId ? placesById.get(conversation.placeId) : undefined;
  const event = conversation.eventId ? eventsById.get(conversation.eventId) : undefined;
  const attendees = (conversation.personIds ?? [])
    .map((id) => peopleById.get(id)?.name)
    .filter((n): n is string => !!n);

  const startedAt = new Date(conversation.startedAt);
  const headerDate = startedAt.toLocaleString(undefined, {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
  });

  const resummarise = async () => {
    if (resummarising) return;
    setResummarising(true);
    try {
      // Clear-then-enqueue so the drainer's "already done" guard re-runs the
      // summary. See `src/lib/jobs/drain.ts:runSummariseConversation` — the
      // TODO there tracks replacing this dance with an explicit `force` flag.
      await db().conversations.update(conversationId, {
        summary: undefined,
        highlights: undefined,
      });
      await enqueueJob({ type: "summariseConversation", conversationId });
      void drainPendingJobs();
      toast.success("Re-summary queued");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setResummarising(false);
    }
  };

  return (
    <div className="space-y-4">
      <BackButton onBack={onBack} />

      <header className="space-y-1">
        <h2 className="text-2xl font-semibold tracking-tight">{headerDate}</h2>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
          {place && <span>{place.name}</span>}
          {event && (
            <span>
              {place ? "· " : ""}
              {event.name}
            </span>
          )}
          {attendees.length > 0 && (
            <span>
              {place || event ? "· " : ""}With {attendees.join(", ")}
            </span>
          )}
        </div>
      </header>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-3">
          <CardTitle>Summary</CardTitle>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void resummarise()}
            disabled={resummarising}
            className="gap-1"
          >
            <RefreshCcw className={cn("size-4", resummarising && "animate-spin")} />
            Re-summarise
          </Button>
        </CardHeader>
        <CardContent className="space-y-3">
          {conversation.summary ? (
            <p className="whitespace-pre-wrap text-sm leading-relaxed">{conversation.summary}</p>
          ) : (
            <p className="text-sm italic text-muted-foreground">
              Summary pending — will appear after the AI processes the transcript.
            </p>
          )}
          {conversation.highlights && conversation.highlights.length > 0 && (
            <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
              {conversation.highlights.map((h, i) => (
                <li key={i}>{h}</li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Transcript</CardTitle>
        </CardHeader>
        <CardContent>
          <TranscriptView
            segments={orderedSegments}
            peopleById={peopleById}
            jamesName={jamesName}
            onReassign={undefined}
          />
        </CardContent>
      </Card>

      <SuggestionsLogCard suggestions={suggestions ?? []} segments={orderedSegments} />
    </div>
  );
}

function BackButton({ onBack }: { onBack: () => void }) {
  return (
    <Button type="button" variant="ghost" size="sm" onClick={onBack} className="gap-2">
      <ArrowLeft className="size-4" />
      Back to list
    </Button>
  );
}

function SuggestionsLogCard({
  suggestions,
  segments,
}: {
  suggestions: SuggestionLog[];
  segments: TranscriptSegment[];
}) {
  const grouped = useMemo(() => {
    // Stable order: by createdAt asc so the earliest-triggered group renders
    // first. Within a group, suggestions stay in their original logged order.
    const byTrigger = new Map<string, SuggestionLog[]>();
    for (const s of suggestions) {
      const key = s.triggeringSegmentId ?? "__none__";
      const arr = byTrigger.get(key);
      if (arr) arr.push(s);
      else byTrigger.set(key, [s]);
    }
    const entries = Array.from(byTrigger.entries());
    entries.sort(([, a], [, b]) => {
      const aMin = Math.min(...a.map((s) => s.createdAt));
      const bMin = Math.min(...b.map((s) => s.createdAt));
      return aMin - bMin;
    });
    return entries;
  }, [suggestions]);

  const segmentById = useMemo(() => {
    const m = new Map<string, TranscriptSegment>();
    for (const s of segments) m.set(s.id, s);
    return m;
  }, [segments]);

  return (
    <Card>
      <CardHeader>
        <CardTitle>What the AI suggested</CardTitle>
      </CardHeader>
      <CardContent>
        {suggestions.length === 0 ? (
          <p className="text-sm italic text-muted-foreground">
            No suggestion log recorded for this conversation.
          </p>
        ) : (
          <ul className="space-y-4">
            {grouped.map(([triggerId, group]) => {
              const trigger = triggerId !== "__none__" ? segmentById.get(triggerId) : undefined;
              const triggerText = trigger?.text ?? "";
              return (
                <li key={triggerId} className="space-y-2">
                  {trigger ? (
                    <div className="text-xs text-muted-foreground">
                      <span className="font-semibold uppercase tracking-wider">After</span>{" "}
                      <span className="italic">"{truncate(triggerText, 120)}"</span>
                    </div>
                  ) : (
                    <div className="text-xs uppercase tracking-wider text-muted-foreground">
                      Untriggered (typed / replay / opening)
                    </div>
                  )}
                  <ul className="space-y-1.5">
                    {group.map((s) => (
                      <SuggestionRow key={s.id} suggestion={s} />
                    ))}
                  </ul>
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function SuggestionRow({ suggestion }: { suggestion: SuggestionLog }) {
  const state: "selected" | "edited" | "ignored" | "shown" = suggestion.editedTo
    ? "edited"
    : suggestion.selected
      ? "selected"
      : suggestion.ignored
        ? "ignored"
        : "shown";

  return (
    <li
      className={cn(
        "rounded-lg border border-border bg-card/50 p-3 text-sm",
        state === "selected" && "border-accent/40",
        state === "edited" && "border-accent/40",
      )}
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <p className="flex-1 leading-snug text-foreground">{suggestion.text}</p>
        <CategoryBadge category={suggestion.category} />
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <StateBadge state={state} />
        {state === "edited" && suggestion.editedTo && (
          <span>
            edited to: <span className="italic text-foreground">"{suggestion.editedTo}"</span>
          </span>
        )}
      </div>
    </li>
  );
}

function CategoryBadge({ category }: { category: SuggestionLog["category"] }) {
  return (
    <span className="inline-flex shrink-0 items-center rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
      {CATEGORY_LABEL[category] ?? category}
    </span>
  );
}

function StateBadge({ state }: { state: "selected" | "edited" | "ignored" | "shown" }) {
  const cls =
    state === "selected"
      ? "bg-emerald-500/20 text-emerald-800"
      : state === "edited"
        ? "bg-amber-500/20 text-amber-800"
        : state === "ignored"
          ? "bg-muted text-muted-foreground"
          : "bg-muted text-muted-foreground";
  const label =
    state === "selected"
      ? "Selected"
      : state === "edited"
        ? "Edited"
        : state === "ignored"
          ? "Ignored"
          : "Shown";
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider",
        cls,
      )}
    >
      {label}
    </span>
  );
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max - 1).trimEnd() + "…";
}
