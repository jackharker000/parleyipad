import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import type { EventRecord, Person, Place } from "@/lib/db";
import { cn } from "@/lib/cn";

/**
 * Inline create/edit form for an Event. Sits inside the event card or above
 * the list when adding a new one — no modal. Date input is a plain
 * `<input type="date">` (no calendar library); we convert to epoch ms on
 * save so `EventRecord.start` stays sortable.
 *
 * Validation is minimal: name is required. Everything else is optional.
 */

export type EventFormProps = {
  /** When set, the form is editing this event; otherwise it's creating a new one. */
  event?: EventRecord;
  people: Person[];
  places: Place[];
  onSave: (event: EventRecord) => void;
  onCancel: () => void;
};

type Draft = {
  name: string;
  when: string;
  startDate: string; // yyyy-mm-dd or ""
  placeId: string;
  personIds: string[];
  keyInfo: string;
  prepPrompt: string;
};

function epochToDateInput(ms?: number): string {
  if (ms == null) return "";
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return "";
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function dateInputToEpoch(value: string): number | undefined {
  if (!value) return undefined;
  // Interpret as local midnight so the date the user picked is what
  // gets sorted/displayed. Using `new Date(value)` parses as UTC
  // midnight, which shifts a day in negative-UTC offsets.
  const [y, m, d] = value.split("-").map(Number);
  if (!y || !m || !d) return undefined;
  return new Date(y, m - 1, d).getTime();
}

function draftFromEvent(event: EventRecord | undefined): Draft {
  if (!event) {
    return {
      name: "",
      when: "",
      startDate: "",
      placeId: "",
      personIds: [],
      keyInfo: "",
      prepPrompt: "",
    };
  }
  return {
    name: event.name,
    when: event.when ?? "",
    startDate: epochToDateInput(event.start),
    placeId: event.placeId ?? "",
    personIds: event.personIds ?? [],
    keyInfo: event.keyInfo ?? "",
    prepPrompt: event.prepPrompt ?? "",
  };
}

export function EventForm({ event, people, places, onSave, onCancel }: EventFormProps) {
  const [draft, setDraft] = useState<Draft>(() => draftFromEvent(event));

  // If the parent swaps in a different event row (e.g. an "Edit" tap on
  // a different card), reset the form to that event's values.
  useEffect(() => {
    setDraft(draftFromEvent(event));
  }, [event?.id, event]);

  const set = <K extends keyof Draft>(key: K, value: Draft[K]) =>
    setDraft((cur) => ({ ...cur, [key]: value }));

  const togglePerson = (personId: string) =>
    setDraft((cur) => ({
      ...cur,
      personIds: cur.personIds.includes(personId)
        ? cur.personIds.filter((id) => id !== personId)
        : [...cur.personIds, personId],
    }));

  const submit = () => {
    const trimmedName = draft.name.trim();
    if (!trimmedName) return;
    const now = Date.now();
    const start = dateInputToEpoch(draft.startDate);
    const next: EventRecord = {
      ...(event ?? { id: "", createdAt: now }),
      id: event?.id ?? "",
      name: trimmedName,
      when: draft.when.trim(),
      start,
      placeId: draft.placeId || undefined,
      personIds: draft.personIds,
      keyInfo: draft.keyInfo.trim() || undefined,
      prepPrompt: draft.prepPrompt.trim() || undefined,
      keyPoints: event?.keyPoints,
      keyQuestions: event?.keyQuestions,
      createdAt: event?.createdAt ?? now,
      updatedAt: now,
    };
    onSave(next);
  };

  return (
    <div className="space-y-4 rounded-xl border border-border bg-card p-4">
      <Field label="Name">
        <input
          value={draft.name}
          onChange={(e) => set("name", e.target.value)}
          placeholder="e.g. Sunday lunch at Mum's"
          className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
        />
      </Field>

      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="When (text)" hint='e.g. "Sat 24 May, 7pm". Shown on the card.'>
          <input
            value={draft.when}
            onChange={(e) => set("when", e.target.value)}
            placeholder="Sat 24 May, 7pm"
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
          />
        </Field>
        <Field label="Date (for sorting)">
          <input
            type="date"
            value={draft.startDate}
            onChange={(e) => set("startDate", e.target.value)}
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
          />
        </Field>
      </div>

      <Field label="Place">
        <select
          value={draft.placeId}
          onChange={(e) => set("placeId", e.target.value)}
          className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
        >
          <option value="">(none)</option>
          {places.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </Field>

      <Field label="Attendees" hint="Tagged people bias the speaker-ID matcher during the event.">
        {people.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            No people yet. Add someone on the People page first.
          </p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {people.map((p) => {
              const selected = draft.personIds.includes(p.id);
              return (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => togglePerson(p.id)}
                  className={cn(
                    "rounded-full border px-3 py-1 text-xs font-medium transition-colors",
                    selected
                      ? "border-primary bg-primary/10 text-primary"
                      : "border-border bg-background text-muted-foreground hover:border-foreground/30 hover:text-foreground",
                  )}
                  aria-pressed={selected}
                >
                  {p.name}
                </button>
              );
            })}
          </div>
        )}
      </Field>

      <Field
        label="Key info"
        hint="Agenda, purpose, anything Parley should know. Surfaces in the live cockpit prompt."
      >
        <textarea
          rows={3}
          value={draft.keyInfo}
          onChange={(e) => set("keyInfo", e.target.value)}
          className="block w-full resize-y rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
        />
      </Field>

      <Field
        label="Prep prompt (optional)"
        hint='Steering for "Prep with AI". e.g. "Focus on cricket plans".'
      >
        <textarea
          rows={2}
          value={draft.prepPrompt}
          onChange={(e) => set("prepPrompt", e.target.value)}
          className="block w-full resize-y rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
        />
      </Field>

      <div className="flex items-center gap-2 pt-1">
        <Button onClick={submit} disabled={!draft.name.trim()}>
          Save
        </Button>
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <label className="block text-sm font-medium text-foreground">{label}</label>
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
      {children}
    </div>
  );
}
