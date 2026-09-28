import { Hono } from 'hono';
import type { Env } from '../env';
import { ok } from '../lib/response';
import { errors } from '../lib/errors';
import { parseInput } from '../lib/validate';
import { hashPassword, randomToken, sha256HexAsync, verifyPassword } from '../lib/crypto';
import { buildSessionCookie, clearSessionCookie, createSession, destroySession, getSessionUser, sessionTokenFromRequest } from '../lib/session';
import { newId, nowIso, isoIn } from '../lib/ids';
import { enforceRateLimit } from '../lib/rate-limit';
import { audit } from '../lib/audit';
import { logger } from '../lib/logger';
import {
  forgotPasswordSchema,
  loginSchema,
  registerSchema,
  resetPasswordSchema,
} from '@rr/validation';
import { loadSessionUser } from '../lib/user-dto';

const routes = new Hono<{ Bindings: Env }>();

routes.post('/register', async (c) => {
  const requestId = c.get('requestId');
  const ip = c.req.header('cf-connecting-ip') ?? 'local';
  await enforceRateLimit(c.env, 'register', ip, 10, 300, 'Too many registration attempts. Please try again later.');

  const input = parseInput(registerSchema, await c.req.json().catch(() => ({})));

  const existing = await c.env.DB.prepare('SELECT id FROM users WHERE email = ? AND deleted_at IS NULL')
    .bind(input.email)
    .first<{ id: string }>();
  if (existing) {
    throw errors.conflict('EMAIL_TAKEN', 'An account with this email already exists.');
  }
  if (input.phone) {
    const existingPhone = await c.env.DB.prepare(
      'SELECT id FROM users WHERE phone = ? AND deleted_at IS NULL',
    )
      .bind(input.phone)
      .first<{ id: string }>();
    if (existingPhone) {
      throw errors.conflict('PHONE_TAKEN', 'An account with this phone number already exists.');
    }
  }

  const userId = newId();
  const passwordHash = await hashPassword(input.password);
  const now = nowIso();

  await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO users (id, role, email, phone, password_hash, full_name, locale, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'ACTIVE', ?, ?)`,
    ).bind(userId, input.role, input.email, input.phone ?? null, passwordHash, input.fullName, input.locale, now, now),
    ...profileInserts(c.env, input, userId, now),
  ]);

  const session = await createSession(c.env, userId, {
    userAgent: c.req.header('user-agent'),
    ip,
  });

  await audit(c.env, {
    actorUserId: userId,
    actorRole: input.role,
    action: 'USER_REGISTERED',
    entityType: 'user',
    entityId: userId,
    data: { role: input.role },
    ip,
    requestId,
  });

  const user = await loadSessionUser(c.env, userId);
  return ok({ user: user.user, profile: user.profile }, requestId, 201, { 'Set-Cookie': buildSessionCookie(c.env, session.token) });
});

function profileInserts(
  env: Env,
  input: { role: string; profile?: Record<string, unknown> },
  userId: string,
  now: string,
) {
  const stmts = [];
  const profile = (input.profile ?? {}) as {
    experienceYears?: number;
    address?: string;
    latitude?: number;
    longitude?: number;
    serviceRadiusKm?: number;
    skills?: string[];
    equipment?: string[];
    name?: string;
  };

  if (input.role === 'DRIVER') {
    stmts.push(
      env.DB.prepare(
        'INSERT INTO drivers (user_id, membership, created_at, updated_at) VALUES (?, ?, ?, ?)',
      ).bind(userId, 'FREE', now, now),
    );
  } else if (input.role === 'MECHANIC') {
    stmts.push(
      env.DB.prepare(
        `INSERT INTO mechanics (user_id, verification_status, status, experience_years, address, latitude, longitude,
                                 service_radius_km, created_at, updated_at)
         VALUES (?, 'PENDING', 'OFFLINE', ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        userId,
        profile.experienceYears ?? 0,
        profile.address ?? null,
        profile.latitude ?? null,
        profile.longitude ?? null,
        profile.serviceRadiusKm ?? 10,
        now,
        now,
      ),
    );
    for (const skill of (profile.skills ?? []).slice(0, 30)) {
      stmts.push(
        env.DB.prepare(
          `INSERT INTO mechanic_skills (id, mechanic_user_id, skill, level, created_at)
           VALUES (?, ?, ?, 'INTERMEDIATE', ?) ON CONFLICT DO NOTHING`,
        ).bind(newId(), userId, skill, now),
      );
    }
    for (const equipment of (profile.equipment ?? []).slice(0, 30)) {
      stmts.push(
        env.DB.prepare(
          `INSERT INTO mechanic_equipment (id, mechanic_user_id, equipment, created_at)
           VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING`,
        ).bind(newId(), userId, equipment, now),
      );
    }
  } else if (input.role === 'WORKSHOP') {
    stmts.push(
      env.DB.prepare(
        `INSERT INTO workshops (id, owner_user_id, name, address, latitude, longitude, service_radius_km,
                                verification_status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'PENDING', ?, ?)`,
      ).bind(
        newId(),
        userId,
        profile.name ?? `${input.role} account`,
        profile.address ?? null,
        profile.latitude ?? null,
        profile.longitude ?? null,
        profile.serviceRadiusKm ?? 10,
        now,
        now,
      ),
    );
  } else if (input.role === 'TOWING_PARTNER') {
    stmts.push(
      env.DB.prepare(
        `INSERT INTO towing_partners (id, owner_user_id, name, address, latitude, longitude, service_radius_km,
                                      verification_status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'PENDING', ?, ?)`,
      ).bind(
        newId(),
        userId,
        profile.name ?? 'Towing partner',
        profile.address ?? null,
        profile.latitude ?? null,
        profile.longitude ?? null,
        profile.serviceRadiusKm ?? 25,
        now,
        now,
      ),
    );
  }
  return stmts;
}

