import type { Env } from '../env';
import { errors } from './errors';

/**
 * Geocoding adapter. `nominatim` (OpenStreetMap) is the default provider and
 * needs no API key; `none` disables the feature. Results are cached in KV so
 * we stay well within Nominatim's 1 req/s usage policy.
 */

export interface ReverseAddress {
  label: string;
  city: string | null;
  region: string | null;
  country: string | null;
  postcode: string | null;
}

export interface GeoSuggestion {
  label: string;
  latitude: number;
  longitude: number;
}

const NOMINATIM_BASE = 'https://nominatim.openstreetmap.org';
const CACHE_TTL_SECONDS = 7 * 24 * 3600;

let lastCallAt = 0;

async function nominatim(pathAndQuery: string): Promise<unknown> {
  const wait = 1100 - (Date.now() - lastCallAt);
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  lastCallAt = Date.now();
  const res = await fetch(`${NOMINATIM_BASE}${pathAndQuery}`, {
    headers: {
      'User-Agent': 'Motoro Assistant/1.0 (roadside assistance demo; contact: support@motoro.test)',
      Accept: 'application/json',
      'Accept-Language': 'en',
    },
  });
  if (!res.ok) {
    throw errors.unavailable('GEOCODER_ERROR', `The geocoding service returned ${res.status}.`);
  }
  return res.json();
}

function providerOf(env: Env): 'nominatim' | 'none' {
  const provider = (env.GEOCODER_PROVIDER ?? 'nominatim').toLowerCase();
  return provider === 'none' ? 'none' : 'nominatim';
}

export async function reverseGeocode(env: Env, latitude: number, longitude: number): Promise<ReverseAddress> {
  if (providerOf(env) === 'none') {
    throw errors.unavailable('GEOCODER_UNAVAILABLE', 'Address lookup is not configured.');
  }
  const cacheKey = `geo:rev:${latitude.toFixed(4)},${longitude.toFixed(4)}`;
  try {
    const hit = await env.KV.get(cacheKey, 'json');
    if (hit) return hit as ReverseAddress;
  } catch {
    // KV is auxiliary — fall through to the provider.
  }

  const data = (await nominatim(
    `/reverse?format=jsonv2&zoom=18&addressdetails=1&lat=${latitude}&lon=${longitude}`,
  )) as { display_name?: string; address?: Record<string, string> };
  if (!data?.display_name) {
    throw errors.unavailable('GEOCODER_EMPTY', 'No address found for that location.');
  }
  const a = data.address ?? {};
  const result: ReverseAddress = {
    label: data.display_name,
    city: a.city ?? a.town ?? a.village ?? a.suburb ?? null,
    region: a.state ?? a.region ?? null,
    country: a.country ?? null,
    postcode: a.postcode ?? null,
  };
  try {
    await env.KV.put(cacheKey, JSON.stringify(result), { expirationTtl: CACHE_TTL_SECONDS });
  } catch {
    // Best effort.
  }
  return result;
}

export async function geocodeSearch(env: Env, query: string, limit: number): Promise<GeoSuggestion[]> {
  if (providerOf(env) === 'none') {
    throw errors.unavailable('GEOCODER_UNAVAILABLE', 'Address search is not configured.');
  }
  const normalized = query.trim().toLowerCase();
  const cacheKey = `geo:q:${normalized}`;
  try {
    const hit = await env.KV.get(cacheKey, 'json');
    if (hit) return hit as GeoSuggestion[];
  } catch {
    // Fall through.
  }

  const data = (await nominatim(
    `/search?format=jsonv2&addressdetails=0&limit=${limit}&q=${encodeURIComponent(query.trim())}`,
  )) as Array<{ display_name?: string; lat?: string; lon?: string }>;
  const items: GeoSuggestion[] = (Array.isArray(data) ? data : [])
    .filter((entry) => entry.display_name && entry.lat && entry.lon)
    .map((entry) => ({
      label: entry.display_name as string,
      latitude: Number(entry.lat),
      longitude: Number(entry.lon),
    }));
  try {
    await env.KV.put(cacheKey, JSON.stringify(items), { expirationTtl: CACHE_TTL_SECONDS });
  } catch {
    // Best effort.
  }
  return items;
}
