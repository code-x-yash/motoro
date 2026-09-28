/** Geodesy helpers for dispatch (distance, ETA). */

const EARTH_RADIUS_KM = 6371;

export function toRad(deg: number): number {
  return (deg * Math.PI) / 180;
}

export function distanceKm(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number,
): number {
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Average urban speed used for ETA estimates (km/h). */
export const AVG_SPEED_KMH = 30;

export function etaMinutes(distanceInKm: number, speedKmh = AVG_SPEED_KMH): number {
  if (!Number.isFinite(distanceInKm) || distanceInKm < 0) return 0;
  return Math.max(1, Math.round((distanceInKm / speedKmh) * 60));
}

/** Rough initial bearing in degrees (0-360). */
export function bearingDeg(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number,
): number {
  const φ1 = toRad(lat1);
  const φ2 = toRad(lat2);
  const Δλ = toRad(lon2 - lon1);
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  const θ = Math.atan2(y, x);
  return (((θ * 180) / Math.PI) + 360) % 360;
}

export function roundKm(value: number): number {
  return Math.round(value * 10) / 10;
}
