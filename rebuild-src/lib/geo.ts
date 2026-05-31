/**
 * Browser geolocation wrapped as a Promise. Used by the MapPicker's "use
 * my location" button. Rejects when the user denies permission or the
 * device has no GPS — the caller surfaces a toast and the user keeps
 * typing coordinates / clicking on the map.
 */
export function getCurrentPosition(
  options: PositionOptions = { enableHighAccuracy: true, timeout: 8_000 },
): Promise<GeolocationPosition> {
  return new Promise((resolve, reject) => {
    if (typeof navigator === "undefined" || !navigator.geolocation) {
      reject(new Error("Geolocation not available"));
      return;
    }
    navigator.geolocation.getCurrentPosition(resolve, reject, options);
  });
}
