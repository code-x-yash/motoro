#!/usr/bin/env node
/**
 * End-to-end demo of the Motoro happy path over real HTTP:
 *
 *   register driver → vehicle → emergency request → dispatch offer →
 *   mechanic accepts → en-route → arrived → OTP verify → diagnosis →
 *   quote → driver approves → repair → complete → payment → review
 *
 *   npm run demo   (requires the local worker on :8787, ideally after `npm run seed`)
 */

const API = process.env.API_BASE_URL || 'http://127.0.0.1:8787';
const PASSWORD = 'Demo@1234';

const log = (step, detail = '') => console.log(`▸ ${step.padEnd(28)} ${detail}`);
const fail = (step, detail) => {
  console.error(`✗ ${step}: ${detail}`);
  process.exit(1);
};

class Session {
  constructor(name) {
    this.name = name;
    this.cookie = '';
  }

  async request(path, { method = 'GET', body, query, expect } = {}) {
    const headers = { accept: 'application/json' };
    if (this.cookie) headers.cookie = this.cookie;
    if (body !== undefined) headers['content-type'] = 'application/json';

    const url = new URL(`${API}${path}`);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
    }

    const response = await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });

    const setCookie = response.headers.getSetCookie?.() ?? [];
    for (const cookie of setCookie) {
      const pair = cookie.split(';')[0];
      if (pair.startsWith('rr_session=')) this.cookie = pair;
    }

    const payload = await response.json().catch(() => null);
    if (expect && !expect.includes(response.status)) {
      fail(`${this.name} ${method} ${path}`, `HTTP ${response.status} ${JSON.stringify(payload)}`);
    }
    if (payload && payload.success === false) {
      fail(`${this.name} ${method} ${path}`, `${payload.error?.code}: ${payload.error?.message}`);
    }
    return { status: response.status, data: payload?.data, payload };
  }
}

