import type { Env } from '../env';
import { errors } from './errors';

/**
 * Lightweight fixed-window rate limiting backed by KV.
 * Auxiliary state only — never used as a source of truth for business data.
 */

interface WindowState {
  count: number;
  resetAt: number;
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetAt: number;
}

export async function rateLimit(
  env: Env,
  bucket: string,
  identifier: string,
  limit: number,
  windowSeconds: number,
): Promise<RateLimitResult> {
  const key = `rl:${bucket}:${identifier}`;
  const now = Date.now();
  let state: WindowState = { count: 0, resetAt: now + windowSeconds * 1000 };
  try {
    const raw = await env.KV.get(key, 'json');
    if (raw) {
      const parsed = raw as WindowState;
      if (parsed.resetAt > now) state = parsed;
    }
    state.count += 1;
    const ttl = Math.max(1, Math.ceil((state.resetAt - now) / 1000));
    await env.KV.put(key, JSON.stringify(state), { expirationTtl: ttl });
  } catch {
    // Fail open if KV is unavailable — availability beats strict limiting.
    return { allowed: true, remaining: limit, resetAt: now + windowSeconds * 1000 };
  }
  return {
    allowed: state.count <= limit,
    remaining: Math.max(0, limit - state.count),
    resetAt: state.resetAt,
  };
}

export async function enforceRateLimit(
  env: Env,
  bucket: string,
  identifier: string,
  limit: number,
  windowSeconds: number,
  message?: string,
): Promise<void> {
  const result = await rateLimit(env, bucket, identifier, limit, windowSeconds);
  if (!result.allowed) {
    const retryAfter = Math.max(1, Math.ceil((result.resetAt - Date.now()) / 1000));
    throw errors.rateLimited(
      message ?? `Too many requests. Please try again in ${retryAfter}s.`,
    );
  }
}