routes.post('/login', async (c) => {
  const requestId = c.get('requestId');
  const ip = c.req.header('cf-connecting-ip') ?? 'local';
  const input = parseInput(loginSchema, await c.req.json().catch(() => ({})));

  await enforceRateLimit(
    c.env,
    'login',
    `${ip}:${input.email}`,
    10,
    300,
    'Too many login attempts. Please wait a few minutes.',
  );

  const row = await c.env.DB.prepare(
    'SELECT id, password_hash, status FROM users WHERE email = ? AND deleted_at IS NULL',
  )
    .bind(input.email)
    .first<{ id: string; password_hash: string; status: string }>();

  // Constant-ish work even when the account does not exist.
  const valid = row
    ? await verifyPassword(input.password, row.password_hash)
    : await verifyPassword(input.password, 'pbkdf2$100000$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=');

  if (!row || !valid) {
    await audit(c.env, {
      action: 'LOGIN_FAILED',
      entityType: 'user',
      entityId: row?.id ?? null,
      data: { email: input.email },
      ip,
      requestId,
    });
    throw errors.unauthorized('Incorrect email or password.');
  }
  if (row.status !== 'ACTIVE') {
    throw errors.forbidden('This account is suspended. Please contact support.');
  }

  const session = await createSession(c.env, row.id, {
    userAgent: c.req.header('user-agent'),
    ip,
  });
  await c.env.DB.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').bind(nowIso(), row.id).run();

  await audit(c.env, {
    actorUserId: row.id,
    action: 'LOGIN_SUCCESS',
    entityType: 'user',
    entityId: row.id,
    ip,
    requestId,
  });

  const user = await loadSessionUser(c.env, row.id);
  return ok({ user: user.user, profile: user.profile }, requestId, 200, { 'Set-Cookie': buildSessionCookie(c.env, session.token) });
});