async function login(session, email) {
  const { data } = await session.request('/api/auth/login', {
    method: 'POST',
    body: { email, password: PASSWORD },
    expect: [200],
  });
  log('login', `${email} → ${data.user.role}`);
  return data.user;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  const health = await fetch(`${API}/api/health`).catch(() => null);
  if (!health || !health.ok) fail('health', `API not reachable at ${API} (npm run dev:worker)`);

  const stamp = Date.now().toString(36);
  const phone = `9${String(Date.now()).slice(-9)}`;
  const driver = new Session('driver');
  await driver.request('/api/auth/register', {
    method: 'POST',
    body: {
      fullName: `Demo Driver ${stamp}`,
      email: `driver.${stamp}@demo.test`,
      phone,
      password: PASSWORD,
      role: 'DRIVER',
    },
    expect: [201, 200],
  });
  log('register driver', driver.cookie ? 'session ok' : 'no session');

  const vehicle = await driver.request('/api/vehicles', {
    method: 'POST',
    body: {
      registrationNumber: `DL 3S ${stamp.slice(-4).toUpperCase()}`.replace(/[^A-Z0-9 ]/g, 'X'),
      make: 'Maruti',
      model: 'Swift',
      variant: 'VXi',
      year: 2021,
      fuelType: 'PETROL',
      vehicleType: 'CAR',
    },
    expect: [201, 200],
  });
  log('vehicle', vehicle.data?.id ?? 'created');

  const emergency = await driver.request('/api/emergencies', {
    method: 'POST',
    body: {
      issueType: 'BATTERY',
      urgency: 'HIGH',
      description: 'Battery dead in the parking lot',
      latitude: 19.076,
      longitude: 72.8777,
      address: 'Demo street, Mumbai',
      channel: 'WEB',
      vehicleId: vehicle.data?.id ?? null,
    },
    expect: [201, 200],
  });
  const requestId = emergency.data?.request?.id ?? emergency.data?.id;
  log('emergency', requestId);

  // Find an offer for any seeded mechanic (max ~20s).
  const mechanics = [];
  for (let i = 1; i <= 15; i += 1) mechanics.push(`mechanic${i}@motoro.test`);

  let attempt = null;
  let mechanic = null;
  const deadline = Date.now() + 20_000;
  while (!attempt && Date.now() < deadline) {
    for (const email of mechanics) {
      const session = new Session(`mechanic:${email}`);
      try {
        await login(session, email);
      } catch {
        continue;
      }
      const offers = await session.request('/api/dispatch/offers');
      const hit = (offers.data?.items ?? []).find((offer) => offer.requestId === requestId);
      if (hit) {
        attempt = hit;
        mechanic = { session, email };
        break;
      }
    }
    if (!attempt) await sleep(1500);
  }
  if (!attempt) fail('dispatch', 'no mechanic received an offer in 20s (is the worker seeded + online?)');
  log('dispatch offer', `${attempt.attemptId} · ${mechanic.email}`);

  await mechanic.session.request(`/api/dispatch/${attempt.attemptId}/accept`, { method: 'POST', body: {}, expect: [200] });
  log('accept', 'assigned');

  const activeJobs = await mechanic.session.request('/api/jobs', { query: { limit: 20 } });
  const job = (activeJobs.data?.items ?? []).find((item) => item.requestId === requestId);
  if (!job) fail('job lookup', 'accepted job not found');
  log('job', job.id);

  await mechanic.session.request(`/api/jobs/${job.id}/en-route`, { method: 'POST', body: { note: 'On the way' }, expect: [200] });
  await mechanic.session.request(`/api/jobs/${job.id}/arrived`, { method: 'POST', body: { note: 'Arrived' }, expect: [200] });
  log('en-route → arrived', 'ok');

  const notifications = await driver.request('/api/notifications', { query: { limit: 20 } });
  const arrived = [...(notifications.data?.items ?? [])]
    .reverse()
    .find((item) => item.type === 'MECHANIC_ARRIVED');
  const otp = arrived?.data?.otp ?? (arrived?.body.match(/\b(\d{6})\b/) ?? [])[1];
  if (!otp) fail('otp', 'OTP notification not found for driver');
  log('otp', otp);

  await mechanic.session.request(`/api/jobs/${job.id}/verify`, { method: 'POST', body: { otp }, expect: [200] });
  await mechanic.session.request(`/api/jobs/${job.id}/diagnosis`, {
    method: 'POST',
    body: {
      notes: 'Battery voltage below spec',
      items: [{ code: 'BATTERY', label: 'Battery health', result: 'FAIL', notes: '11.4V resting' }],
    },
    expect: [200, 201],
  });
  const quote = await mechanic.session.request(`/api/jobs/${job.id}/quote`, {
    method: 'POST',
    body: {
      items: [
        { type: 'PART', description: 'Battery 35Ah', quantity: 1, unitPriceCents: 450000 },
        { type: 'LABOUR', description: 'Fitment', quantity: 1, unitPriceCents: 30000 },
      ],
      taxPercent: 18,
      notes: '3-year warranty on battery',
    },
    expect: [201, 200],
  });
  log('diagnosis + quote', quote.data?.quote?.totalCents ?? '');

  await driver.request(`/api/jobs/${job.id}/quote/approve`, {
    method: 'POST',
    body: { decision: 'APPROVED' },
    expect: [200],
  });
  log('quote approve', 'driver approved');

  await mechanic.session.request(`/api/jobs/${job.id}/start`, { method: 'POST', body: {}, expect: [200] });
  await mechanic.session.request(`/api/jobs/${job.id}/complete`, { method: 'POST', body: {}, expect: [200] });
  log('repair → complete', 'ok');

  const payment = await driver.request(`/api/emergencies/${requestId}/payment`, {
    method: 'POST',
    body: { method: 'UPI' },
    expect: [200],
  });
  log('payment', `${payment.data?.payment?.status} ₹${(payment.data?.payment?.amountCents ?? 0) / 100}`);

  await driver.request('/api/reviews', {
    method: 'POST',
    body: {
      requestId,
      overall: 5,
      arrival: 5,
      diagnosis: 5,
      pricing: 5,
      professionalism: 5,
      resolution: 5,
      comment: 'Quick and transparent',
    },
    expect: [201, 200],
  });
  log('review', '5★ submitted');

  console.log(
    `\n✓ Demo complete — open ${process.env.WEB_BASE_URL || 'http://localhost:3000'} to explore the same data in the UI ` +
      "(use 'npx next dev -p 3005' from apps/web if port 3000 is taken).",
  );
}

main().catch((err) => fail('unexpected', err.stack ?? err.message));
