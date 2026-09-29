import { Hono } from 'hono';
import type { Env } from '../env';
import { ok, fail } from '../lib/response';

const routes = new Hono<{ Bindings: Env }>();

routes.get('/', async (c) => {
  const started = Date.now();
  let dbOk = false;
  try {
    await c.env.DB.prepare('SELECT 1 AS ok').first();
    dbOk = true;
  } catch {
    dbOk = false;
  }
  const requestId = c.get('requestId');
  const payload = {
    status: dbOk ? 'ok' : 'degraded',
    environment: c.env.ENVIRONMENT,
    database: dbOk ? 'connected' : 'unavailable',
    latencyMs: Date.now() - started,
    time: new Date().toISOString(),
  };
  // 503 on degraded so uptime monitors and load balancers react.
  if (!dbOk) return fail('HEALTH_DEGRADED', 'Database unavailable.', requestId, 503, payload);
  return ok(payload, requestId);
});

export default routes;
