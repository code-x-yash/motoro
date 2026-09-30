import type { Env } from '../env';
import { errors } from './errors';

/**
 * Lightweight fixed-window rate limiting.
 *
 * Workers KV free tier only allows 1,000 puts/day, so a KV round-trip per
 * request (the old behaviour — including the per-IP global limit in app.ts)
 * exhausts the quota within hours. Instead each isolate keeps counts in
 * memory and mirrors them to KV at window start and at most once per minute
 * while the bucket stays hot. KV is read only when an isolate first sees a
 * bucket in a window, so fresh isolates still inherit recent counts. Every
 * KV failure fails open — rate limiting never breaks requests.
 */

interface WindowState {
  count: number;
  resetAt: number;
}

interface MemoryEntry extends WindowState {
  lastWriteAt: number;
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetAt: number;
}

const memory = new Map<string, MemoryEntry>();
const MIRROR_INTERVAL_MS = 60_000;
const MAX_MEMORY_ENTRIES = 5_000;

function pruneExpired(now: number): void {
  if (memory.size < MAX_MEMORY_ENTRIES) return;
  for (const [key, entry] of memory) {
    if (entry.resetAt <= now) memory.delete(key);
  }
}

/** Clears in-process counters (dev/test reset endpoint). */
export function clearRateLimitMemory(): number {
  const cleared = memory.size;
  memory.clear();
  return cleared;
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
  pruneExpired(now);

  let entry = memory.get(key);
  if (!entry || entry.resetAt <= now) {
    let remote: WindowState | null = null;
    try {
      remote = (await env.KV.get(key, 'json')) as WindowState | null;
    } catch {
      // KV unavailable — start this window fresh in memory.
    }
    if (remote && remote.resetAt > now) {
      entry = { count: remote.count, resetAt: remote.resetAt, lastWriteAt: now };
    } else {
      entry = { count: 0, resetAt: now + windowSeconds * 1000, lastWriteAt: 0 };
    }
    memory.set(key, entry);
  }

  entry.count += 1;

  // Mirror to KV on window start and then at most once per minute per key.
  if (now - entry.lastWriteAt >= MIRROR_INTERVAL_MS) {
    entry.lastWriteAt = now;
    try {
      // Cloudflare KV requires expirationTtl >= 60s; clamp so short windows still persist.
      const ttl = Math.max(60, Math.ceil((entry.resetAt - now) / 1000));
      await env.KV.put(key, JSON.stringify({ count: entry.count, resetAt: entry.resetAt }), {
        expirationTtl: ttl,
      });
    } catch {
      // Quota exhausted or KV down — memory keeps enforcing for this isolate.
    }
  }

  return {
    allowed: entry.count <= limit,
    remaining: Math.max(0, limit - entry.count),
    resetAt: entry.resetAt,
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
