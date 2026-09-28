import { Hono } from 'hono';
import type { Env } from '../env';
import { ok } from '../lib/response';

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
  return ok(
    {
      status: dbOk ? 'ok' : 'degraded',
      environment: c.env.ENVIRONMENT,
      database: dbOk ? 'connected' : 'unavailable',
      latencyMs: Date.now() - started,
      time: new Date().toISOString(),
    },
    c.get('requestId'),
  );
});

export default routes;
