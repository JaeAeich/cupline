// How long the string is, and how long a shout would take to cover it.

export type Place = { lat: number; lon: number };

const EARTH_RADIUS_KM = 6371;
const SOUND_IN_AIR_M_PER_S = 343;

/** Great-circle (haversine) distance, rounded so it hints at "far" without pinpointing anyone. */
export function distanceKm(a: Place, b: Place): number {
  const radians = (degrees: number) => (degrees * Math.PI) / 180;
  const dLat = radians(b.lat - a.lat);
  const dLon = radians(b.lon - a.lon);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(radians(a.lat)) * Math.cos(radians(b.lat)) * Math.sin(dLon / 2) ** 2;
  const km = 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(h));
  return km < 50 ? 0 : Math.round(km / 50) * 50;
}

/** Seconds a shout would take to travel that far through air. */
export function shoutSeconds(km: number): number {
  return (km * 1000) / SOUND_IN_AIR_M_PER_S;
}
