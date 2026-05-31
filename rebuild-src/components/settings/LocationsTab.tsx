import { useEffect, useMemo, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { nanoid } from "nanoid";
import { toast } from "sonner";
import { ChevronDown, ChevronRight, Plus, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { db, type Person, type Place } from "@/lib/db";
import { useSettings } from "@/lib/settings";
import { cn } from "@/lib/cn";
import { MapPicker, type MapPickResult } from "@/components/MapPicker";

/**
 * Locations tab. Ported from `legacy-src/routes/settings.tsx` PlacesTab,
 * adapted to the rebuild's `Place` shape (camelCase + optional lat/lng +
 * `personIds` for the "people commonly here" multi-select).
 *
 * No real map picker yet — lat/lng are plain number inputs, hidden entirely
 * when `settings.gpsEnabled === false` (the speaker-ID prior only needs
 * `personIds` to do its job, and a single-user iPad set up at the kitchen
 * table doesn't need GPS to know which room it's in).
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
  const settings = useSettings();
  const places = useLiveQuery(() => db().places.orderBy("name").toArray(), [], EMPTY_PLACES);
  const people = useLiveQuery(() => db().people.orderBy("name").toArray(), [], EMPTY_PEOPLE);

  const addPlace = async () => {
    const now = Date.now();
    await db().places.add({
      id: nanoid(),
      name: "New location",
      personIds: [],
      createdAt: now,
      updatedAt: now,
    });
    toast.success("Location added");
  };

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-4">
          <div>
            <CardTitle>Locations</CardTitle>
            <CardDescription>
              Places James talks at — home, library, the cafe round the corner. Tagging the people
              commonly here boosts the speaker-ID prior at this location.
            </CardDescription>
          </div>
          <Button variant="default" onClick={addPlace}>
            <Plus />
            Add place
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {places.length === 0 ? (
          <p className="rounded-md border border-dashed border-border bg-muted/30 px-4 py-6 text-center text-sm text-muted-foreground">
            No locations yet. Add one above.
          </p>
        ) : (
          places.map((place) => (
            <PlaceRow
              key={place.id}
              place={place}
              people={people}
              gpsEnabled={settings.gpsEnabled}
            />
          ))
        )}
      </CardContent>
    </Card>
  );
}

function PlaceRow({
  place,
  people,
  gpsEnabled,
}: {
  place: Place;
  people: Person[];
  gpsEnabled: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<PlaceDraft>(() => draftFromPlace(place));
  const [saving, setSaving] = useState(false);
  const [mapOpen, setMapOpen] = useState(false);

  // Map-picker confirm: drop the picked lat/lng into the draft, and if
  // the user hasn't typed their own name yet, take the reverse-geocoded
  // place name from the map too. Numbers go through toFixed(6) to match
  // the form's stringified shape so the controlled inputs stay stable.
  const onMapConfirm = (r: MapPickResult) => {
    setDraft((d) => ({
      ...d,
      lat: r.lat.toFixed(6),
      lng: r.lng.toFixed(6),
      name: d.name.trim() ? d.name : (r.name ?? d.name),
    }));
  };

  // Keep draft in sync if the place was edited elsewhere (e.g. created
  // moments ago with the "Add place" button) but only while collapsed —
  // mid-edit changes shouldn't get clobbered by the live query.
  useEffect(() => {
    if (!open) setDraft(draftFromPlace(place));
  }, [place, open]);

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
      const radiusNum = draft.radiusM.trim() === "" ? undefined : Number(draft.radiusM);
      await db().places.put({
        ...place,
        name: trimmedName,
        lat: Number.isFinite(latNum) ? latNum : undefined,
        lng: Number.isFinite(lngNum) ? lngNum : undefined,
        radiusM: Number.isFinite(radiusNum) ? radiusNum : undefined,
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

  const remove = async () => {
    if (!confirm(`Delete location "${place.name}"?`)) return;
    await db().places.delete(place.id);
    toast.success("Location removed");
  };

  const summary = useMemo(() => {
    const parts: string[] = [];
    if (place.personIds && place.personIds.length > 0) {
      parts.push(`${place.personIds.length} ${place.personIds.length === 1 ? "person" : "people"}`);
    }
    if (place.lat != null && place.lng != null) {
      parts.push(`${place.lat.toFixed(4)}, ${place.lng.toFixed(4)}`);
    }
    if (place.radiusM != null) parts.push(`${place.radiusM}m radius`);
    return parts.join(" · ");
  }, [place]);

  return (
    <div className="rounded-xl border border-border bg-card">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-muted/40"
      >
        {open ? (
          <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
        )}
        <div className="min-w-0 flex-1">
          <div className="truncate font-medium">{place.name}</div>
          {summary && <div className="truncate text-xs text-muted-foreground">{summary}</div>}
        </div>
      </button>
      {open && (
        <div className="space-y-4 border-t border-border bg-muted/20 p-4">
          <Field label="Name">
            <TextInput
              value={draft.name}
              onChange={(v) => set("name", v)}
              placeholder="e.g. Home, Library, Mum's house"
            />
          </Field>

          {gpsEnabled && (
            <div className="grid grid-cols-3 gap-3">
              <Field label="Latitude">
                <div className="flex items-center gap-2">
                  <TextInput
                    type="number"
                    value={draft.lat}
                    onChange={(v) => set("lat", v)}
                    placeholder="optional"
                  />
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => setMapOpen(true)}
                    className="shrink-0"
                  >
                    Pick on map
                  </Button>
                </div>
              </Field>
              <Field label="Longitude">
                <TextInput
                  type="number"
                  value={draft.lng}
                  onChange={(v) => set("lng", v)}
                  placeholder="optional"
                />
              </Field>
              <Field label="Radius (m)">
                <TextInput
                  type="number"
                  value={draft.radiusM}
                  onChange={(v) => set("radiusM", v)}
                  placeholder="optional"
                />
              </Field>
            </div>
          )}

          <Field label="Notes" hint="Useful context for suggestions here">
            <Textarea rows={3} value={draft.notes} onChange={(v) => set("notes", v)} />
          </Field>

          <Field
            label="People commonly here"
            hint="Each tag boosts the speaker-ID prior when this place is the active location."
          >
            {people.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                Add people on the People page first; they'll show up here as tags.
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

          <div className="flex items-center gap-2 pt-1">
            <Button onClick={save} disabled={saving}>
              {saving ? "Saving…" : "Save"}
            </Button>
            <Button variant="ghost" onClick={remove}>
              <Trash2 />
              Delete
            </Button>
          </div>
        </div>
      )}
      <MapPicker
        open={mapOpen}
        onOpenChange={setMapOpen}
        initialLat={draft.lat.trim() === "" ? undefined : Number(draft.lat)}
        initialLng={draft.lng.trim() === "" ? undefined : Number(draft.lng)}
        onConfirm={onMapConfirm}
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

type TextInputProps = Omit<React.InputHTMLAttributes<HTMLInputElement>, "value" | "onChange"> & {
  value: string;
  onChange: (value: string) => void;
};

function TextInput(props: TextInputProps) {
  const { value, onChange, className, ...rest } = props;
  return (
    <input
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className={
        "w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring " +
        (className ?? "")
      }
      {...rest}
    />
  );
}

function Textarea({
  rows,
  value,
  onChange,
}: {
  rows: number;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <textarea
      rows={rows}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="block w-full resize-y rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
    />
  );
}
