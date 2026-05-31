import { useEffect, useMemo, useRef, useState } from "react";
import { MapContainer, TileLayer, Marker, useMap, useMapEvents } from "react-leaflet";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { Search, MapPin, X, Crosshair } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { getCurrentPosition } from "@/lib/geo";

/**
 * Map-based location picker. Ported from
 * `legacy-src/components/MapPicker.tsx` and adapted to the rebuild's UI
 * primitives (no Dialog component in src/components/ui — we render a
 * fixed-position overlay instead, with the same UX). Used by
 * LocationsTab when the caregiver wants to set a place's lat/lng
 * visually instead of typing numbers.
 *
 * Network calls go to OpenStreetMap's free Nominatim service for both
 * forward search ("Search address or place name") and reverse geocoding
 * ("what's at this point") — no API key, no provider keys involved.
 * Falls back gracefully if Nominatim is unreachable.
 */

const markerIcon = L.icon({
  iconUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png",
  iconRetinaUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png",
  shadowUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png",
  iconSize: [25, 41],
  iconAnchor: [12, 41],
  popupAnchor: [1, -34],
  shadowSize: [41, 41],
});

export type MapPickResult = {
  lat: number;
  lng: number;
  name?: string;
};

function ClickHandler({ onPick }: { onPick: (lat: number, lng: number) => void }) {
  useMapEvents({
    click(e) {
      onPick(e.latlng.lat, e.latlng.lng);
    },
  });
  return null;
}

function Recenter({ lat, lng, zoom }: { lat: number; lng: number; zoom?: number }) {
  const map = useMap();
  useEffect(() => {
    map.setView([lat, lng], zoom ?? map.getZoom(), { animate: true });
  }, [lat, lng, zoom, map]);
  return null;
}

type ReverseResult = { display_name?: string; address?: Record<string, string | undefined> };

async function reverseGeocode(lat: number, lng: number): Promise<string | null> {
  try {
    const r = await fetch(
      `https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lng}&zoom=18&addressdetails=1`,
      { headers: { Accept: "application/json" } },
    );
    if (!r.ok) return null;
    const j = (await r.json()) as ReverseResult;
    const a = j.address ?? {};
    const short =
      a.amenity ||
      a.shop ||
      a.building ||
      a.tourism ||
      a.leisure ||
      a.house_name ||
      [a.house_number, a.road].filter(Boolean).join(" ") ||
      a.suburb ||
      a.village ||
      a.town ||
      a.city ||
      j.display_name?.split(",")[0];
    return short ?? null;
  } catch {
    return null;
  }
}

type SearchResult = {
  display_name: string;
  lat: string;
  lon: string;
};

async function searchPlace(q: string): Promise<SearchResult[]> {
  try {
    const r = await fetch(
      `https://nominatim.openstreetmap.org/search?format=json&limit=6&q=${encodeURIComponent(q)}`,
      { headers: { Accept: "application/json" } },
    );
    if (!r.ok) return [];
    return (await r.json()) as SearchResult[];
  } catch {
    return [];
  }
}

const INPUT_CLASSES =
  "w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring";

