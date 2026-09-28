import type { Env } from '../env';
import type { Role, UserStatus } from '@rr/types';
import { sessionCookieName, isProduction } from '../env';
import { newId, nowIso, isoIn } from './ids';
import { randomToken, sha256HexAsync } from './crypto';

/** Cookie-based sessions stored in D1 (system of record) with a KV cache. */

const KV_SESSION_PREFIX = 'sess:';
export const SESSION_TTL_DAYS = 30;

export interface SessionRecord {
  id: string;
  userId: string;
  expiresAt: string;
}

export interface SessionUserRecord {
  session: SessionRecord;
  user: {
    id: string;
    role: Role;
    email: string;
    phone: string | null;
    fullName: string;
    locale: 'en' | 'hi';
    status: UserStatus;
    avatarKey: string | null;
    emailVerifiedAt: string | null;
    phoneVerifiedAt: string | null;
    createdAt: string;
  };
}

export function parseCookies(header: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

export function serializeCookie(
  name: string,
  value: string,
  opts: { maxAge?: number; secure?: boolean; httpOnly?: boolean } = {},
): string {
  const parts = [`${name}=${encodeURIComponent(value)}`, 'Path=/', 'SameSite=Lax'];
  if (opts.httpOnly !== false) parts.push('HttpOnly');
  if (opts.maxAge !== undefined) parts.push(`Max-Age=${opts.maxAge}`);
  if (opts.secure) parts.push('Secure');
  return parts.join('; ');
}

export function sessionTokenFromRequest(request: Request, env: Env): string | null {
  const cookies = parseCookies(request.headers.get('Cookie'));
  return cookies[sessionCookieName(env)] ?? null;
}

export async function createSession(
  env: Env,
  userId: string,
  meta: { userAgent?: string | null; ip?: string | null } = {},
): Promise<{ token: string; expiresAt: string; sessionId: string }> {
  const token = randomToken(32);
  const tokenHash = await sha256HexAsync(token);
  const sessionId = newId();
  const expiresAt = isoIn(SESSION_TTL_DAYS * 24 * 60 * 60);
  await env.DB.prepare(
    `INSERT INTO sessions (id, user_id, token_hash, user_agent, ip, expires_at, last_seen_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(sessionId, userId, tokenHash, meta.userAgent ?? null, meta.ip ?? null, expiresAt, nowIso(), nowIso())
    .run();
  // The session is cached on first authenticated request (see getSessionUser),
  // where the full user row is available.
  return { token, expiresAt, sessionId };
}

export async function getSessionUser(env: Env, token: string): Promise<SessionUserRecord | null> {
  const tokenHash = await sha256HexAsync(token);
  const cacheKey = KV_SESSION_PREFIX + tokenHash;

  const cached = await env.KV.get(cacheKey, 'json');
  if (cached) {
    const record = cached as SessionUserRecord;
    // A partial cache entry (session only, no user) is treated as a miss.
    if (!record.session?.expiresAt || !record.user?.id) {
      await env.KV.delete(cacheKey);
    } else if (new Date(record.session.expiresAt).getTime() < Date.now()) {
      await env.KV.delete(cacheKey);
      return null;
    } else if (record.user.status !== 'ACTIVE') {
      return null;
    } else {
      return record;
    }
  }

  const row = await env.DB.prepare(
    `SELECT s.id AS session_id, s.expires_at, s.revoked_at,
            u.id, u.role, u.email, u.phone, u.full_name, u.locale, u.status,
            u.avatar_key, u.email_verified_at, u.phone_verified_at, u.created_at
     FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = ? LIMIT 1`,
  )
    .bind(tokenHash)
    .first<{
      session_id: string;
      expires_at: string;
      revoked_at: string | null;
      id: string;
      role: Role;
      email: string;
      phone: string | null;
      full_name: string;
      locale: 'en' | 'hi';
      status: UserStatus;
      avatar_key: string | null;
      email_verified_at: string | null;
      phone_verified_at: string | null;
      created_at: string;
    }>();

  if (!row || row.revoked_at || new Date(row.expires_at).getTime() < Date.now()) return null;
  if (row.status !== 'ACTIVE') return null;

  const record: SessionUserRecord = {
    session: { id: row.session_id, userId: row.id, expiresAt: row.expires_at },
    user: {
      id: row.id,
      role: row.role as SessionUserRecord['user']['role'],
      email: row.email,
      phone: row.phone,
      fullName: row.full_name,
      locale: row.locale,
      status: row.status,
      avatarKey: row.avatar_key,
      emailVerifiedAt: row.email_verified_at,
      phoneVerifiedAt: row.phone_verified_at,
      createdAt: row.created_at,
    },
  };

  const ttl = Math.max(60, Math.floor((new Date(row.expires_at).getTime() - Date.now()) / 1000));
  await env.KV.put(cacheKey, JSON.stringify(record), { expirationTtl: ttl });

  // Opportunistic heartbeat (non-blocking best effort).
  void env.DB.prepare('UPDATE sessions SET last_seen_at = ? WHERE id = ?')
    .bind(nowIso(), row.session_id)
    .run()
    .catch(() => undefined);

  return record;
}

export async function destroySession(env: Env, token: string): Promise<void> {
  const tokenHash = await sha256HexAsync(token);
  await env.DB.prepare('UPDATE sessions SET revoked_at = ? WHERE token_hash = ?')
    .bind(nowIso(), tokenHash)
    .run();
  await env.KV.delete(KV_SESSION_PREFIX + tokenHash);
}

export async function revokeAllSessions(env: Env, userId: string): Promise<void> {
  const rows = await env.DB.prepare('SELECT token_hash FROM sessions WHERE user_id = ? AND revoked_at IS NULL')
    .bind(userId)
    .all<{ token_hash: string }>();
  await env.DB.prepare('UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL')
    .bind(nowIso(), userId)
    .run();
  await Promise.all(rows.results.map((r) => env.KV.delete(KV_SESSION_PREFIX + r.token_hash)));
}

export function buildSessionCookie(env: Env, token: string): string {
  return serializeCookie(sessionCookieName(env), token, {
    maxAge: SESSION_TTL_DAYS * 24 * 60 * 60,
    secure: isProduction(env),
    httpOnly: true,
  });
}

export function clearSessionCookie(env: Env): string {
  return serializeCookie(sessionCookieName(env), '', { maxAge: 0, secure: isProduction(env) });
}
