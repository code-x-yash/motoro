import { Hono, type Context } from 'hono';
import type { Env } from './env';
import { allowedOrigins, isDev } from './env';
import { attachUser } from './lib/auth';
import { newId } from './lib/ids';
import { fail } from './lib/response';
import { isAppError } from './lib/errors';
import { logger } from './lib/logger';
import { enforceRateLimit } from './lib/rate-limit';

import healthRoutes from './routes/health';
import authRoutes from './routes/auth';
import profileRoutes from './routes/profile';
import vehicleRoutes from './routes/vehicles';
import emergencyRoutes from './routes/emergencies';
import dispatchRoutes from './routes/dispatch';
import jobRoutes from './routes/jobs';
import mechanicRoutes from './routes/mechanics';
import uploadRoutes from './routes/uploads';
import notificationRoutes from './routes/notifications';
import realtimeRoutes from './routes/realtime';
import operationsRoutes from './routes/operations';
import adminRoutes from './routes/admin';
import reviewRoutes from './routes/reviews';
import devRoutes from './routes/dev';

export function createApp(): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>();

  // WebSocket upgrade responses (101) carry immutable headers; never touch them.
  const setResHeader = (c: Context<{ Bindings: Env }>, name: string, value: string): void => {
    if (c.res.status === 101) return;
    try {
      c.res.headers.set(name, value);
    } catch {
      /* immutable response headers */
    }
  };

  // --- correlation id + response header -------------------------------------
  app.use('*', async (c, next) => {
    const incoming = c.req.header('x-request-id');
    const requestId = incoming && incoming.length <= 64 ? incoming : newId();
    c.set('requestId', requestId);
    await next();
    setResHeader(c, 'x-request-id', requestId);
  });

  // --- security headers ------------------------------------------------------
  app.use('*', async (c, next) => {
    await next();
    setResHeader(c, 'x-content-type-options', 'nosniff');
    setResHeader(c, 'x-frame-options', 'DENY');
    setResHeader(c, 'referrer-policy', 'no-referrer');
    setResHeader(c, 'cross-origin-opener-policy', 'same-origin');
  });

  // --- CORS (credentialed, allow-listed origins) -----------------------------
  app.use('*', async (c, next) => {
    const origin = c.req.header('origin');
    const allowed = allowedOrigins(c.env);
    if (origin && allowed.includes(origin)) {
      setResHeader(c, 'access-control-allow-origin', origin);
      setResHeader(c, 'access-control-allow-credentials', 'true');
      setResHeader(c, 'vary', 'Origin');
    }
    if (c.req.method === 'OPTIONS') {
      const headers: Record<string, string> = {
        'access-control-allow-methods': 'GET,POST,PATCH,PUT,DELETE,OPTIONS',
        'access-control-allow-headers': 'content-type,x-request-id,x-motoro-client,authorization',
        'access-control-max-age': '86400',
      };
      if (origin && allowed.includes(origin)) headers['access-control-allow-origin'] = origin;
      return new Response(null, { status: 204, headers });
    }
    await next();
  });

  // --- basic per-IP rate limiting -------------------------------------------
  app.use('/api/*', async (c, next) => {
    const ip = c.req.header('cf-connecting-ip') || c.req.header('x-forwarded-for') || 'local';
    try {
      await enforceRateLimit(c.env, 'global', ip, 600, 60);
    } catch (err) {
      if (isAppError(err)) {
        return fail(err.code, err.message, c.get('requestId'), err.status);
      }
      throw err;
    }
    await next();
  });

  // --- attach session user ---------------------------------------------------
  app.use('/api/*', attachUser);

  // --- CSRF-ish protection: state-changing calls must come from an allowed origin
  app.use('/api/*', async (c, next) => {
    const method = c.req.method;
    if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return next();
    const origin = c.req.header('origin');
    if (origin) {
      const allowed = allowedOrigins(c.env);
      if (!allowed.includes(origin)) {
        return fail('ORIGIN_NOT_ALLOWED', 'Origin not allowed.', c.get('requestId'), 403);
      }
    }
    return next();
  });

  // --- routes ----------------------------------------------------------------
  app.route('/api/health', healthRoutes);
  app.route('/api/auth', authRoutes);
  app.route('/api/me', profileRoutes);
  app.route('/api/vehicles', vehicleRoutes);
  app.route('/api/emergencies', emergencyRoutes);
  app.route('/api/dispatch', dispatchRoutes);
  app.route('/api/jobs', jobRoutes);
  app.route('/api/mechanics', mechanicRoutes);
  app.route('/api/uploads', uploadRoutes);
  app.route('/api/notifications', notificationRoutes);
  app.route('/api/realtime', realtimeRoutes);
  app.route('/api/operations', operationsRoutes);
  app.route('/api/admin', adminRoutes);
  app.route('/api/reviews', reviewRoutes);
  // Gated inside the router itself (requires ENABLE_SEED_ROUTES + non-production).
  app.route('/api/dev', devRoutes);

  // --- 404 -------------------------------------------------------------------
  app.notFound((c) =>
    fail('NOT_FOUND', `Route ${c.req.method} ${c.req.path} not found.`, c.get('requestId') ?? 'n/a', 404),
  );

  // --- errors ----------------------------------------------------------------
  app.onError((err, c) => {
    const requestId = c.get('requestId') ?? newId();
    if (isAppError(err)) {
      if (err.status >= 500) {
        logger.error(requestId, 'request_error', { code: err.code, message: err.message });
      } else {
        logger.warn(requestId, 'request_rejected', { code: err.code, message: err.message });
      }
      return fail(err.code, err.message, requestId, err.status, err.details);
    }
    logger.error(requestId, 'unhandled_error', {
      message: err?.message ?? String(err),
      stack: err instanceof Error ? err.stack?.slice(0, 600) : undefined,
    });
    return fail(
      'INTERNAL_ERROR',
      'Something went wrong. Please try again.',
      requestId,
      500,
      isDev(c.env)
        ? { message: err?.message ?? String(err), stack: err instanceof Error ? err.stack?.slice(0, 800) : undefined }
        : undefined,
    );
  });

  return app;
}
