/** Great-circle distance in metres (haversine). Free, server-side, no map API call. */
export function distanceMeters(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const R = 6_371_000;
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.min(1, Math.sqrt(h))));
}

export function hasCoords<T extends { lat?: number | null; lng?: number | null }>(p: T | null | undefined): p is T & { lat: number; lng: number } {
  return Boolean(p) && typeof p!.lat === 'number' && typeof p!.lng === 'number';
}
