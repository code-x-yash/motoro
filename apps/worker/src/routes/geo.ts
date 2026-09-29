import { Hono } from 'hono';
import type { Env } from '../env';
import { ok } from '../lib/response';
import { parseInput } from '../lib/validate';
import { enforceRateLimit } from '../lib/rate-limit';
import { geocodeSearchSchema, reverseGeocodeSchema } from '@rr/validation';
import { geocodeSearch, reverseGeocode } from '../lib/geocoder';

const routes = new Hono<{ Bindings: Env }>();

/** Coordinates → address label (used when the driver taps "Use my location"). */
routes.get('/reverse', async (c) => {
  const input = parseInput(reverseGeocodeSchema, c.req.query());
  const ip = c.req.header('cf-connecting-ip') ?? c.req.header('x-forwarded-for') ?? 'anonymous';
  await enforceRateLimit(c.env, 'geo', ip, 30, 60, 'Too many address lookups. Try again in a minute.');
  const address = await reverseGeocode(c.env, input.latitude, input.longitude);
  return ok({ address, source: 'openstreetmap' }, c.get('requestId'));
});

/** Address text → coordinate suggestions. */
routes.get('/search', async (c) => {
  const input = parseInput(geocodeSearchSchema, c.req.query());
  const ip = c.req.header('cf-connecting-ip') ?? c.req.header('x-forwarded-for') ?? 'anonymous';
  await enforceRateLimit(c.env, 'geo', ip, 30, 60, 'Too many address searches. Try again in a minute.');
  const items = await geocodeSearch(c.env, input.query, input.limit);
  return ok({ items, source: 'openstreetmap' }, c.get('requestId'));
});

export default routes;
