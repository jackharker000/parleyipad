import { createFileRoute } from "@tanstack/react-router";
import { useLiveQuery } from "dexie-react-hooks";
import { useEffect, useMemo, useState } from "react";
import { nanoid } from "nanoid";
import { toast } from "sonner";
import { ChevronDown, ChevronRight, Pencil, Plus, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { db, type EventRecord, type Person, type Place } from "@/lib/db";
import { useSettings } from "@/lib/settings";
import { makeAI } from "@/lib/ai";
import { EventForm } from "@/components/events/EventForm";
import { EventPrepButton } from "@/components/events/EventPrepButton";
import { cn } from "@/lib/cn";

export const Route = createFileRoute("/events")({
  component: EventsPage,
});

const EMPTY_EVENTS: EventRecord[] = [];
const EMPTY_PEOPLE: Person[] = [];
const EMPTY_PLACES: Place[] = [];

function EventsPage() {
  return (
    <div className="mx-auto w-full max-w-4xl space-y-6 px-4 py-8">
      <header className="space-y-1">
        <p className="text-sm font-medium uppercase tracking-wider text-muted-foreground">Events</p>
        <h1 className="text-3xl font-semibold tracking-tight">Upcoming &amp; past events</h1>
        <p className="max-w-prose text-muted-foreground">
          Anything James has on the calendar he'd like Parley to prep him for. Tagged attendees bias
          the speaker-ID matcher during the event, and the key info feeds the live cockpit prompt.
          Tap "Prep with AI" to generate talking points + questions.
        </p>
      </header>

      <ClientOnly fallback={null}>
        <EventsApp />
      </ClientOnly>
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

function EventsApp() {
  const settings = useSettings();
  const ai = useMemo(() => makeAI(settings.llmProvider), [settings.llmProvider]);

  const events = useLiveQuery(() => db().events.toArray(), [], EMPTY_EVENTS);
  const people = useLiveQuery(() => db().people.orderBy("name").toArray(), [], EMPTY_PEOPLE);
  const places = useLiveQuery(() => db().places.orderBy("name").toArray(), [], EMPTY_PLACES);

  const peopleById = useMemo(() => {
    const m = new Map<string, Person>();
    for (const p of people) m.set(p.id, p);
    return m;
  }, [people]);
  const placeById = useMemo(() => {
    const m = new Map<string, Place>();
    for (const p of places) m.set(p.id, p);
    return m;
  }, [places]);

  const [addingNew, setAddingNew] = useState(false);

  const now = Date.now();
  const { upcoming, past } = useMemo(() => {
    const upcoming: EventRecord[] = [];
    const past: EventRecord[] = [];
    for (const e of events) {
      // No start = "someday"; treat as upcoming so it stays visible.
      if (e.start == null || e.start >= now) upcoming.push(e);
      else past.push(e);
    }
    upcoming.sort(
      (a, b) => (a.start ?? Number.MAX_SAFE_INTEGER) - (b.start ?? Number.MAX_SAFE_INTEGER),
    );
    past.sort((a, b) => (b.start ?? 0) - (a.start ?? 0));
    return { upcoming, past };
  }, [events, now]);

  const saveNew = async (event: EventRecord) => {
    const next: EventRecord = { ...event, id: nanoid() };
    try {
      await db().events.add(next);
      setAddingNew(false);
      toast.success("Event added");
    } catch (err) {
      toast.error(`Add failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <div className="flex items-start justify-between gap-4">
            <div>
              <CardTitle>Upcoming ({upcoming.length})</CardTitle>
              <CardDescription>
                Sorted by date. Events with no date pinned to the top.
              </CardDescription>
            </div>
            {!addingNew && (
              <Button variant="default" onClick={() => setAddingNew(true)}>
                <Plus />
                Add event
              </Button>
            )}
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          {addingNew && (
            <EventForm
              people={people}
              places={places}
              onSave={saveNew}
              onCancel={() => setAddingNew(false)}
            />
          )}
          {upcoming.length === 0 && !addingNew && (
            <p className="rounded-md border border-dashed border-border bg-muted/30 px-4 py-6 text-center text-sm text-muted-foreground">
              No upcoming events. Tap "Add event" to plan one.
            </p>
          )}
          {upcoming.map((event) => (
            <EventCard
              key={event.id}
              event={event}
              peopleById={peopleById}
              placeById={placeById}
              people={people}
              places={places}
              ai={ai}
            />
          ))}
        </CardContent>
      </Card>

      <PastEventsSection
        past={past}
        peopleById={peopleById}
        placeById={placeById}
        people={people}
        places={places}
        ai={ai}
      />
    </div>
  );
}

function PastEventsSection({
  past,
  peopleById,
  placeById,
  people,
  places,
  ai,
}: {
  past: EventRecord[];
  peopleById: Map<string, Person>;
  placeById: Map<string, Place>;
  people: Person[];
  places: Place[];
  ai: ReturnType<typeof makeAI>;
}) {
  const [open, setOpen] = useState(false);
  if (past.length === 0) return null;
  return (
    <Card>
      <CardHeader className="p-0">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className="flex w-full items-center gap-3 p-5 text-left transition-colors hover:bg-muted/40"
        >
          {open ? (
            <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
          ) : (
            <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
          )}
          <CardTitle>Past ({past.length})</CardTitle>
        </button>
      </CardHeader>
      {open && (
        <CardContent className="space-y-3">
          {past.map((event) => (
            <EventCard
              key={event.id}
              event={event}
              peopleById={peopleById}
              placeById={placeById}
              people={people}
              places={places}
              ai={ai}
            />
          ))}
        </CardContent>
      )}
    </Card>
  );
}

function EventCard({
  event,
  peopleById,
  placeById,
  people,
  places,
  ai,
}: {
  event: EventRecord;
  peopleById: Map<string, Person>;
  placeById: Map<string, Place>;
  people: Person[];
  places: Place[];
  ai: ReturnType<typeof makeAI>;
}) {
  const [editing, setEditing] = useState(false);

  const placeName = event.placeId ? placeById.get(event.placeId)?.name : undefined;
  const attendees = (event.personIds ?? [])
    .map((id) => peopleById.get(id))
    .filter((p): p is Person => !!p);

  const remove = async () => {
    if (!confirm(`Delete event "${event.name}"?`)) return;
    try {
      await db().events.delete(event.id);
      toast.success("Event removed");
    } catch (err) {
      toast.error(`Delete failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const save = async (next: EventRecord) => {
    try {
      await db().events.put(next);
      setEditing(false);
      toast.success("Event updated");
    } catch (err) {
      toast.error(`Save failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  if (editing) {
    return (
      <EventForm
        event={event}
        people={people}
        places={places}
        onSave={save}
        onCancel={() => setEditing(false)}
      />
    );
  }

  const hasPrep =
    (event.keyPoints && event.keyPoints.length > 0) ||
    (event.keyQuestions && event.keyQuestions.length > 0);

  return (
    <div className="space-y-3 rounded-xl border border-border bg-card p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1 space-y-1">
          <div className="text-base font-semibold leading-tight">{event.name}</div>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
            {event.when && <span>{event.when}</span>}
            {placeName && <span>· {placeName}</span>}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <EventPrepButton event={event} ai={ai} />
          <button
            type="button"
            onClick={() => setEditing(true)}
            className="rounded p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            aria-label="Edit event"
            title="Edit"
          >
            <Pencil className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={remove}
            className="rounded p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-destructive"
            aria-label="Delete event"
            title="Delete"
          >
            <Trash2 className="h-4 w-4" />
          </button>
        </div>
      </div>

      {attendees.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {attendees.map((p) => (
            <span
              key={p.id}
              className={cn(
                "inline-flex items-center rounded-full border border-border bg-muted/40 px-2.5 py-0.5 text-xs font-medium text-foreground",
              )}
            >
              {p.name}
            </span>
          ))}
        </div>
      )}

      {event.keyInfo && (
        <p className="whitespace-pre-line text-sm text-foreground/90">{event.keyInfo}</p>
      )}

      {hasPrep && (
        <div className="space-y-3 rounded-lg border border-border bg-muted/30 p-3">
          {event.keyPoints && event.keyPoints.length > 0 && (
            <div>
              <div className="mb-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                Talking points
              </div>
              <ul className="list-disc space-y-1 pl-5 text-sm">
                {event.keyPoints.map((p, i) => (
                  <li key={i}>{p}</li>
                ))}
              </ul>
            </div>
          )}
          {event.keyQuestions && event.keyQuestions.length > 0 && (
            <div>
              <div className="mb-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                Questions to ask
              </div>
              <ul className="list-disc space-y-1 pl-5 text-sm">
                {event.keyQuestions.map((q, i) => (
                  <li key={i}>{q}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
