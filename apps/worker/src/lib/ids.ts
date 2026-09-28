/** ID + reference helpers. */

export function newId(): string {
  return crypto.randomUUID();
}

/** Short human-friendly reference, e.g. "RR-7F3K2Q". */
export function newReference(prefix = 'RR'): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  let out = '';
  for (const b of bytes) out += alphabet[b % alphabet.length];
  return `${prefix}-${out}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function isoIn(seconds: number): string {
  return new Date(Date.now() + seconds * 1000).toISOString();
}

export function minutesFromNowIso(minutes: number): string {
  return isoIn(minutes * 60);
}

export function parseIso(value: string | null | undefined): Date | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}