export function MapPicker({
  open,
  onOpenChange,
  initialLat,
  initialLng,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  initialLat?: number;
  initialLng?: number;
  onConfirm: (r: MapPickResult) => void;
}) {
  // Default to Auckland — same as the legacy. The first save against a
  // real location resets the default for the user's next session via
  // initialLat/initialLng coming from the persisted place row.
  const startLat = initialLat && initialLat !== 0 ? initialLat : -36.8485;
  const startLng = initialLng && initialLng !== 0 ? initialLng : 174.7633;

  const [pos, setPos] = useState<{ lat: number; lng: number }>({
    lat: startLat,
    lng: startLng,
  });
  const [name, setName] = useState<string>("");
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [zoom, setZoom] = useState<number>(initialLat ? 16 : 12);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Reset when the overlay reopens — caregiver expects a fresh search.
  useEffect(() => {
    if (open) {
      setPos({ lat: startLat, lng: startLng });
      setName("");
      setQuery("");
      setResults([]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void reverseGeocode(pos.lat, pos.lng).then((n) => {
      if (!cancelled && n) setName(n);
    });
    return () => {
      cancelled = true;
    };
  }, [pos.lat, pos.lng, open]);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (!query.trim()) {
      setResults([]);
      return;
    }
    debounceRef.current = setTimeout(() => {
      void (async () => {
        setSearching(true);
        try {
          const r = await searchPlace(query);
          setResults(r);
        } finally {
          setSearching(false);
        }
      })();
    }, 350);
  }, [query]);

  // Named without the use* prefix so React's rules-of-hooks lint doesn't
  // mistake it for a custom hook called inside an onClick callback.
  async function pickMyLocation() {
    try {
      const p = await getCurrentPosition();
      setPos({ lat: p.coords.latitude, lng: p.coords.longitude });
      setZoom(17);
    } catch {
      toast.error("Could not read GPS");
    }
  }

  function pickResult(r: SearchResult) {
    const lat = Number(r.lat);
    const lng = Number(r.lon);
    setPos({ lat, lng });
    setZoom(17);
    setName(r.display_name.split(",")[0]);
    setResults([]);
    setQuery("");
  }

  const center = useMemo(() => [pos.lat, pos.lng] as [number, number], [pos]);

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-[1000] flex items-center justify-center bg-black/50 p-4">
      <div className="flex h-[90vh] w-full max-w-3xl flex-col overflow-hidden rounded-2xl border border-border bg-card shadow-2xl">
        <div className="flex items-center justify-between gap-2 border-b border-border px-4 py-3">
          <div className="flex items-center gap-2">
            <MapPin className="size-5" />
            <span className="text-sm font-medium">Pick a location on the map</span>
          </div>
          <button
            type="button"
            onClick={() => onOpenChange(false)}
            className="rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
            aria-label="Close"
          >
            <X className="size-4" />
          </button>
        </div>

        <div className="space-y-3 p-4">
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <input
              className={`${INPUT_CLASSES} pl-9`}
              placeholder="Search address or place name…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            {(results.length > 0 || searching) && (
              <div className="absolute z-[1100] mt-1 max-h-72 w-full overflow-y-auto rounded-md border border-border bg-popover shadow-md">
                {searching && (
                  <div className="px-3 py-2 text-sm text-muted-foreground">Searching…</div>
                )}
                {results.map((r, i) => (
                  <button
                    key={`${r.lat}-${r.lon}-${i}`}
                    type="button"
                    onClick={() => pickResult(r)}
                    className="block w-full px-3 py-2 text-left text-sm hover:bg-accent hover:text-accent-foreground"
                  >
                    {r.display_name}
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={() => void pickMyLocation()}>
              <Crosshair className="size-4" />
              Use my location
            </Button>
            <span className="text-xs text-muted-foreground">Or tap the map to drop a pin.</span>
          </div>

          <input
            className={INPUT_CLASSES}
            placeholder="Place name (auto-filled from the map)"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>

        <div className="min-h-[300px] flex-1 px-4">
          <MapContainer
            center={center}
            zoom={zoom}
            style={{ height: "100%", width: "100%", borderRadius: "0.5rem" }}
          >
            <TileLayer
              attribution='&copy; <a href="https://osm.org/copyright">OpenStreetMap</a> contributors'
              url="https://{s}.tile.openstreetmap.org/{z}/{y}/{x}.png"
            />
            <Marker position={center} icon={markerIcon} />
            <ClickHandler onPick={(lat, lng) => setPos({ lat, lng })} />
            <Recenter lat={pos.lat} lng={pos.lng} zoom={zoom} />
          </MapContainer>
        </div>

        <div className="flex items-center justify-between gap-3 border-t border-border px-4 py-3 text-xs text-muted-foreground">
          <span>
            {pos.lat.toFixed(5)}, {pos.lng.toFixed(5)}
          </span>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button
              size="sm"
              onClick={() => {
                onConfirm({ lat: pos.lat, lng: pos.lng, name: name || undefined });
                onOpenChange(false);
              }}
            >
              Use this location
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
