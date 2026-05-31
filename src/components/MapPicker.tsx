import { useEffect, useMemo, useRef, useState } from "react";
import { MapContainer, TileLayer, Marker, useMap, useMapEvents } from "react-leaflet";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { Search, Crosshair, MapPin } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";
import { getCurrentPosition } from "@/lib/geo";

// Fix default marker icons (Leaflet bundler quirk)
const markerIcon = L.icon({
  iconUrl:
    "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png",
  iconRetinaUrl:
    "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png",
  shadowUrl:
    "https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png",
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

function ClickHandler({
  onPick,
}: {
  onPick: (lat: number, lng: number) => void;
}) {
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

async function reverseGeocode(lat: number, lng: number): Promise<string | null> {
  try {
    const r = await fetch(
      `https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lng}&zoom=18&addressdetails=1`,
      { headers: { Accept: "application/json" } },
    );
    if (!r.ok) return null;
    const j = await r.json();
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
  const r = await fetch(
    `https://nominatim.openstreetmap.org/search?format=json&limit=6&q=${encodeURIComponent(q)}`,
    { headers: { Accept: "application/json" } },
  );
  if (!r.ok) return [];
  return r.json();
}

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
  // Default to Auckland if nothing supplied
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

  // Reset when reopened
  useEffect(() => {
    if (open) {
      setPos({ lat: startLat, lng: startLng });
      setName("");
      setQuery("");
      setResults([]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Reverse geocode whenever the marker moves
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    reverseGeocode(pos.lat, pos.lng).then((n) => {
      if (!cancelled && n) setName(n);
    });
    return () => {
      cancelled = true;
    };
  }, [pos.lat, pos.lng, open]);

  // Debounced search
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (!query.trim()) {
      setResults([]);
      return;
    }
    let cancelled = false;
    debounceRef.current = setTimeout(async () => {
      setSearching(true);
      try {
        const r = await searchPlace(query);
        if (!cancelled) setResults(r);
      } finally {
        if (!cancelled) setSearching(false);
      }
    }, 350);
    return () => {
      cancelled = true;
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [query]);

  async function useGps() {
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

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <MapPin className="size-5" /> Pick a location on the map
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-3">
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              className="pl-9"
              placeholder="Search address or place name…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            {(results.length > 0 || searching) && (
              <div className="absolute z-[1000] mt-1 w-full overflow-hidden rounded-md border bg-popover shadow-md">
                {searching && (
                  <div className="px-3 py-2 text-sm text-muted-foreground">
                    Searching…
                  </div>
                )}
                {results.map((r, i) => (
                  <button
                    key={i}
                    type="button"
                    className="block w-full truncate px-3 py-2 text-left text-sm hover:bg-secondary"
                    onClick={() => pickResult(r)}
                  >
                    {r.display_name}
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="h-[420px] overflow-hidden rounded-lg border">
            <MapContainer
              center={center}
              zoom={zoom}
              style={{ height: "100%", width: "100%" }}
            >
              <TileLayer
                attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
                url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
              />
              <Marker
                position={center}
                icon={markerIcon}
                draggable
                eventHandlers={{
                  dragend: (e) => {
                    const m = e.target as L.Marker;
                    const ll = m.getLatLng();
                    setPos({ lat: ll.lat, lng: ll.lng });
                  },
                }}
              />
              <ClickHandler
                onPick={(lat, lng) => setPos({ lat, lng })}
              />
              <Recenter lat={pos.lat} lng={pos.lng} zoom={zoom} />
            </MapContainer>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
            <div className="text-muted-foreground">
              {name ? <span className="font-medium text-foreground">{name}</span> : "Tap the map or drag the pin"}
              <span className="ml-2 tabular-nums">
                {pos.lat.toFixed(5)}, {pos.lng.toFixed(5)}
              </span>
            </div>
            <Button variant="secondary" size="sm" onClick={useGps}>
              <Crosshair className="size-4" /> Use my GPS
            </Button>
          </div>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            onClick={() => {
              onConfirm({ lat: pos.lat, lng: pos.lng, name });
              onOpenChange(false);
            }}
          >
            Use this location
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}