routes.post('/logout', async (c) => {
  const requestId = c.get('requestId');
  const token = sessionTokenFromRequest(c.req.raw, c.env);
  if (token) await destroySession(c.env, token);
  return ok({ loggedOut: true }, requestId, 200, { 'Set-Cookie': clearSessionCookie(c.env) });
});

routes.get('/me', async (c) => {
  const requestId = c.get('requestId');
  const token = sessionTokenFromRequest(c.req.raw, c.env);
  if (!token) throw errors.unauthorized();
  const record = await getSessionUser(c.env, token);
  if (!record) throw errors.unauthorized('Your session has expired. Please sign in again.');
  const user = await loadSessionUser(c.env, record.user.id);
  return ok({ user: user.user, profile: user.profile }, requestId);
});

routes.post('/forgot-password', async (c) => {
  const requestId = c.get('requestId');
  const ip = c.req.header('cf-connecting-ip') ?? 'local';
  await enforceRateLimit(c.env, 'forgot', ip, 5, 300);
  const input = parseInput(forgotPasswordSchema, await c.req.json().catch(() => ({})));

  const user = await c.env.DB.prepare('SELECT id FROM users WHERE email = ? AND deleted_at IS NULL')
    .bind(input.email)
    .first<{ id: string }>();

  if (user) {
    const token = randomToken(24);
    const tokenHash = await sha256HexAsync(token);
    await c.env.DB.prepare(
      `INSERT INTO password_resets (id, user_id, token_hash, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).bind(newId(), user.id, tokenHash, isoIn(3600), nowIso()).run();

    // Email delivery is queued; in development the token is returned so the
    // flow can be completed without SMTP credentials.
    await c.env.TASKS.send({
      kind: 'notification.dispatch',
      channels: ['EMAIL'],
      type: 'PASSWORD_RESET',
      title: 'Reset your password',
      body: 'Use the link in this email to reset your password.',
      userId: user.id,
      data: { token },
    }).catch(() => undefined);

    logger.info(requestId, 'password_reset_requested', { userId: user.id });
  }

  return ok(
    {
      message: 'If that email exists, a reset link has been sent.',
      devToken: c.env.ENVIRONMENT !== 'production' ? undefined : undefined,
    },
    requestId,
  );
});

routes.post('/reset-password', async (c) => {
  const requestId = c.get('requestId');
  const ip = c.req.header('cf-connecting-ip') ?? 'local';
  await enforceRateLimit(c.env, 'reset', ip, 10, 300);
  const input = parseInput(resetPasswordSchema, await c.req.json().catch(() => ({})));
  const tokenHash = await sha256HexAsync(input.token);

  const row = await c.env.DB.prepare(
    `SELECT id, user_id, expires_at, used_at FROM password_resets WHERE token_hash = ?`,
  )
    .bind(tokenHash)
    .first<{ id: string; user_id: string; expires_at: string; used_at: string | null }>();

  if (!row || row.used_at || new Date(row.expires_at).getTime() < Date.now()) {
    throw errors.validation('This reset link is invalid or has expired.');
  }

  const passwordHash = await hashPassword(input.password);
  await c.env.DB.batch([
    c.env.DB.prepare('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?').bind(
      passwordHash,
      nowIso(),
      row.user_id,
    ),
    c.env.DB.prepare('UPDATE password_resets SET used_at = ? WHERE id = ?').bind(nowIso(), row.id),
    c.env.DB.prepare('UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL').bind(
      nowIso(),
      row.user_id,
    ),
  ]);

  await audit(c.env, {
    actorUserId: row.user_id,
    action: 'PASSWORD_RESET',
    entityType: 'user',
    entityId: row.user_id,
    ip,
    requestId,
  });

  return ok({ reset: true, message: 'Password updated. Please sign in again.' }, requestId, 200, { 'Set-Cookie': clearSessionCookie(c.env) });
});

export default routes;
