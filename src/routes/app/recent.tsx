import { createFileRoute } from "@tanstack/react-router";
import { useLiveQuery } from "dexie-react-hooks";
import { Search, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { ConversationDetail } from "@/components/recent/ConversationDetail";
import { RecentList } from "@/components/recent/RecentList";
import { cn } from "@/lib/cn";
import {
  db,
  type Conversation,
  type EventRecord,
  type PendingJob,
  type Person,
  type Place,
} from "@/lib/db";

export const Route = createFileRoute("/app/recent")({
  component: RecentPage,
});

const EMPTY_CONVERSATIONS: Conversation[] = [];
const EMPTY_PEOPLE: Person[] = [];
const EMPTY_PLACES: Place[] = [];
const EMPTY_EVENTS: EventRecord[] = [];
const EMPTY_PENDING: PendingJob[] = [];

type SortKey = "date_desc" | "date_asc";

function RecentPage() {
  return (
    <div className="mx-auto w-full max-w-4xl space-y-6 px-4 py-8">
      <header className="space-y-1">
        <p className="text-sm font-medium uppercase tracking-wider text-muted-foreground">Recent</p>
        <h1 className="text-3xl font-semibold tracking-tight">Past conversations</h1>
        <p className="max-w-prose text-muted-foreground">
          Every conversation is summarised and indexed so future suggestions can call back to what
          was said. Tap a row to see the transcript, the suggestion log, and how the AI is learning
          your reply style.
        </p>
      </header>

      <ClientOnly fallback={<LoadingCard />}>
        <RecentApp />
      </ClientOnly>
    </div>
  );
}

function LoadingCard() {
  // Layout-preserving skeleton — five rows so the page doesn't reflow when
  // the real list mounts. No spinner; just pulsing blocks.
  return (
    <div className="space-y-3" role="status" aria-label="Loading conversations">
      {Array.from({ length: 5 }).map((_, i) => (
        <div key={i} className="h-16 animate-pulse rounded-xl bg-[var(--sand-2)]/60" />
      ))}
    </div>
  );
}

function ClientOnly({
  children,
  fallback,
}: {
  children: React.ReactNode;
  fallback: React.ReactNode;
}) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  if (!mounted) return <>{fallback}</>;
  return <>{children}</>;
}

