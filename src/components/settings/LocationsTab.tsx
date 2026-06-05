import { useEffect, useMemo, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { nanoid } from "nanoid";
import { toast } from "sonner";
import { MapPin, Plus, Trash2, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { db, type Person, type Place } from "@/lib/db";
import { useSettings } from "@/lib/settings";
import { cn } from "@/lib/cn";

/**
 * Locations tab. Left rail (Add + saved-locations list) + right detail
 * panel (Name, GPS coords + radius, Notes, people commonly here, Save +
 * Delete). Brings back the pre-login left-list / right-edit pattern, and
 * exposes lat/lng + radius even when the GPS feature toggle is off (the
 * fields are useful background data; the toggle only gates auto-detection).
 */

const EMPTY_PLACES: Place[] = [];
const EMPTY_PEOPLE: Person[] = [];

type PlaceDraft = {
  name: string;
  lat: string;
  lng: string;
  radiusM: string;
  notes: string;
  personIds: string[];
};

function draftFromPlace(p: Place): PlaceDraft {
  return {
    name: p.name,
    lat: p.lat != null ? String(p.lat) : "",
    lng: p.lng != null ? String(p.lng) : "",
    radiusM: p.radiusM != null ? String(p.radiusM) : "",
    notes: p.notes ?? "",
    personIds: p.personIds ?? [],
  };
}

export function LocationsTab() {
  const places = useLiveQuery(() => db().places.orderBy("name").toArray(), [], EMPTY_PLACES);
  const people = useLiveQuery(() => db().people.orderBy("name").toArray(), [], EMPTY_PEOPLE);
  const settings = useSettings();

  const [selectedId, setSelectedId] = useState<string | null>(null);

  // If the selected place is deleted underneath us, clear the selection.
  useEffect(() => {
    if (selectedId && !places.some((p) => p.id === selectedId)) {
      setSelectedId(null);
    }
  }, [places, selectedId]);

  const selected = selectedId ? places.find((p) => p.id === selectedId) ?? null : null;

  const addPlace = async () => {
    const id = nanoid();
    const now = Date.now();
    await db().places.add({
      id,
      name: "New location",
      personIds: [],
      createdAt: now,
      updatedAt: now,
    });
    setSelectedId(id);
    toast.success("Location added");
  };

  return (
    <div className="grid gap-6 lg:grid-cols-[360px_1fr]">
      <SavedLocationsRail
        places={places}
        selectedId={selectedId}
        onSelect={setSelectedId}
        onAdd={addPlace}
      />
      <div>
        {selected ? (
          <PlaceEditor
            key={selected.id}
            place={selected}
            people={people}
            gpsEnabled={settings.gpsEnabled}
            onDeleted={() => setSelectedId(null)}
          />
        ) : (
          <EmptyDetailPanel onAdd={addPlace} />
        )}
      </div>
    </div>
  );
}

// --------------------------------------------------------------------------

function SavedLocationsRail({
  places,
  selectedId,
  onSelect,
  onAdd,
}: {
  places: Place[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onAdd: () => void;
}) {
  return (
    <div className="space-y-3 rounded-2xl border border-[var(--line)] bg-white p-4">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Saved locations ({places.length})
        </p>
        <Button size="sm" onClick={onAdd}>
          <Plus />
          Add
        </Button>
      </div>
      {places.length === 0 ? (
        <p className="rounded-md border border-dashed border-border bg-muted/30 px-3 py-6 text-center text-xs text-muted-foreground">
          No saved locations yet.
        </p>
      ) : (
        <ul className="space-y-1">
          {places.map((p) => {
            const isSelected = p.id === selectedId;
            return (
              <li key={p.id}>
                <button
                  type="button"
                  onClick={() => onSelect(p.id)}
                  aria-current={isSelected ? "true" : undefined}
                  className={cn(
                    "flex w-full min-h-[44px] items-center gap-3 rounded-lg border px-3 py-2 text-left transition-colors",
                    isSelected
                      ? "border-[var(--teal)] bg-[var(--teal)]/10"
                      : "border-transparent hover:border-border hover:bg-muted/40",
                  )}
                >
                  <MapPin className="h-4 w-4 shrink-0 text-muted-foreground" />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium text-foreground">{p.name}</div>
                    {p.lat != null && p.lng != null && (
                      <div className="truncate text-xs text-muted-foreground">
                        {p.lat.toFixed(4)}, {p.lng.toFixed(4)}
                      </div>
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
        Select a location to edit, or add a new one.
      </h3>
      <p className="mt-2 max-w-md text-sm leading-relaxed text-[var(--ink-soft)]">
        Places James talks at — home, library, the cafe round the corner. Tagging the people
        commonly here boosts the speaker-ID prior at this location.
      </p>
      <div className="mt-4">
        <Button onClick={onAdd}>
          <Plus />
          Add location
        </Button>
      </div>
    </div>
  );
}

// --------------------------------------------------------------------------

function PlaceEditor({
  place,
  people,
  gpsEnabled,
  onDeleted,
}: {
  place: Place;
  people: Person[];
  gpsEnabled: boolean;
  onDeleted: () => void;
}) {
  const [draft, setDraft] = useState<PlaceDraft>(() => draftFromPlace(place));
  const [saving, setSaving] = useState(false);
  const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false);
  const [locating, setLocating] = useState(false);

  // If the live row updates underneath us (e.g. cross-device sync), only
  // re-sync when our local draft hasn't been touched — checking against the
  // current draft would lose typed edits.
  useEffect(() => {
    setDraft(draftFromPlace(place));
  }, [place.id]);

  const set = <K extends keyof PlaceDraft>(key: K, value: PlaceDraft[K]) =>
    setDraft((cur) => ({ ...cur, [key]: value }));

  const togglePerson = (personId: string) => {
    setDraft((cur) => {
      const has = cur.personIds.includes(personId);
      return {
        ...cur,
        personIds: has
          ? cur.personIds.filter((id) => id !== personId)
          : [...cur.personIds, personId],
      };
    });
  };

  const useCurrentLocation = () => {
    if (typeof navigator === "undefined" || !navigator.geolocation) {
      toast.error("Geolocation isn't available in this browser.");
      return;
    }
    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setLocating(false);
        setDraft((cur) => ({
          ...cur,
          lat: pos.coords.latitude.toFixed(6),
          lng: pos.coords.longitude.toFixed(6),
        }));
        toast.success("GPS coordinates captured");
      },
      (err) => {
        setLocating(false);
        toast.error(`Couldn't read location: ${err.message}`);
      },
      { enableHighAccuracy: true, timeout: 10_000 },
    );
  };

  const clearCoords = () =>
    setDraft((cur) => ({ ...cur, lat: "", lng: "" }));

  const save = async () => {
    if (saving) return;
    const trimmedName = draft.name.trim();
    if (!trimmedName) {
      toast.error("Name is required");
      return;
    }
    setSaving(true);
    try {
      const latNum = draft.lat.trim() === "" ? undefined : Number(draft.lat);
      const lngNum = draft.lng.trim() === "" ? undefined : Number(draft.lng);
      const radiusNum =
        draft.radiusM.trim() === "" ? undefined : Number(draft.radiusM);
      await db().places.put({
        ...place,
        name: trimmedName,
        lat: latNum != null && Number.isFinite(latNum) ? latNum : undefined,
        lng: lngNum != null && Number.isFinite(lngNum) ? lngNum : undefined,
        radiusM:
          radiusNum != null && Number.isFinite(radiusNum) ? radiusNum : undefined,
        notes: draft.notes.trim() || undefined,
        personIds: draft.personIds,
        updatedAt: Date.now(),
      });
      toast.success("Saved");
    } catch (err) {
      toast.error(`Save failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setSaving(false);
    }
  };

  const confirmDelete = async () => {
    try {
      await db().places.delete(place.id);
      toast.success("Location removed");
      onDeleted();
    } catch (err) {
      toast.error(`Delete failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const hasCoords = draft.lat.trim() !== "" && draft.lng.trim() !== "";

  return (
    <div className="space-y-4 rounded-2xl border border-[var(--line)] bg-white p-6">
      <Field label="Name">
        <input
          value={draft.name}
          onChange={(e) => set("name", e.target.value)}
          placeholder="e.g. Home, Library, Mum's house"
          className="h-11 w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
        />
      </Field>

      <Field
        label="GPS coordinates"
        hint={
          gpsEnabled
            ? "Used to auto-detect this place when James arrives."
            : "Optional — GPS auto-detection is off in System settings, but these still serve as background info."
        }
      >
        <div className="space-y-2">
          <div className="grid grid-cols-2 gap-2">
            <input
              value={hasCoords ? `${draft.lat}` : ""}
              readOnly
              placeholder="Latitude"
              className="h-11 w-full rounded-md border border-input bg-muted/40 px-3 py-2 font-mono text-sm text-muted-foreground"
            />
            <input
              value={hasCoords ? `${draft.lng}` : ""}
              readOnly
              placeholder="Longitude"
              className="h-11 w-full rounded-md border border-input bg-muted/40 px-3 py-2 font-mono text-sm text-muted-foreground"
            />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={useCurrentLocation}
              disabled={locating}
            >
              <MapPin />
              {locating ? "Locating…" : "Use current location"}
            </Button>
            {hasCoords && (
              <Button type="button" variant="ghost" size="sm" onClick={clearCoords}>
                <X />
                Clear
              </Button>
            )}
          </div>
        </div>
      </Field>

      <Field
        label="Snap radius (m)"
        hint="GPS auto-detect treats anything inside this radius as 'at this location'. Default 50m."
      >
        <input
          type="number"
          min={1}
          value={draft.radiusM}
          onChange={(e) => set("radiusM", e.target.value)}
          placeholder="50"
          className="h-11 w-32 rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
        />
      </Field>

      <Field label="Notes" hint="Useful context for suggestions here">
        <textarea
          rows={3}
          value={draft.notes}
          onChange={(e) => set("notes", e.target.value)}
          className="block w-full resize-y rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
        />
      </Field>

      <Field
        label="People commonly here"
        hint="Each tag boosts the speaker-ID prior when this place is the active location."
      >
        {people.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            Add people on the People tab first; they&apos;ll show up here as tags.
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
                    "min-h-[36px] rounded-full border px-3 py-1 text-xs font-medium transition-colors",
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

      <div className="flex items-center gap-2 pt-1">
        <Button onClick={save} disabled={saving}>
          {saving ? "Saving…" : "Save"}
        </Button>
        <Button variant="ghost" onClick={() => setConfirmDeleteOpen(true)}>
          <Trash2 />
          Delete
        </Button>
      </div>

      <ConfirmDialog
        open={confirmDeleteOpen}
        onOpenChange={setConfirmDeleteOpen}
        title={`Delete location "${place.name}"?`}
        description="Removes the place and its speaker-ID prior contribution. This can't be undone."
        confirmLabel="Delete"
        destructive
        onConfirm={confirmDelete}
      />
    </div>
  );
}

// --------------------------------------------------------------------------

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
