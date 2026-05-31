import { db, type Place } from "./db";

export function haversineMeters(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number,
): number {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

export async function findNearestPlace(
  lat: number,
  lng: number,
): Promise<{ place: Place; distance_m: number } | null> {
  const places = await db.places.toArray();
  let best: { place: Place; distance_m: number } | null = null;
  for (const p of places) {
    const d = haversineMeters(lat, lng, p.lat, p.lng);
    if (d <= (p.radius_m ?? 75) && (!best || d < best.distance_m)) {
      best = { place: p, distance_m: d };
    }
  }
  return best;
}

export function getCurrentPosition(): Promise<GeolocationPosition> {
  return new Promise((resolve, reject) => {
    if (!("geolocation" in navigator)) {
      reject(new Error("Geolocation not supported"));
      return;
    }
    navigator.geolocation.getCurrentPosition(resolve, reject, {
      enableHighAccuracy: false,
      timeout: 8000,
      maximumAge: 60000,
    });
  });
}