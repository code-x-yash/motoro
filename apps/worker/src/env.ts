/** Cloudflare Worker environment (bindings + vars). Keep in sync with wrangler.jsonc. */
export interface Env {
  // Bindings
  DB: D1Database;
  KV: KVNamespace;
  FILES: R2Bucket;
  TASKS: Queue;
  TASKS_DLQ: Queue;
  EMERGENCY_ROOM: DurableObjectNamespace;

  // Vars
  ENVIRONMENT: string;
  SESSION_SECRET?: string;
  SESSION_COOKIE_NAME?: string;
  ALLOWED_ORIGINS: string;
  ENABLE_SEED_ROUTES?: string;
  PAYMENT_PROVIDER?: string;
  PAYMENT_PROVIDER_KEY?: string;
  PAYMENT_PROVIDER_SECRET?: string;
  R2_ACCESS_KEY_ID?: string;
  R2_SECRET_ACCESS_KEY?: string;
  R2_BUCKET_NAME?: string;
  CLOUDFLARE_ACCOUNT_ID?: string;
  MAPS_API_KEY?: string;
}

export type AppEnv = Env;

export function isProduction(env: Env): boolean {
  return env.ENVIRONMENT === 'production';
}

export function isDev(env: Env): boolean {
  return !isProduction(env);
}

export function seedRoutesEnabled(env: Env): boolean {
  return env.ENABLE_SEED_ROUTES === 'true' && !isProduction(env);
}

export function allowedOrigins(env: Env): string[] {
  return (env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export function sessionCookieName(env: Env): string {
  return env.SESSION_COOKIE_NAME || 'rr_session';
}
