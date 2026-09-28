/** Structured logging with request correlation. Never log secrets. */

type Level = 'debug' | 'info' | 'warn' | 'error';

const SENSITIVE_KEYS = [
  'password',
  'password_hash',
  'passwordhash',
  'token',
  'token_hash',
  'secret',
  'authorization',
  'cookie',
  'otp',
  'otp_code_hash',
  'api_key',
  'apikey',
  'session',
];

export function redact(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map(redact);
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (SENSITIVE_KEYS.some((s) => k.toLowerCase().includes(s))) {
        out[k] = '[redacted]';
      } else {
        out[k] = redact(v);
      }
    }
    return out;
  }
  if (typeof value === 'string' && value.length > 500) return `${value.slice(0, 500)}…`;
  return value;
}

export function log(
  level: Level,
  requestId: string,
  message: string,
  data?: Record<string, unknown>,
): void {
  const entry = {
    level,
    requestId,
    message,
    at: new Date().toISOString(),
    ...(data ? { data: redact(data) } : {}),
  };
  const line = JSON.stringify(entry);
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

export const logger = {
  debug: (requestId: string, message: string, data?: Record<string, unknown>) =>
    log('debug', requestId, message, data),
  info: (requestId: string, message: string, data?: Record<string, unknown>) =>
    log('info', requestId, message, data),
  warn: (requestId: string, message: string, data?: Record<string, unknown>) =>
    log('warn', requestId, message, data),
  error: (requestId: string, message: string, data?: Record<string, unknown>) =>
    log('error', requestId, message, data),
};
