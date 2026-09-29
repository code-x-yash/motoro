import { describe, expect, it } from 'vitest';
import type { Env } from '../env';
import { encryptPushPayload, getVapidKeys, signVapid, type RawVapidKeys } from './webpush';

const te = new TextEncoder();

function toB64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url');
}

async function generateSubscriber(): Promise<{
  pub: Uint8Array;
  priv: CryptoKey;
  auth: Uint8Array;
}> {
  const kp = (await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, [
    'deriveBits',
  ])) as CryptoKeyPair;
  const pub = new Uint8Array((await crypto.subtle.exportKey('raw', kp.publicKey)) as ArrayBuffer);
  return { pub, priv: kp.privateKey, auth: crypto.getRandomValues(new Uint8Array(16)) };
}

async function hkdf(ikm: Uint8Array, salt: Uint8Array, info: Uint8Array, bits: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  const derived = await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, bits);
  return new Uint8Array(derived);
}

describe('webpush payload encryption (RFC 8291)', () => {
  it('produces an aes128gcm body the subscriber can decrypt', async () => {
    const subscriber = await generateSubscriber();
    const payload = JSON.stringify({
      title: 'Mechanic arriving',
      body: 'Suresh is 5 minutes away.',
      type: 'MECHANIC_ARRIVED',
    });

    const body = await encryptPushPayload(payload, toB64url(subscriber.pub), toB64url(subscriber.auth));
    expect(body.length).toBeGreaterThan(95 + 16);

    // Header: "aes128gcm" || salt(16) || rs(4) || idlen(1) || ephPub(65)
    expect(new TextDecoder().decode(body.slice(0, 9))).toBe('aes128gcm');
    const view = new DataView(body.buffer, body.byteOffset, body.byteLength);
    expect(view.getUint32(25)).toBe(4096);
    expect(body[29]).toBe(65);
    const salt = body.slice(9, 25);
    const ephPub = body.slice(30, 95);
    const ciphertext = body.slice(95);

    // Receiver side: ECDH(subPriv, ephPub) → same shared secret.
    const ephKey = await crypto.subtle.importKey('raw', ephPub, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
    const shared = new Uint8Array(
      await crypto.subtle.deriveBits({ name: 'ECDH', public: ephKey } as unknown as string, subscriber.priv, 256),
    );

    const keyInfo = new Uint8Array([
      ...te.encode('WebPush: info'),
      ...subscriber.pub,
      ...ephPub,
    ]);
    const ikm = await hkdf(shared, subscriber.auth, keyInfo, 256);
    const cek = await hkdf(ikm, salt, new Uint8Array([...te.encode('Content-Encoding: aes128gcm'), 0]), 128);
    const nonce = await hkdf(ikm, salt, new Uint8Array([...te.encode('Content-Encoding: nonce'), 0]), 96);

    const cekKey = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['decrypt']);
    const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce }, cekKey, ciphertext);
    expect(new TextDecoder().decode(plaintext)).toBe(payload);
  });
});

describe('vapid signing', () => {
  it('signs an ES256 JWT with the expected claims', async () => {
    const kp = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
      'sign',
      'verify',
    ])) as CryptoKeyPair;
    const privJwk = (await crypto.subtle.exportKey('jwk', kp.privateKey)) as JsonWebKey;
    const pub = new Uint8Array((await crypto.subtle.exportKey('raw', kp.publicKey)) as ArrayBuffer);
    const keys: RawVapidKeys = {
      publicKey: pub,
      privateKey: Buffer.from(privJwk.d!, 'base64url'),
    };

    const audience = 'https://fcm.googleapis.com';
    const jwt = await signVapid(keys, audience, 'mailto:ops@motoro.test');
    const [header, claims, signature] = jwt.split('.');
    expect(header && claims && signature).toBeTruthy();

    const decodedClaims = JSON.parse(Buffer.from(claims, 'base64url').toString('utf8')) as {
      aud: string;
      sub: string;
      exp: number;
    };
    expect(decodedClaims.aud).toBe(audience);
    expect(decodedClaims.sub).toBe('mailto:ops@motoro.test');
    expect(decodedClaims.exp).toBeGreaterThan(Math.floor(Date.now() / 1000));

    const verifyKey = await crypto.subtle.importKey(
      'jwk',
      { kty: 'EC', crv: 'P-256', x: privJwk.x!, y: privJwk.y! },
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['verify'],
    );
    const valid = await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      verifyKey,
      Buffer.from(signature, 'base64url'),
      te.encode(`${header}.${claims}`),
    );
    expect(valid).toBe(true);
  });
});

describe('getVapidKeys', () => {
  it('generates development keys once and serves them from KV afterwards', async () => {
    const store = new Map<string, string>();
    const kv = {
      get: async (key: string, type?: string) => {
        const raw = store.get(key);
        if (raw === undefined) return null;
        return type === 'json' ? JSON.parse(raw) : raw;
      },
      put: async (key: string, value: string) => {
        store.set(key, value);
      },
    };
    const env = { KV: kv } as unknown as Env;

    const first = await getVapidKeys(env);
    expect(first.publicKey.length).toBe(65);
    expect(first.privateKey.length).toBe(32);

    const second = await getVapidKeys(env);
    expect(Buffer.from(second.publicKey).toString('base64url')).toBe(
      Buffer.from(first.publicKey).toString('base64url'),
    );
    expect(Buffer.from(second.privateKey).toString('base64url')).toBe(
      Buffer.from(first.privateKey).toString('base64url'),
    );
  });

  it('prefers env-provided keys', async () => {
    const kp = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
      'sign',
    ])) as CryptoKeyPair;
    const privJwk = (await crypto.subtle.exportKey('jwk', kp.privateKey)) as JsonWebKey;
    const pub = new Uint8Array((await crypto.subtle.exportKey('raw', kp.publicKey)) as ArrayBuffer);
    const priv = Buffer.from(privJwk.d!, 'base64url');

    const env = {
      VAPID_PUBLIC_KEY: toB64url(pub),
      VAPID_PRIVATE_KEY: toB64url(priv),
      KV: { get: async () => null, put: async () => undefined },
    } as unknown as Env;

    const keys = await getVapidKeys(env);
    expect(toB64url(keys.publicKey)).toBe(toB64url(pub));
    expect(toB64url(keys.privateKey)).toBe(toB64url(priv));
  });
});