function RecentApp() {
  const conversations = useLiveQuery(
    () => db().conversations.orderBy("startedAt").reverse().toArray(),
    [],
    EMPTY_CONVERSATIONS,
  );
  const people = useLiveQuery(() => db().people.orderBy("name").toArray(), [], EMPTY_PEOPLE);
  const places = useLiveQuery(() => db().places.toArray(), [], EMPTY_PLACES);
  const events = useLiveQuery(() => db().events.toArray(), [], EMPTY_EVENTS);
  const pendingJobs = useLiveQuery(() => db().pendingJobs.toArray(), [], EMPTY_PENDING);

  const peopleById = useMemo(() => new Map(people.map((p) => [p.id, p] as const)), [people]);
  const placesById = useMemo(() => new Map(places.map((p) => [p.id, p] as const)), [places]);
  const eventsById = useMemo(() => new Map(events.map((e) => [e.id, e] as const)), [events]);
  const pendingByConversationId = useMemo(() => {
    const m = new Map<string, PendingJob[]>();
    for (const j of pendingJobs) {
      const arr = m.get(j.conversationId);
      if (arr) arr.push(j);
      else m.set(j.conversationId, [j]);
    }
    return m;
  }, [pendingJobs]);

  const [keyword, setKeyword] = useState("");
  const [selectedPersonIds, setSelectedPersonIds] = useState<string[]>([]);
  const [placeFilter, setPlaceFilter] = useState<string>("__all__");
  const [sort, setSort] = useState<SortKey>("date_desc");
  const [selectedConversationId, setSelectedConversationId] = useState<string | null>(null);

  const togglePersonFilter = (personId: string) => {
    setSelectedPersonIds((prev) =>
      prev.includes(personId) ? prev.filter((id) => id !== personId) : [...prev, personId],
    );
  };

  const filtered = useMemo(() => {
    let list = conversations;
    if (placeFilter !== "__all__") {
      list = list.filter((c) => c.placeId === placeFilter);
    }
    if (selectedPersonIds.length > 0) {
      list = list.filter((c) => (c.personIds ?? []).some((id) => selectedPersonIds.includes(id)));
    }
    const kw = keyword.trim().toLowerCase();
    if (kw) {
      list = list.filter((c) => {
        const hay = [
          c.summary ?? "",
          ...(c.highlights ?? []),
          placesById.get(c.placeId ?? "")?.name ?? "",
          ...(c.personIds ?? []).map((id) => peopleById.get(id)?.name ?? "").filter(Boolean),
        ]
          .join(" \n")
          .toLowerCase();
        return hay.includes(kw);
      });
    }
    const sorted = [...list];
    if (sort === "date_asc") {
      sorted.sort((a, b) => a.startedAt - b.startedAt);
    } else {
      sorted.sort((a, b) => b.startedAt - a.startedAt);
    }
    return sorted;
  }, [conversations, placeFilter, selectedPersonIds, keyword, sort, peopleById, placesById]);

  const hasFilters =
    keyword.trim() !== "" ||
    selectedPersonIds.length > 0 ||
    placeFilter !== "__all__" ||
    sort !== "date_desc";

  const clearFilters = () => {
    setKeyword("");
    setSelectedPersonIds([]);
    setPlaceFilter("__all__");
    setSort("date_desc");
  };

  if (selectedConversationId) {
    return (
      <ConversationDetail
        conversationId={selectedConversationId}
        peopleById={peopleById}
        placesById={placesById}
        eventsById={eventsById}
        onBack={() => setSelectedConversationId(null)}
      />
    );
  }

  return (
    <div className="space-y-4">
      <Card className="sticky top-16 z-10 bg-card/95 backdrop-blur">
        <CardContent className="space-y-3 p-4">
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <input
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
              placeholder="Search summary, highlights, names…"
              className="w-full rounded-md border border-input bg-background py-2 pl-9 pr-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                People
              </span>
              {people.length === 0 ? (
                <span className="text-xs italic text-muted-foreground">No people yet</span>
              ) : (
                people.map((p) => {
                  const active = selectedPersonIds.includes(p.id);
                  return (
                    <button
                      key={p.id}
                      type="button"
                      onClick={() => togglePersonFilter(p.id)}
                      className={cn(
                        "rounded-full border px-2.5 py-0.5 text-xs transition-colors",
                        active
                          ? "border-accent bg-accent text-accent-foreground"
                          : "border-input bg-background text-foreground hover:bg-muted",
                      )}
                    >
                      {p.name}
                    </button>
                  );
                })
              )}
            </div>

            <div className="flex items-center gap-2">
              <label
                htmlFor="recent-place-filter"
                className="text-xs font-medium uppercase tracking-wider text-muted-foreground"
              >
                Place
              </label>
              <select
                id="recent-place-filter"
                value={placeFilter}
                onChange={(e) => setPlaceFilter(e.target.value)}
                className="h-8 rounded-md border border-input bg-background px-2 text-xs"
              >
                <option value="__all__">All places</option>
                {places.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </div>

            <div className="flex items-center gap-2">
              <label
                htmlFor="recent-sort"
                className="text-xs font-medium uppercase tracking-wider text-muted-foreground"
              >
                Sort
              </label>
              <select
                id="recent-sort"
                value={sort}
                onChange={(e) => setSort(e.target.value as SortKey)}
                className="h-8 rounded-md border border-input bg-background px-2 text-xs"
              >
                <option value="date_desc">Newest first</option>
                <option value="date_asc">Oldest first</option>
              </select>
            </div>

            {hasFilters && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={clearFilters}
                className="ml-auto gap-1"
              >
                <X className="size-4" /> Clear
              </Button>
            )}
          </div>

          <p className="text-xs text-muted-foreground">
            {filtered.length} {filtered.length === 1 ? "conversation" : "conversations"}
          </p>
        </CardContent>
      </Card>

      <RecentList
        conversations={filtered}
        peopleById={peopleById}
        placesById={placesById}
        eventsById={eventsById}
        pendingByConversationId={pendingByConversationId}
        onSelect={setSelectedConversationId}
      />
    </div>
  );
}
