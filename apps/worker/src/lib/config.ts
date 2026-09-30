import { DEFAULT_CONFIG } from '@rr/config';
import type { Env } from '../env';
import { nowIso } from './ids';

/**
 * Runtime platform configuration stored in D1 (`platform_config`) with a short
 * lived KV cache. Falls back to DEFAULT_CONFIG when unset.
 */

const KV_PREFIX = 'cfg:';
// Long TTL: the key is deleted on every admin save (invalidation), so TTL is
// only a safety net. A short TTL meant one KV put per isolate per minute —
// ~1,440 puts/day on its own, blowing the free-tier quota of 1,000/day.
const TTL_SECONDS = 3600;

type ConfigTree = Record<string, unknown>;

let memoryCache: { at: number; value: unknown } | null = null;
const MEMORY_TTL_MS = 15_000;
/** After a failed KV invalidation, read D1 directly for a minute. */
let d1OverrideUntil = 0;

function deepMerge<T>(base: T, override: Record<string, unknown>): T {
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(override)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && typeof out[k] === 'object' && out[k] !== null && !Array.isArray(out[k])) {
      out[k] = deepMerge(out[k] as Record<string, unknown>, v as Record<string, unknown>);
    } else {
      out[k] = v;
    }
  }
  return out as T;
}

export interface RuntimeConfig {
  dispatch: typeof DEFAULT_CONFIG.dispatch;
  pricing: typeof DEFAULT_CONFIG.pricing;
  cancellation: typeof DEFAULT_CONFIG.cancellation;
  uploads: typeof DEFAULT_CONFIG.uploads;
}

export async function getConfig(env: Env): Promise<RuntimeConfig> {
  if (memoryCache && Date.now() - memoryCache.at < MEMORY_TTL_MS) {
    return memoryCache.value as RuntimeConfig;
  }
  let overrides: ConfigTree = {};
  let fromKv = false;
  if (Date.now() >= d1OverrideUntil) {
    try {
      const cached = await env.KV.get(KV_PREFIX + 'tree', 'json');
      if (cached) {
        overrides = cached as ConfigTree;
        fromKv = true;
      }
    } catch {
      // KV unavailable — fall through to D1.
    }
  }
  if (!fromKv) {
    try {
      const rows = await env.DB.prepare('SELECT key, value_json FROM platform_config').all<{
        key: string;
        value_json: string;
      }>();
      for (const row of rows.results) {
        try {
          overrides[row.key] = JSON.parse(row.value_json);
        } catch {
          /* ignore malformed rows */
        }
      }
      try {
        await env.KV.put(KV_PREFIX + 'tree', JSON.stringify(overrides), {
          expirationTtl: TTL_SECONDS,
        });
      } catch {
        // Cache write is best effort (KV quota may be spent).
      }
    } catch {
      // Config must never break the request path.
      overrides = {};
    }
  }
  const merged = deepMerge(DEFAULT_CONFIG as unknown as ConfigTree, overrides) as unknown as RuntimeConfig;
  memoryCache = { at: Date.now(), value: merged };
  return merged;
}

export async function getConfigValue<T>(env: Env, key: string, fallback: T): Promise<T> {
  const cfg = await getConfig(env);
  const parts = key.split('.');
  let cursor: unknown = cfg;
  for (const p of parts) {
    if (cursor && typeof cursor === 'object' && p in (cursor as Record<string, unknown>)) {
      cursor = (cursor as Record<string, unknown>)[p];
    } else {
      return fallback;
    }
  }
  return (cursor as T) ?? fallback;
}

export async function setConfigValue(
  env: Env,
  key: string,
  value: unknown,
  updatedBy?: string,
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO platform_config (key, value_json, updated_at, updated_by)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json,
       updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
  )
    .bind(key, JSON.stringify(value), nowIso(), updatedBy ?? null)
    .run();
  await invalidateConfigCache(env);
}

export async function invalidateConfigCache(env: Env): Promise<void> {
  memoryCache = null;
  try {
    await env.KV.delete(KV_PREFIX + 'tree');
    d1OverrideUntil = 0;
  } catch {
    // KV quota spent: read straight from D1 for a minute so this isolate
    // still sees the change that was just saved.
    d1OverrideUntil = Date.now() + 60_000;
  }
}

export async function listConfig(env: Env): Promise<Array<{ key: string; value: unknown; updatedAt: string }>> {
  const rows = await env.DB.prepare(
    'SELECT key, value_json, updated_at FROM platform_config ORDER BY key',
  ).all<{ key: string; value_json: string; updated_at: string }>();
  return rows.results.map((r) => {
    let value: unknown = null;
    try {
      value = JSON.parse(r.value_json);
    } catch {
      value = r.value_json;
    }
    return { key: r.key, value, updatedAt: r.updated_at };
  });
}
