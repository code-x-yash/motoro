import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { Env } from '../../src/env';

declare module 'cloudflare:test' {
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type
  interface ProvidedEnv extends Env {}
}

interface Envelope<T> {
  success: boolean;
  data: T;
  error: { code: string; message: string } | null;
  requestId: string;
}

async function call(
  path: string,
  init: RequestInit & { cookie?: string } = {},
): Promise<{ status: number; body: Envelope<unknown>; cookie: string | null }> {
  const headers = new Headers(init.headers);
  headers.set('content-type', 'application/json');
  if (init.cookie) headers.set('cookie', init.cookie);

  const response = await SELF.fetch(`http://localhost${path}`, { ...init, headers });
  const cookie = response.headers.get('set-cookie');
  const body = (await response.json()) as Envelope<unknown>;
  return { status: response.status, body, cookie };
}

function sessionCookie(setCookie: string | null): string {
  if (!setCookie) throw new Error('expected a session cookie');
  return setCookie.split(';')[0];
}

describe('API integration', () => {
  it('reports a healthy database', async () => {
    const { status, body } = await call('/api/health');
    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect((body.data as { database: string }).database).toBe('connected');
  });

  it('registers, authenticates and guards the session', async () => {
    const email = `it.driver.${Date.now()}@motoro.test`;
    const registered = await call('/api/auth/register', {
      method: 'POST',
      body: JSON.stringify({
        fullName: 'Integration Driver',
        email,
        phone: '9876543210',
        password: 'Demo@1234',
        role: 'DRIVER',
      }),
    });
    expect(registered.status).toBe(201);
    const cookie = sessionCookie(registered.cookie);

    const me = await call('/api/auth/me', { cookie });
    expect(me.status).toBe(200);
    expect((me.body.data as { user: { email: string } }).user.email).toBe(email);

    const vehicles = await call('/api/vehicles', {
      method: 'POST',
      cookie,
      body: JSON.stringify({
        registrationNumber: `IT ${String(Date.now()).slice(-8)}`,
        make: 'Maruti',
        model: 'Swift',
        fuelType: 'PETROL',
        vehicleType: 'CAR',
        year: 2022,
      }),
    });
    expect(vehicles.status).toBe(201);

    const list = await call('/api/vehicles', { cookie });
    expect(list.status).toBe(200);
    expect((list.body.data as { items: unknown[] }).items.length).toBeGreaterThan(0);
  });

  it('rejects a bad password without leaking account details', async () => {
    const { status, body } = await call('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email: 'nobody@motoro.test', password: 'wrong-password' }),
    });
    expect(status).toBeGreaterThanOrEqual(400);
    expect(body.success).toBe(false);
    expect(body.error?.code).not.toContain('no such user');
  });

  it('creates an emergency request that enters dispatch', async () => {
    const registered = await call('/api/auth/register', {
      method: 'POST',
      body: JSON.stringify({
        fullName: 'Integration Requester',
        email: `it.requester.${Date.now()}@motoro.test`,
        password: 'Demo@1234',
        role: 'DRIVER',
      }),
    });
    const cookie = sessionCookie(registered.cookie);

    const created = await call('/api/emergencies', {
      method: 'POST',
      cookie,
      body: JSON.stringify({
        issueType: 'BATTERY',
        urgency: 'HIGH',
        description: 'Battery dead',
        latitude: 19.076,
        longitude: 72.8777,
        address: 'Integration street, Mumbai',
        channel: 'WEB',
      }),
    });
    expect(created.status).toBe(201);

    const request = (created.body.data as { request: { id: string; status: string } }).request;
    expect(request.id).toBeTruthy();
    expect(['CREATED', 'SEARCHING', 'DISPATCHING', 'ESCALATED']).toContain(request.status);

    const detail = await call(`/api/emergencies/${request.id}`, { cookie });
    expect(detail.status).toBe(200);
    expect((detail.body.data as { request: { id: string } }).request.id).toBe(request.id);
  });

  it('blocks drivers from operations endpoints', async () => {
    const registered = await call('/api/auth/register', {
      method: 'POST',
      body: JSON.stringify({
        fullName: 'Integration Scoped',
        email: `it.scoped.${Date.now()}@motoro.test`,
        password: 'Demo@1234',
        role: 'DRIVER',
      }),
    });
    const cookie = sessionCookie(registered.cookie);

    const forbidden = await call('/api/admin/stats', { cookie });
    expect(forbidden.status).toBe(403);

    const anonymous = await call('/api/auth/me');
    expect(anonymous.status).toBe(401);
  });
});
