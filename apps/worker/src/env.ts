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
  PAYMENT_WEBHOOK_SECRET?: string;
  /** UPI payee VPA for the free direct-to-account provider (e.g. name@okaxis). */
  PAYMENT_UPI_VPA?: string;
  PAYMENT_UPI_NAME?: string;
  R2_ACCESS_KEY_ID?: string;
  R2_SECRET_ACCESS_KEY?: string;
  R2_BUCKET_NAME?: string;
  CLOUDFLARE_ACCOUNT_ID?: string;
  MAPS_API_KEY?: string;
  // Notification delivery (in-app always works; providers are optional)
  EMAIL_PROVIDER?: string;
  EMAIL_PROVIDER_KEY?: string;
  EMAIL_FROM?: string;
  // SMS gateway: SMS_PROVIDER picks the adapter (textbee | fast2sms).
  // textbee: own Android phone as gateway (free); key from the textbee
  // dashboard, SMS_API_URL overrides the endpoint (self-hosted textbee).
  // fast2sms: India OTP route (route=otp, no DLT); key from Dev API section.
  // SMS_FAST2SMS_ROUTE: "otp" (cheap, needs ₹100 top-up + Aadhaar KYC + website
  // verification) or "q" (Quick SMS free-form, needs only the ₹100 top-up, ₹5/SMS).
  SMS_PROVIDER?: string;
  SMS_FAST2SMS_ROUTE?: string;
  SMS_API_KEY?: string;
  SMS_API_URL?: string;
  WHATSAPP_PROVIDER_KEY?: string;
  WHATSAPP_PHONE_ID?: string;
  // Geocoding (default nominatim/OSM; set GEOCODER_PROVIDER=none to disable)
  GEOCODER_PROVIDER?: string;
  GEOCODER_KEY?: string;
  // Web Push (VAPID). When unset, ephemeral development keys are generated
  // and cached in KV so the service worker still gets a stable key locally.
  VAPID_PUBLIC_KEY?: string;
  VAPID_PRIVATE_KEY?: string;
  VAPID_SUBJECT?: string;
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
