import { useEffect, useMemo, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { nanoid } from "nanoid";
import { toast } from "sonner";
import { Calendar, Plus, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { EventForm } from "@/components/events/EventForm";
import { EventPrepButton } from "@/components/events/EventPrepButton";
import { db, type EventRecord, type Person, type Place } from "@/lib/db";
import { useSettings } from "@/lib/settings";
import { makeAI } from "@/lib/ai";
import { cn } from "@/lib/cn";

/**
 * Events tab. Left rail (Add + upcoming events list, sorted by `start`
 * descending) + right detail panel (existing EventForm + AI prep + key
 * info / talking-points / questions rendering). Brings back the
 * left-list / right-edit pattern from the pre-login version.
 */

const EMPTY_EVENTS: EventRecord[] = [];
const EMPTY_PEOPLE: Person[] = [];
const EMPTY_PLACES: Place[] = [];

export function EventsTab() {
  return (
    <ClientOnly fallback={<LoadingSkeleton />}>
      <EventsApp />
    </ClientOnly>
  );
}

function LoadingSkeleton() {
  return (
    <div className="grid gap-6 lg:grid-cols-[360px_1fr]">
      <div className="space-y-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="h-14 animate-pulse rounded-xl bg-[var(--sand-2)]/60" />
        ))}
      </div>
      <div className="h-64 animate-pulse rounded-2xl bg-[var(--sand-2)]/60" />
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

  const sortedEvents = useMemo(() => {
    return [...events].sort(
      (a, b) => (b.start ?? Number.MAX_SAFE_INTEGER) - (a.start ?? Number.MAX_SAFE_INTEGER),
    );
  }, [events]);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  useEffect(() => {
    if (selectedId && !events.some((e) => e.id === selectedId)) {
      setSelectedId(null);
    }
  }, [events, selectedId]);

  const selected = selectedId ? events.find((e) => e.id === selectedId) ?? null : null;

  const saveNew = async (event: EventRecord) => {
    const id = nanoid();
    const next: EventRecord = { ...event, id };
    try {
      await db().events.add(next);
      setAdding(false);
      setSelectedId(id);
      toast.success("Event added");
    } catch (err) {
      toast.error(`Add failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  return (
    <div className="grid gap-6 lg:grid-cols-[360px_1fr]">
      <UpcomingEventsRail
        events={sortedEvents}
        selectedId={selectedId}
        onSelect={(id) => {
          setSelectedId(id);
          setAdding(false);
        }}
        onAdd={() => {
          setAdding(true);
          setSelectedId(null);
        }}
      />
      <div>
        {adding ? (
          <AddEventPanel
            people={people}
            places={places}
            onSave={saveNew}
            onCancel={() => setAdding(false)}
          />
        ) : selected ? (
          <EventEditor
            key={selected.id}
            event={selected}
            people={people}
            places={places}
            ai={ai}
            onDeleted={() => setSelectedId(null)}
          />
        ) : (
          <EmptyDetailPanel onAdd={() => setAdding(true)} />
        )}
      </div>
    </div>
  );
}

// --------------------------------------------------------------------------

function UpcomingEventsRail({
  events,
  selectedId,
  onSelect,
  onAdd,
}: {
  events: EventRecord[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onAdd: () => void;
}) {
  return (
    <div className="space-y-3 rounded-2xl border border-[var(--line)] bg-white p-4">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Upcoming events ({events.length})
        </p>
        <Button size="sm" onClick={onAdd}>
          <Plus />
          Add
        </Button>
      </div>
      {events.length === 0 ? (
        <p className="rounded-md border border-dashed border-border bg-muted/30 px-3 py-6 text-center text-xs text-muted-foreground">
          No upcoming events yet.
        </p>
      ) : (
        <ul className="space-y-1">
          {events.map((e) => {
            const isSelected = e.id === selectedId;
            return (
              <li key={e.id}>
                <button
                  type="button"
                  onClick={() => onSelect(e.id)}
                  aria-current={isSelected ? "true" : undefined}
                  className={cn(
                    "flex w-full min-h-[44px] items-center gap-3 rounded-lg border px-3 py-2 text-left transition-colors",
                    isSelected
                      ? "border-[var(--teal)] bg-[var(--teal)]/10"
                      : "border-transparent hover:border-border hover:bg-muted/40",
                  )}
                >
                  <Calendar className="h-4 w-4 shrink-0 text-muted-foreground" />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium text-foreground">{e.name}</div>
                    {e.when && (
                      <div className="truncate text-xs text-muted-foreground">{e.when}</div>
                    )}
                  </div>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function EmptyDetailPanel({ onAdd }: { onAdd: () => void }) {
  return (
    <div className="flex h-full min-h-[280px] flex-col items-center justify-center rounded-2xl border border-[var(--line)] bg-white p-8 text-center">
      <h3 className="text-lg font-semibold tracking-tight text-[var(--ink)]">
        Select an event to edit, or add a new one.
      </h3>
      <p className="mt-2 max-w-md text-sm leading-relaxed text-[var(--ink-soft)]">
        Anything James has on the calendar he&apos;d like Parley to prep him for. Tagged attendees
        bias the speaker-ID matcher during the event, and the key info feeds the live cockpit
        prompt.
      </p>
      <div className="mt-4">
        <Button onClick={onAdd}>
          <Plus />
          Add event
        </Button>
      </div>
    </div>
  );
}

// --------------------------------------------------------------------------

function AddEventPanel({
  people,
  places,
  onSave,
  onCancel,
}: {
  people: Person[];
  places: Place[];
  onSave: (event: EventRecord) => void | Promise<void>;
  onCancel: () => void;
}) {
  return (
    <div className="space-y-3">
      <h2 className="text-xl font-semibold tracking-tight text-[var(--ink)]">Add an event</h2>
      <EventForm people={people} places={places} onSave={onSave} onCancel={onCancel} />
    </div>
  );
}

function EventEditor({
  event,
  people,
  places,
  ai,
  onDeleted,
}: {
  event: EventRecord;
  people: Person[];
  places: Place[];
  ai: ReturnType<typeof makeAI>;
  onDeleted: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false);

  const placeName = useMemo(() => {
    if (!event.placeId) return undefined;
    return places.find((p) => p.id === event.placeId)?.name;
  }, [places, event.placeId]);

  const attendees = useMemo(() => {
    const ids = event.personIds ?? [];
    return ids
      .map((id) => people.find((p) => p.id === id))
      .filter((p): p is Person => !!p);
  }, [people, event.personIds]);

  const save = async (next: EventRecord) => {
    try {
      await db().events.put(next);
      setEditing(false);
      toast.success("Event updated");
    } catch (err) {
      toast.error(`Save failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const confirmDelete = async () => {
    try {
      await db().events.delete(event.id);
      toast.success("Event removed");
      onDeleted();
    } catch (err) {
      toast.error(`Delete failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  if (editing) {
    return (
      <div className="space-y-3">
        <h2 className="text-xl font-semibold tracking-tight text-[var(--ink)]">
          Edit {event.name}
        </h2>
        <EventForm
          event={event}
          people={people}
          places={places}
          onSave={save}
          onCancel={() => setEditing(false)}
        />
      </div>
    );
  }

  const hasPrep =
    (event.keyPoints && event.keyPoints.length > 0) ||
    (event.keyQuestions && event.keyQuestions.length > 0);

  return (
    <div className="space-y-4">
      <div className="rounded-2xl border border-[var(--line)] bg-white p-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="text-2xl font-semibold tracking-tight text-[var(--ink)]">
              {event.name}
            </h2>
            <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-[var(--ink-soft)]">
              {event.when && <span>{event.when}</span>}
              {placeName && <span>· {placeName}</span>}
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <EventPrepButton event={event} ai={ai} />
            <Button variant="outline" size="sm" onClick={() => setEditing(true)}>
              Edit
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setConfirmDeleteOpen(true)}>
              <Trash2 />
              Delete
            </Button>
          </div>
        </div>

        {attendees.length > 0 && (
          <div className="mt-4 flex flex-wrap gap-1.5">
            {attendees.map((p) => (
              <span
                key={p.id}
                className="inline-flex items-center rounded-full border border-border bg-muted/40 px-2.5 py-0.5 text-xs font-medium text-foreground"
              >
                {p.name}
              </span>
            ))}
          </div>
        )}

        {event.keyInfo && (
          <p className="mt-4 whitespace-pre-line text-sm text-foreground/90">{event.keyInfo}</p>
        )}
      </div>

      {hasPrep && (
        <div className="space-y-3 rounded-2xl border border-[var(--line)] bg-white p-6">
          {event.keyPoints && event.keyPoints.length > 0 && (
            <div>
              <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                Talking points
              </p>
              <ul className="list-disc space-y-1 pl-5 text-sm">
                {event.keyPoints.map((p, i) => (
                  <li key={i}>{p}</li>
                ))}
              </ul>
            </div>
          )}
          {event.keyQuestions && event.keyQuestions.length > 0 && (
            <div>
              <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                Questions to ask
              </p>
              <ul className="list-disc space-y-1 pl-5 text-sm">
                {event.keyQuestions.map((q, i) => (
                  <li key={i}>{q}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      <ConfirmDialog
        open={confirmDeleteOpen}
        onOpenChange={setConfirmDeleteOpen}
        title={`Delete event "${event.name}"?`}
        description="Removes the event from the cockpit's prep + speaker prior. This can't be undone."
        confirmLabel="Delete"
        destructive
        onConfirm={confirmDelete}
      />
    </div>
  );
}
