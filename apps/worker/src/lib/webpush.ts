import type { Env } from '../env';
import { logger } from './logger';

/**
 * Web Push (RFC 8291 aes128gcm + VAPID ES256) implemented on WebCrypto so it
 * runs unchanged in the Workers runtime. Development falls back to ephemeral
 * keys cached in KV; production should set VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY
 * (base64url, from `web-push generate-vapid-keys`).
 */

const te = new TextEncoder();

function bytesToB64url(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlToBytes(s: string): Uint8Array {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
  const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, p) => sum + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

export interface RawVapidKeys {
  publicKey: Uint8Array; // 65-byte uncompressed P-256 point
  privateKey: Uint8Array; // 32-byte scalar
}

function jwkFromRaw(pub: Uint8Array, priv: Uint8Array): JsonWebKey {
  return {
    kty: 'EC',
    crv: 'P-256',
    d: bytesToB64url(priv),
    x: bytesToB64url(pub.slice(1, 33)),
    y: bytesToB64url(pub.slice(33, 65)),
  };
}

async function generateKeys(): Promise<RawVapidKeys> {
  const kp = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ])) as CryptoKeyPair;
  const jwk = (await crypto.subtle.exportKey('jwk', kp.privateKey)) as JsonWebKey;
  const pub = new Uint8Array((await crypto.subtle.exportKey('raw', kp.publicKey)) as ArrayBuffer);
  return { publicKey: pub, privateKey: b64urlToBytes(jwk.d!) };
}

/** Resolves VAPID keys: env-provided (production) or KV-cached dev keys. */
export async function getVapidKeys(env: Env): Promise<RawVapidKeys> {
  if (env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY) {
    return {
      publicKey: b64urlToBytes(env.VAPID_PUBLIC_KEY),
      privateKey: b64urlToBytes(env.VAPID_PRIVATE_KEY),
    };
  }
  const cached = await env.KV.get<{ publicKey: string; privateKey: string }>('vapid:keys', 'json');
  if (cached?.publicKey && cached.privateKey) {
    return { publicKey: b64urlToBytes(cached.publicKey), privateKey: b64urlToBytes(cached.privateKey) };
  }
  const fresh = await generateKeys();
  await env.KV.put(
    'vapid:keys',
    JSON.stringify({ publicKey: bytesToB64url(fresh.publicKey), privateKey: bytesToB64url(fresh.privateKey) }),
  );
  return fresh;
}

export async function getVapidPublicKeyB64(env: Env): Promise<string> {
  const keys = await getVapidKeys(env);
  return bytesToB64url(keys.publicKey);
}

export async function signVapid(keys: RawVapidKeys, audience: string, subject: string): Promise<string> {
  const privKey = await crypto.subtle.importKey('jwk', jwkFromRaw(keys.publicKey, keys.privateKey), {
    name: 'ECDSA',
    namedCurve: 'P-256',
  }, false, ['sign']);
  const header = bytesToB64url(te.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const now = Math.floor(Date.now() / 1000);
  const claims = bytesToB64url(
    te.encode(JSON.stringify({ aud: audience, exp: now + 12 * 3600, sub: subject })),
  );
  const signature = new Uint8Array(
    await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, privKey, te.encode(`${header}.${claims}`)),
  );
  return `${header}.${claims}.${bytesToB64url(signature)}`;
}

async function hkdfBits(
  ikm: Uint8Array,
  salt: Uint8Array,
  info: Uint8Array,
  bits: number,
): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  const derived = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt, info },
    key,
    bits,
  );
  return new Uint8Array(derived);
}

/** RFC 8291 "aes128gcm" content encryption of a push payload. */
export async function encryptPushPayload(
  payload: string,
  p256dhB64: string,
  authB64: string,
): Promise<Uint8Array> {
  const subscriberPub = b64urlToBytes(p256dhB64);
  const authSecret = b64urlToBytes(authB64);

  const subKey = await crypto.subtle.importKey('raw', subscriberPub, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const eph = (await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, [
    'deriveBits',
  ])) as CryptoKeyPair;
  const sharedSecret = new Uint8Array(
    // workerd expects the standard `public` field; the bundled type omits it.
    await crypto.subtle.deriveBits(
      { name: 'ECDH', public: subKey } as unknown as string,
      eph.privateKey,
      256,
    ),
  );
  const ephPub = new Uint8Array((await crypto.subtle.exportKey('raw', eph.publicKey)) as ArrayBuffer);

  // IKM = HKDF-Extract(auth, shared) || Expand(key_info)
  const keyInfo = concatBytes(te.encode('WebPush: info'), subscriberPub, ephPub);
  const ikm = await hkdfBits(sharedSecret, authSecret, keyInfo, 256);

  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdfBits(ikm, salt, concatBytes(te.encode('Content-Encoding: aes128gcm'), new Uint8Array([0])), 128);
  const nonce = await hkdfBits(ikm, salt, concatBytes(te.encode('Content-Encoding: nonce'), new Uint8Array([0])), 96);

  const cekKey = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, cekKey, te.encode(payload)),
  );

  const header = concatBytes(
    te.encode('aes128gcm'),
    salt,
    new Uint8Array([0x00, 0x00, 0x10, 0x00]), // record size 4096
    new Uint8Array([65]), // key id length (ephemeral public key)
    ephPub,
  );
  return concatBytes(header, ciphertext);
}

export interface PushSubscriptionRow {
  id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
}

/** Sends one payload to one subscription. Returns 'ok' | 'gone' | 'failed'. */
async function sendToSubscription(
  env: Env,
  sub: PushSubscriptionRow,
  payload: string,
): Promise<'ok' | 'gone' | 'failed'> {
  try {
    const keys = await getVapidKeys(env);
    const audience = new URL(sub.endpoint).origin;
    const jwt = await signVapid(keys, audience, env.VAPID_SUBJECT?.trim() || 'mailto:admin@motoro.test');
    const body = await encryptPushPayload(payload, sub.p256dh, sub.auth);
    const res = await fetch(sub.endpoint, {
      method: 'POST',
      headers: {
        authorization: `vapid t=${jwt}, k=${bytesToB64url(keys.publicKey)}`,
        'content-type': 'application/octet-stream',
        'content-encoding': 'aes128gcm',
        ttl: '3600',
        urgency: 'normal',
      },
      body,
    });
    if (res.ok) return 'ok';
    if (res.status === 404 || res.status === 410) return 'gone';
    logger.warn('webpush', 'push_rejected', { status: res.status });
    return 'failed';
  } catch (err) {
    logger.warn('webpush', 'push_failed', { error: String(err) });
    return 'failed';
  }
}

/** Best-effort fan-out of a web push to every subscribed endpoint of a user. */
export async function pushToUser(env: Env, userId: string, payload: Record<string, unknown>): Promise<void> {
  try {
    const subs = await env.DB.prepare(
      'SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = ?',
    )
      .bind(userId)
      .all<PushSubscriptionRow>();
    if (subs.results.length === 0) return;
    const serialized = JSON.stringify(payload);
    for (const sub of subs.results) {
      const result = await sendToSubscription(env, sub, serialized);
      if (result === 'gone') {
        await env.DB.prepare('DELETE FROM push_subscriptions WHERE id = ?').bind(sub.id).run().catch(() => undefined);
      }
    }
  } catch (err) {
    logger.warn('webpush', 'push_to_user_failed', { userId, error: String(err) });
  }
}
