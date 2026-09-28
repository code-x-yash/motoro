import { describe, expect, it } from 'vitest';
import {
  PBKDF2_ITERATIONS,
  generateOtp,
  hashPassword,
  hmacHex,
  randomToken,
  sha256HexAsync,
  signValue,
  timingSafeEqual,
  verifyPassword,
  verifySignedValue,
} from './crypto';

describe('password hashing', () => {
  it('round-trips a password and rejects a wrong one', async () => {
    const stored = await hashPassword('Demo@1234');
    expect(stored.startsWith(`pbkdf2$${PBKDF2_ITERATIONS}$`)).toBe(true);
    expect(await verifyPassword('Demo@1234', stored)).toBe(true);
    expect(await verifyPassword('demo@1234', stored)).toBe(false);
    expect(await verifyPassword('Demo@12345', stored)).toBe(false);
  });

  it('salts every hash independently', async () => {
    const [a, b] = await Promise.all([hashPassword('same-input'), hashPassword('same-input')]);
    expect(a).not.toBe(b);
    expect(await verifyPassword('same-input', a)).toBe(true);
    expect(await verifyPassword('same-input', b)).toBe(true);
  });

  it('rejects malformed stored hashes', async () => {
    expect(await verifyPassword('x', '')).toBe(false);
    expect(await verifyPassword('x', 'plaintext')).toBe(false);
    expect(await verifyPassword('x', 'pbkdf2$100$salt-hash')).toBe(false);
    expect(await verifyPassword('x', 'bcrypt$100000$c2FsdA==$aGFzaA==')).toBe(false);
    expect(await verifyPassword('x', 'pbkdf2$50$c2FsdA==$aGFzaA==')).toBe(false);
  });
});

describe('tokens and OTPs', () => {
  it('generates url-safe random tokens of the requested size', () => {
    const token = randomToken(32);
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(randomToken(32)).not.toBe(token);
  });

  it('generates 6-digit OTPs', () => {
    const otp = generateOtp();
    expect(otp).toMatch(/^\d{6}$/);
    expect(generateOtp()).toMatch(/^\d{6}$/);
  });
});

describe('digest helpers', () => {
  it('hashes sha256 to stable hex', async () => {
    const digest = await sha256HexAsync('motoro');
    expect(digest).toBe(await sha256HexAsync('motoro'));
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(await sha256HexAsync('motoro')).not.toBe(digest.replace(/[0-9a-f]/, '0'));
  });

  it('is key-dependent for hmac', async () => {
    const a = await hmacHex('secret-a', 'payload');
    const b = await hmacHex('secret-b', 'payload');
    expect(a).not.toBe(b);
    expect(await hmacHex('secret-a', 'payload')).toBe(a);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('signed values', () => {
  it('verifies its own signature and rejects tampering', async () => {
    const signature = await signValue('relay-secret', 'object-key');
    expect(await verifySignedValue('relay-secret', 'object-key', signature)).toBe(true);
    expect(await verifySignedValue('relay-secret', 'other-key', signature)).toBe(false);
    expect(await verifySignedValue('other-secret', 'object-key', signature)).toBe(false);
  });
});

describe('timingSafeEqual', () => {
  it('compares byte arrays correctly', () => {
    expect(timingSafeEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 3]))).toBe(true);
    expect(timingSafeEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 4]))).toBe(false);
    expect(timingSafeEqual(new Uint8Array([1, 2]), new Uint8Array([1, 2, 3]))).toBe(false);
  });
});
