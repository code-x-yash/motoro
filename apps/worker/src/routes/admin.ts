import { Hono } from 'hono';
import type { Env } from '../env';
import { ok } from '../lib/response';
import { errors } from '../lib/errors';
import { requireUser, requireRole } from '../lib/auth';
import { parseInput } from '../lib/validate';
import {
  adminSuspendSchema,
  adminVerifyMechanicSchema,
  createCouponSchema,
  paginationSchema,
  platformConfigSchema,
  pricingRuleSchema,
  serviceCategorySchema,
} from '@rr/validation';
import { audit } from '../lib/audit';
import { invalidateConfigCache, listConfig, setConfigValue, getConfig } from '../lib/config';
import { newId, nowIso } from '../lib/ids';
import { revokeAllSessions } from '../lib/session';
import { setMechanicStatus } from '../lib/mechanics';
import { notify } from '../lib/notify';
import { recordEvent } from '../lib/events';
import { getPaymentProvider } from '../lib/payments';
import { computeMechanicPayout } from '../lib/pricing';
import { SKILL_CATALOG, EQUIPMENT_CATALOG } from '@rr/config';
import { presignDownload } from '../lib/r2';
import { enforceRateLimit } from '../lib/rate-limit';

const routes = new Hono<{ Bindings: Env }>();

routes.use('*', requireRole('ADMIN'));

/** Platform analytics. */
routes.get('/stats', async (c) => {
  const [users, requests, jobs, revenue] = await Promise.all([
    c.env.DB.prepare(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN role = 'DRIVER' THEN 1 ELSE 0 END) AS drivers,
              SUM(CASE WHEN role = 'MECHANIC' THEN 1 ELSE 0 END) AS mechanics,
              SUM(CASE WHEN role = 'WORKSHOP' THEN 1 ELSE 0 END) AS workshops,
              SUM(CASE WHEN role = 'TOWING_PARTNER' THEN 1 ELSE 0 END) AS towing
       FROM users WHERE deleted_at IS NULL`,
    ).first<Record<string, number>>(),
    c.env.DB.prepare(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN status IN ('PAID') THEN 1 ELSE 0 END) AS paid,
              SUM(CASE WHEN status = 'ESCALATED' THEN 1 ELSE 0 END) AS escalated,
              SUM(CASE WHEN status = 'CANCELLED' THEN 1 ELSE 0 END) AS cancelled,
              SUM(CASE WHEN date(created_at) = date('now') THEN 1 ELSE 0 END) AS today
       FROM emergency_requests WHERE deleted_at IS NULL`,
    ).first<Record<string, number>>(),
    c.env.DB.prepare(
      `SELECT COUNT(*) AS total, SUM(CASE WHEN status = 'COMPLETED' THEN 1 ELSE 0 END) AS completed
       FROM jobs WHERE deleted_at IS NULL`,
    ).first<Record<string, number>>(),
    c.env.DB.prepare(
      `SELECT COALESCE(SUM(amount_cents - refunded_cents), 0) AS total FROM payments WHERE status = 'PAID'`,
    ).first<{ total: number }>(),
  ]);

  const pendingVerifications = await c.env.DB.prepare(
    `SELECT COUNT(*) AS c FROM mechanics WHERE verification_status IN ('PENDING','UNDER_REVIEW')`,
  ).first<{ c: number }>();

  const openDisputes = await c.env.DB.prepare(
    `SELECT COUNT(*) AS c FROM disputes WHERE status IN ('OPEN','IN_REVIEW')`,
  ).first<{ c: number }>();

  const daily = await c.env.DB.prepare(
    `SELECT date(created_at) AS day, COUNT(*) AS requests
     FROM emergency_requests WHERE created_at >= date('now','-14 days') AND deleted_at IS NULL
     GROUP BY date(created_at) ORDER BY day ASC`,
  ).all<{ day: string; requests: number }>();

  return ok(
    {
      users: {
        total: users?.total ?? 0,
        drivers: users?.drivers ?? 0,
        mechanics: users?.mechanics ?? 0,
        workshops: users?.workshops ?? 0,
        towing: users?.towing ?? 0,
      },
      requests: {
        total: requests?.total ?? 0,
        paid: requests?.paid ?? 0,
        escalated: requests?.escalated ?? 0,
        cancelled: requests?.cancelled ?? 0,
        today: requests?.today ?? 0,
      },
      jobs: { total: jobs?.total ?? 0, completed: jobs?.completed ?? 0 },
      revenueCents: revenue?.total ?? 0,
      pendingVerifications: pendingVerifications?.c ?? 0,
      openDisputes: openDisputes?.c ?? 0,
      daily: daily.results,
    },
    c.get('requestId'),
  );
});

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

routes.get('/users', async (c) => {
  const query = parseInput(paginationSchema, c.req.query());
  const role = c.req.query('role');
  let sql = `SELECT id, role, email, phone, full_name, locale, status, created_at, last_login_at
             FROM users WHERE deleted_at IS NULL`;
  const binds: Array<string | number> = [];
  if (role) {
    sql += ' AND role = ?';
    binds.push(role);
  }
  const countRow = await c.env.DB.prepare(`SELECT COUNT(*) AS c FROM (${sql})`)
    .bind(...binds)
    .first<{ c: number }>();
  sql += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
  binds.push(query.limit ?? 20, query.offset ?? 0);
  const rows = await c.env.DB.prepare(sql).bind(...binds).all();
  return ok(
    {
      items: rows.results.map((r) => {
        const u = r as never as {
          id: string;
          role: string;
          email: string;
          phone: string | null;
          full_name: string;
          locale: string;
          status: string;
          created_at: string;
          last_login_at: string | null;
        };
        return {
          id: u.id,
          role: u.role,
          email: u.email,
          phone: u.phone,
          fullName: u.full_name,
          locale: u.locale,
          status: u.status,
          createdAt: u.created_at,
          lastLoginAt: u.last_login_at,
        };
      }),
      total: countRow?.c ?? 0,
      limit: query.limit,
      offset: query.offset,
    },
    c.get('requestId'),
  );
});

routes.post('/users/:id/suspend', async (c) => {
  const admin = await requireUser(c);
  const input = parseInput(adminSuspendSchema, await c.req.json().catch(() => ({})));
  const id = c.req.param('id');
  const user = await c.env.DB.prepare('SELECT id, role, status FROM users WHERE id = ? AND deleted_at IS NULL')
    .bind(id)
    .first<{ id: string; role: string; status: string }>();
  if (!user) throw errors.notFound('User not found.');
  if (user.role === 'ADMIN' && user.id !== admin.id) {
    throw errors.forbidden('Admins cannot suspend other admins.');
  }

  const status = input.suspend ? 'SUSPENDED' : 'ACTIVE';
  await c.env.DB.prepare('UPDATE users SET status = ?, updated_at = ? WHERE id = ?')
    .bind(status, nowIso(), id)
    .run();
  await revokeAllSessions(c.env, id);

  if (user.role === 'MECHANIC' && input.suspend) {
    await setMechanicStatus(c.env, id, 'SUSPENDED', {
      actorRole: 'ADMIN',
      actorUserId: admin.id,
      skipValidation: true,
      reason: input.reason,
    }).catch(() => undefined);
  }

  await audit(c.env, {
    actorUserId: admin.id,
    actorRole: 'ADMIN',
    action: input.suspend ? 'USER_SUSPENDED' : 'USER_REINSTATED',
    entityType: 'user',
    entityId: id,
    data: { reason: input.reason },
    requestId: c.get('requestId'),
  });

  return ok({ id, status }, c.get('requestId'));
});

// ---------------------------------------------------------------------------
// Mechanic verification
// ---------------------------------------------------------------------------

routes.get('/mechanics', async (c) => {
  const query = parseInput(paginationSchema, c.req.query());
  const status = c.req.query('verificationStatus');
  let sql = `SELECT m.*, u.full_name, u.email, u.phone, u.status AS user_status
             FROM mechanics m JOIN users u ON u.id = m.user_id
             WHERE m.deleted_at IS NULL`;
  const binds: Array<string | number> = [];
  if (status) {
    sql += ' AND m.verification_status = ?';
    binds.push(status);
  }
  const countRow = await c.env.DB.prepare(`SELECT COUNT(*) AS c FROM (${sql})`)
    .bind(...binds)
    .first<{ c: number }>();
  sql += ' ORDER BY m.created_at DESC LIMIT ? OFFSET ?';
  binds.push(query.limit ?? 20, query.offset ?? 0);
  const rows = await c.env.DB.prepare(sql).bind(...binds).all();

  const origin = new URL(c.req.url).origin;
  const items = [];
  for (const row of rows.results) {
    const r = row as never as {
      user_id: string;
      full_name: string;
      email: string;
      phone: string | null;
      user_status: string;
      verification_status: string;
      status: string;
      experience_years: number;
      address: string | null;
      service_radius_km: number;
      submitted_at: string | null;
      document_key: string | null;
      rating_sum: number;
      rating_count: number;
      jobs_completed: number;
      earnings_cents: number;
    };
    items.push({
      userId: r.user_id,
      fullName: r.full_name,
      email: r.email,
      phone: r.phone,
      userStatus: r.user_status,
      verificationStatus: r.verification_status,
      status: r.status,
      experienceYears: r.experience_years,
      address: r.address,
      serviceRadiusKm: r.service_radius_km,
      submittedAt: r.submitted_at,
      documentKey: r.document_key,
      documentUrl: r.document_key
        ? (await presignDownload(c.env, origin, r.document_key, 3600)).url
        : null,
      ratingAverage: r.rating_count > 0 ? Math.round((r.rating_sum / r.rating_count) * 10) / 10 : 0,
      ratingCount: r.rating_count,
      jobsCompleted: r.jobs_completed,
      earningsCents: r.earnings_cents,
    });
  }

  return ok({ items, total: countRow?.c ?? 0, limit: query.limit, offset: query.offset }, c.get('requestId'));
});

routes.post('/mechanics/:id/verify', async (c) => {
  const admin = await requireUser(c);
  const input = parseInput(adminVerifyMechanicSchema, await c.req.json().catch(() => ({})));
  const id = c.req.param('id');
  const mechanic = await c.env.DB.prepare('SELECT user_id FROM mechanics WHERE user_id = ?')
    .bind(id)
    .first<{ user_id: string }>();
  if (!mechanic) throw errors.notFound('Mechanic not found.');

  await c.env.DB.prepare(
    `UPDATE mechanics SET verification_status = ?, reviewed_at = ?, review_note = ?, updated_at = ? WHERE user_id = ?`,
  )
    .bind(input.decision, nowIso(), input.reason ?? null, nowIso(), id)
    .run();

  if (input.decision === 'REJECTED' || input.decision === 'UNDER_REVIEW') {
    await c.env.DB.prepare(`UPDATE mechanics SET status = 'OFFLINE' WHERE user_id = ? AND status NOT IN ('SUSPENDED')`)
      .bind(id)
      .run();
  }

  await notify(c.env, {
    userId: id,
    type: 'VERIFICATION_DECISION',
    title: `Verification ${input.decision.toLowerCase().replace('_', ' ')}`,
    body: input.reason ?? `Your mechanic verification status is now ${input.decision}.`,
    data: { status: input.decision },
  });

  await audit(c.env, {
    actorUserId: admin.id,
    actorRole: 'ADMIN',
    action: 'MECHANIC_VERIFICATION_DECISION',
    entityType: 'mechanic',
    entityId: id,
    data: { decision: input.decision, reason: input.reason ?? null },
    requestId: c.get('requestId'),
  });

  return ok({ userId: id, verificationStatus: input.decision }, c.get('requestId'));
});

routes.post('/mechanics/:id/suspend', async (c) => {
  const admin = await requireUser(c);
  const input = parseInput(adminSuspendSchema, await c.req.json().catch(() => ({})));
  const id = c.req.param('id');
  const mechanic = await c.env.DB.prepare('SELECT user_id FROM mechanics WHERE user_id = ?')
    .bind(id)
    .first<{ user_id: string }>();
  if (!mechanic) throw errors.notFound('Mechanic not found.');

  if (input.suspend) {
    await c.env.DB.prepare(
      `UPDATE mechanics SET verification_status = 'SUSPENDED', status = 'SUSPENDED', updated_at = ? WHERE user_id = ?`,
    )
      .bind(nowIso(), id)
      .run();
    await revokeAllSessions(c.env, id);
  } else {
    await c.env.DB.prepare(
      `UPDATE mechanics SET verification_status = 'VERIFIED', status = 'OFFLINE', updated_at = ? WHERE user_id = ?`,
    )
      .bind(nowIso(), id)
      .run();
  }

  await audit(c.env, {
    actorUserId: admin.id,
    actorRole: 'ADMIN',
    action: input.suspend ? 'MECHANIC_SUSPENDED' : 'MECHANIC_REINSTATED',
    entityType: 'mechanic',
    entityId: id,
    data: { reason: input.reason },
    requestId: c.get('requestId'),
  });

  return ok({ userId: id, suspended: input.suspend }, c.get('requestId'));
});

// ---------------------------------------------------------------------------
// Workshops & towing partners
// ---------------------------------------------------------------------------

routes.get('/workshops', async (c) => {
  const rows = await c.env.DB.prepare(
    `SELECT w.*, u.full_name AS owner_name, u.email AS owner_email
     FROM workshops w JOIN users u ON u.id = w.owner_user_id
     WHERE w.deleted_at IS NULL ORDER BY w.created_at DESC LIMIT 200`,
  ).all();
  return ok(
    {
      items: rows.results.map((r) => {
        const w = r as never as {
          id: string;
          name: string;
          owner_user_id: string;
          owner_name: string;
          owner_email: string;
          address: string | null;
          verification_status: string;
          service_radius_km: number;
          rating_sum: number;
          rating_count: number;
        };
        return {
          id: w.id,
          name: w.name,
          ownerUserId: w.owner_user_id,
          ownerName: w.owner_name,
          ownerEmail: w.owner_email,
          address: w.address,
          verificationStatus: w.verification_status,
          serviceRadiusKm: w.service_radius_km,
          ratingAverage: w.rating_count > 0 ? Math.round((w.rating_sum / w.rating_count) * 10) / 10 : 0,
          ratingCount: w.rating_count,
        };
      }),
    },
    c.get('requestId'),
  );
});

routes.post('/workshops/:id/verify', async (c) => {
  const admin = await requireUser(c);
  const input = parseInput(adminVerifyMechanicSchema, await c.req.json().catch(() => ({})));
  const result = await c.env.DB.prepare(
    'UPDATE workshops SET verification_status = ?, updated_at = ? WHERE id = ?',
  )
    .bind(input.decision, nowIso(), c.req.param('id'))
    .run();
  if (result.meta.changes === 0) throw errors.notFound('Workshop not found.');
  await audit(c.env, {
    actorUserId: admin.id,
    actorRole: 'ADMIN',
    action: 'WORKSHOP_VERIFICATION_DECISION',
    entityType: 'workshop',
    entityId: c.req.param('id'),
    data: { decision: input.decision },
    requestId: c.get('requestId'),
  });
  return ok({ id: c.req.param('id'), verificationStatus: input.decision }, c.get('requestId'));
});

routes.get('/towing', async (c) => {
  const rows = await c.env.DB.prepare(
    `SELECT t.*, u.full_name AS owner_name, u.email AS owner_email
     FROM towing_partners t JOIN users u ON u.id = t.owner_user_id
     WHERE t.deleted_at IS NULL ORDER BY t.created_at DESC LIMIT 200`,
  ).all();
  return ok(
    {
      items: rows.results.map((r) => {
        const t = r as never as {
          id: string;
          name: string;
          owner_user_id: string;
          owner_name: string;
          owner_email: string;
          address: string | null;
          verification_status: string;
          status: string;
          service_radius_km: number;
        };
        return {
          id: t.id,
          name: t.name,
          ownerUserId: t.owner_user_id,
          ownerName: t.owner_name,
          ownerEmail: t.owner_email,
          address: t.address,
          verificationStatus: t.verification_status,
          status: t.status,
          serviceRadiusKm: t.service_radius_km,
        };
      }),
    },
    c.get('requestId'),
  );
});

routes.post('/towing/:id/verify', async (c) => {
  const admin = await requireUser(c);
  const input = parseInput(adminVerifyMechanicSchema, await c.req.json().catch(() => ({})));
  const result = await c.env.DB.prepare(
    'UPDATE towing_partners SET verification_status = ?, updated_at = ? WHERE id = ?',
  )
    .bind(input.decision, nowIso(), c.req.param('id'))
    .run();
  if (result.meta.changes === 0) throw errors.notFound('Towing partner not found.');
  await audit(c.env, {
    actorUserId: admin.id,
    actorRole: 'ADMIN',
    action: 'TOWING_VERIFICATION_DECISION',
    entityType: 'towing_partner',
    entityId: c.req.param('id'),
    data: { decision: input.decision },
    requestId: c.get('requestId'),
  });
  return ok({ id: c.req.param('id'), verificationStatus: input.decision }, c.get('requestId'));
});

// ---------------------------------------------------------------------------
// Pricing + platform configuration
// ---------------------------------------------------------------------------

routes.get('/pricing', async (c) => {
  const rows = await c.env.DB.prepare('SELECT * FROM pricing_rules ORDER BY sort ASC, code ASC').all<{
    id: string;
    code: string;
    name: string;
    amount_cents: number;
    type: string;
    active: number;
    sort: number;
  }>();
  return ok(
    {
      items: rows.results.map((r) => ({
        id: r.id,
        code: r.code,
        name: r.name,
        amountCents: r.amount_cents,
        type: r.type as 'FIXED' | 'PERCENT' | 'PER_KM',
        active: r.active === 1,
        sort: r.sort,
      })),
    },
    c.get('requestId'),
  );
});

routes.post('/pricing', async (c) => {
  const admin = await requireUser(c);
  const input = parseInput(pricingRuleSchema, await c.req.json().catch(() => ({})));
  const existing = await c.env.DB.prepare('SELECT id FROM pricing_rules WHERE code = ?')
    .bind(input.code)
    .first<{ id: string }>();
  if (existing) throw errors.conflict('PRICING_RULE_EXISTS', 'A rule with this code already exists.');
  const id = newId();
  await c.env.DB.prepare(
    `INSERT INTO pricing_rules (id, code, name, amount_cents, type, active, sort, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      id,
      input.code,
      input.name,
      input.amountCents,
      input.type,
      input.active ? 1 : 0,
      input.sort,
      nowIso(),
      nowIso(),
    )
    .run();
  await syncPricingIntoConfig(c.env, admin.id);
  await audit(c.env, {
    actorUserId: admin.id,
    actorRole: 'ADMIN',
    action: 'PRICING_RULE_CREATED',
    entityType: 'pricing_rule',
    entityId: id,
    requestId: c.get('requestId'),
  });
  return ok({ id, ...input }, c.get('requestId'), 201);
});

routes.patch('/pricing/:id', async (c) => {
  const admin = await requireUser(c);
  const input = parseInput(pricingRuleSchema.partial(), await c.req.json().catch(() => ({})));
  const id = c.req.param('id');
  const sets: string[] = [];
  const binds: Array<string | number | null> = [];
  if (input.name !== undefined) {
    sets.push('name = ?');
    binds.push(input.name);
  }
  if (input.amountCents !== undefined) {
    sets.push('amount_cents = ?');
    binds.push(input.amountCents);
  }
  if (input.type !== undefined) {
    sets.push('type = ?');
    binds.push(input.type);
  }
  if (input.active !== undefined) {
    sets.push('active = ?');
    binds.push(input.active ? 1 : 0);
  }
  if (input.sort !== undefined) {
    sets.push('sort = ?');
    binds.push(input.sort);
  }
  if (sets.length === 0) return ok({ updated: false }, c.get('requestId'));
  sets.push('updated_at = ?');
  binds.push(nowIso(), id);
  const result = await c.env.DB.prepare(`UPDATE pricing_rules SET ${sets.join(', ')} WHERE id = ?`)
    .bind(...binds)
    .run();
  if (result.meta.changes === 0) throw errors.notFound('Pricing rule not found.');
  await syncPricingIntoConfig(c.env, admin.id);
  await audit(c.env, {
    actorUserId: admin.id,
    actorRole: 'ADMIN',
    action: 'PRICING_RULE_UPDATED',
    entityType: 'pricing_rule',
    entityId: id,
    requestId: c.get('requestId'),
  });
  return ok({ updated: true }, c.get('requestId'));
});

routes.delete('/pricing/:id', async (c) => {
  const admin = await requireUser(c);
  const id = c.req.param('id');
  const result = await c.env.DB.prepare('DELETE FROM pricing_rules WHERE id = ?').bind(id).run();
  if (result.meta.changes === 0) throw errors.notFound('Pricing rule not found.');
  await syncPricingIntoConfig(c.env, admin.id);
  await audit(c.env, {
    actorUserId: admin.id,
    actorRole: 'ADMIN',
    action: 'PRICING_RULE_DELETED',
    entityType: 'pricing_rule',
    entityId: id,
    requestId: c.get('requestId'),
  });
  return ok({ deleted: true }, c.get('requestId'));
});

async function syncPricingIntoConfig(env: Env, updatedBy: string): Promise<void> {
  const rows = await env.DB.prepare('SELECT code, amount_cents, type, active FROM pricing_rules').all<{
    code: string;
    amount_cents: number;
    type: string;
    active: number;
  }>();
  const pricing: Record<string, number> = {};
  for (const r of rows.results) {
    if (r.active !== 1) continue;
    const map: Record<string, string> = {
      base_fee: 'baseFeeCents',
      distance_fee: 'distanceFeePerKmCents',
      night_fee: 'nightSurchargeCents',
      emergency_fee: 'emergencySurchargeCents',
      towing_fee: 'towingFeeCents',
      platform_fee: 'platformFeePercent',
    };
    const key = map[r.code];
    if (key) pricing[key] = r.amount_cents;
  }
  if (Object.keys(pricing).length > 0) {
    const existing = (await listConfig(env)).find((x) => x.key === 'pricing')?.value;
    const merged = { ...(typeof existing === 'object' && existing ? existing : {}), ...pricing };
    await setConfigValue(env, 'pricing', merged, updatedBy);
  }
}

routes.get('/config', async (c) => {
  const items = await listConfig(c.env);
  return ok({ items }, c.get('requestId'));
});

routes.patch('/config', async (c) => {
  const admin = await requireUser(c);
  const input = parseInput(platformConfigSchema, await c.req.json().catch(() => ({})));
  await setConfigValue(c.env, input.key, input.value, admin.id);
  await invalidateConfigCache(c.env);
  await audit(c.env, {
    actorUserId: admin.id,
    actorRole: 'ADMIN',
    action: 'CONFIG_UPDATED',
    entityType: 'platform_config',
    entityId: input.key,
    requestId: c.get('requestId'),
  });
  return ok({ key: input.key, value: input.value }, c.get('requestId'));
});

// ---------------------------------------------------------------------------
// Service categories
// ---------------------------------------------------------------------------

routes.get('/service-categories', async (c) => {
  const rows = await c.env.DB.prepare('SELECT * FROM service_categories ORDER BY sort ASC').all();
  return ok(
    {
      items: rows.results.map((r) => {
        const cat = r as never as {
          code: string;
          name_en: string;
          name_hi: string;
          icon: string;
          required_skills: string;
          required_equipment: string;
          active: number;
          sort: number;
        };
        return {
          code: cat.code,
          nameEn: cat.name_en,
          nameHi: cat.name_hi,
          icon: cat.icon,
          requiredSkills: JSON.parse(cat.required_skills || '[]') as string[],
          requiredEquipment: JSON.parse(cat.required_equipment || '[]') as string[],
          active: cat.active === 1,
          sort: cat.sort,
        };
      }),
      skillCatalog: SKILL_CATALOG,
      equipmentCatalog: EQUIPMENT_CATALOG,
    },
    c.get('requestId'),
  );
});

routes.post('/service-categories', async (c) => {
  const input = parseInput(serviceCategorySchema, await c.req.json().catch(() => ({})));
  const existing = await c.env.DB.prepare('SELECT code FROM service_categories WHERE code = ?')
    .bind(input.code)
    .first();
  if (existing) throw errors.conflict('CATEGORY_EXISTS', 'Category code already exists.');
  await c.env.DB.prepare(
    `INSERT INTO service_categories (code, name_en, name_hi, icon, required_skills, required_equipment, active, sort, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      input.code,
      input.nameEn,
      input.nameHi,
      input.icon,
      JSON.stringify(input.requiredSkills),
      JSON.stringify(input.requiredEquipment),
      input.active ? 1 : 0,
      input.sort,
      nowIso(),
    )
    .run();
  return ok({ ...input }, c.get('requestId'), 201);
});

/** Edits take effect at runtime for request creation and dispatch matching. */
routes.put('/service-categories/:code', async (c) => {
  const code = c.req.param('code');
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const input = parseInput(serviceCategorySchema, { ...body, code });
  const existing = await c.env.DB.prepare('SELECT code FROM service_categories WHERE code = ?')
    .bind(code)
    .first();
  if (!existing) throw errors.notFound('Service category not found.');
  await c.env.DB.prepare(
    `UPDATE service_categories SET name_en = ?, name_hi = ?, icon = ?, required_skills = ?,
       required_equipment = ?, active = ?, sort = ? WHERE code = ?`,
  )
    .bind(
      input.nameEn,
      input.nameHi,
      input.icon,
      JSON.stringify(input.requiredSkills),
      JSON.stringify(input.requiredEquipment),
      input.active ? 1 : 0,
      input.sort,
      code,
    )
    .run();
  return ok({ ...input, code }, c.get('requestId'));
});

// ---------------------------------------------------------------------------
// Coupons
// ---------------------------------------------------------------------------

routes.get('/coupons', async (c) => {
  const rows = await c.env.DB.prepare(
    'SELECT * FROM coupons ORDER BY created_at DESC LIMIT 200',
  ).all<{
    id: string;
    code: string;
    description: string | null;
    percent_off: number;
    min_amount_cents: number;
    max_uses: number | null;
    used_count: number;
    valid_from: string | null;
    valid_until: string | null;
    active: number;
    created_at: string;
  }>();
  return ok(
    {
      items: rows.results.map((r) => ({
        id: r.id,
        code: r.code,
        description: r.description,
        percentOff: r.percent_off,
        minAmountCents: r.min_amount_cents,
        maxUses: r.max_uses,
        usedCount: r.used_count,
        validFrom: r.valid_from,
        validUntil: r.valid_until,
        active: r.active === 1,
        createdAt: r.created_at,
      })),
    },
    c.get('requestId'),
  );
});

routes.post('/coupons', async (c) => {
  const admin = await requireUser(c);
  await enforceRateLimit(c.env, 'coupon', admin.id, 20, 60, 'Too many coupon operations. Please wait.');
  const input = parseInput(createCouponSchema, await c.req.json().catch(() => ({})));
  const existing = await c.env.DB.prepare('SELECT id FROM coupons WHERE code = ?')
    .bind(input.code)
    .first<{ id: string }>();
  if (existing) throw errors.conflict('COUPON_EXISTS', 'A coupon with this code already exists.');
  const id = newId();
  await c.env.DB.prepare(
    `INSERT INTO coupons (id, code, description, percent_off, min_amount_cents, max_uses,
                          valid_from, valid_until, active, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
  )
    .bind(
      id,
      input.code,
      input.description ?? null,
      input.percentOff,
      input.minAmountCents,
      input.maxUses ?? null,
      input.validFrom ?? null,
      input.validUntil ?? null,
      nowIso(),
      nowIso(),
    )
    .run();
  await audit(c.env, {
    actorUserId: admin.id,
    actorRole: 'ADMIN',
    action: 'COUPON_CREATED',
    entityType: 'coupon',
    entityId: id,
    data: { code: input.code, percentOff: input.percentOff },
    requestId: c.get('requestId'),
  });
  return ok({ id, code: input.code, percentOff: input.percentOff }, c.get('requestId'), 201);
});

routes.post('/coupons/:id/toggle', async (c) => {
  const admin = await requireUser(c);
  await enforceRateLimit(c.env, 'coupon', admin.id, 20, 60, 'Too many coupon operations. Please wait.');
  const result = await c.env.DB.prepare(
    'UPDATE coupons SET active = CASE WHEN active = 1 THEN 0 ELSE 1, updated_at = ? WHERE id = ?',
  )
    .bind(nowIso(), c.req.param('id'))
    .run();
  if (result.meta.changes === 0) throw errors.notFound('Coupon not found.');
  await audit(c.env, {
    actorUserId: admin.id,
    actorRole: 'ADMIN',
    action: 'COUPON_TOGGLED',
    entityType: 'coupon',
    entityId: c.req.param('id'),
    requestId: c.get('requestId'),
  });
  return ok({ toggled: true }, c.get('requestId'));
});

// ---------------------------------------------------------------------------
// Payments + refunds
// ---------------------------------------------------------------------------

routes.get('/payments', async (c) => {
  const rows = await c.env.DB.prepare(
    `SELECT p.*, e.reference, u.full_name AS driver_name
     FROM payments p
     JOIN emergency_requests e ON e.id = p.request_id
     JOIN users u ON u.id = e.driver_user_id
     ORDER BY p.created_at DESC LIMIT 100`,
  ).all<{
    id: string;
    request_id: string;
    reference: string;
    driver_name: string;
    provider: string;
    provider_ref: string | null;
    status: string;
    amount_cents: number;
    method: string | null;
    coupon_code: string | null;
    refunded_at: string | null;
    refund_reason: string | null;
    refunded_cents: number;
    paid_at: string | null;
    created_at: string;
  }>();
  return ok(
    {
      items: rows.results.map((r) => ({
        id: r.id,
        requestId: r.request_id,
        reference: r.reference,
        driverName: r.driver_name,
        provider: r.provider,
        providerRef: r.provider_ref,
        status: r.status,
        amountCents: r.amount_cents,
        method: r.method,
        couponCode: r.coupon_code,
        refundedAt: r.refunded_at,
        refundReason: r.refund_reason,
        refundedCents: r.refunded_cents ?? 0,
        paidAt: r.paid_at,
        createdAt: r.created_at,
      })),
    },
    c.get('requestId'),
  );
});

/** Refund a settled payment — full amount by default, or a partial amount. */
routes.post('/payments/:id/refund', async (c) => {
  const admin = await requireUser(c);
  await enforceRateLimit(c.env, 'admin-money', admin.id, 10, 300, 'Too many refund attempts. Please wait.');
  const body = (await c.req.json().catch(() => ({}))) as { reason?: string; amountCents?: number };
  const payment = await c.env.DB.prepare('SELECT * FROM payments WHERE id = ?')
    .bind(c.req.param('id'))
    .first<{
      id: string;
      request_id: string;
      provider: string;
      provider_ref: string | null;
      status: string;
      amount_cents: number;
      refunded_cents: number;
    }>();
  if (!payment) throw errors.notFound('Payment not found.');
  if (payment.status !== 'PAID') {
    throw errors.conflict('PAYMENT_NOT_REFUNDABLE', 'Only paid payments can be refunded.');
  }
  const alreadyRefunded = payment.refunded_cents ?? 0;
  const remainingCents = payment.amount_cents - alreadyRefunded;
  if (remainingCents <= 0) {
    throw errors.conflict('PAYMENT_ALREADY_REFUNDED', 'This payment has already been fully refunded.');
  }
  if (body.amountCents !== undefined) {
    if (!Number.isInteger(body.amountCents) || body.amountCents <= 0) {
      throw errors.validation('amountCents must be a positive whole number.');
    }
    if (body.amountCents > remainingCents) {
      throw errors.validation(
        `Refund cannot exceed the remaining ₹${Math.floor(remainingCents / 100)}.`,
      );
    }
  }
  const refundCents = body.amountCents ?? remainingCents;
  const isFull = alreadyRefunded + refundCents >= payment.amount_cents;

  if (payment.provider !== 'cash') {
    if (!payment.provider_ref) throw errors.conflict('NO_PROVIDER_REF', 'Payment has no provider reference.');
    const provider = getPaymentProvider(c.env);
    if (!provider.refund) {
      throw errors.unavailable('REFUND_UNSUPPORTED', 'The configured payment provider does not support refunds.', 501);
    }
    const result = await provider.refund(payment.provider_ref, refundCents).catch(() => ({ status: 'FAILED' as const }));
    if (result.status !== 'REFUNDED') {
      throw errors.unavailable('REFUND_FAILED', 'The payment provider rejected the refund.', 502);
    }
  }

  const request = await c.env.DB.prepare(
    'SELECT id, driver_user_id, assigned_mechanic_user_id, reference FROM emergency_requests WHERE id = ?',
  )
    .bind(payment.request_id)
    .first<{ id: string; driver_user_id: string; assigned_mechanic_user_id: string | null; reference: string }>();
  const cfg = await getConfig(c.env);
  // Reverse exactly the payout credited for the refunded slice — never below zero.
  const payout = computeMechanicPayout(refundCents, cfg.pricing.platformFeePercent);
  const now = nowIso();
  const refundNote = isFull
    ? (body.reason ?? null)
    : `Partial refund of ₹${Math.floor(refundCents / 100)}${body.reason ? ` — ${body.reason}` : ''}`;

  await c.env.DB.batch([
    c.env.DB.prepare(
      `UPDATE payments SET refunded_cents = refunded_cents + ?, refund_reason = ?, updated_at = ?${
        isFull ? ", status = 'REFUNDED', refunded_at = ?" : ''
      } WHERE id = ?`,
    ).bind(...(isFull ? [refundCents, refundNote, now, now, payment.id] : [refundCents, refundNote, now, payment.id])),
    ...(isFull
      ? [
          c.env.DB.prepare(
            `UPDATE emergency_requests SET payment_status = 'REFUNDED', updated_at = ?
             WHERE id = ? AND payment_status = 'PAID'`,
          ).bind(now, payment.request_id),
        ]
      : []),
    ...(request?.assigned_mechanic_user_id
      ? [
          c.env.DB.prepare(
            'UPDATE mechanics SET earnings_cents = MAX(earnings_cents - ?, 0), updated_at = ? WHERE user_id = ?',
          ).bind(payout.payoutCents, now, request.assigned_mechanic_user_id),
          c.env.DB.prepare(
            isFull
              ? 'UPDATE jobs SET earnings_cents = 0 WHERE request_id = ? AND deleted_at IS NULL'
              : 'UPDATE jobs SET earnings_cents = MAX(earnings_cents - ?, 0) WHERE request_id = ? AND deleted_at IS NULL',
          ).bind(...(isFull ? [payment.request_id] : [payout.payoutCents, payment.request_id])),
        ]
      : []),
  ]);

  const amountLabel = `₹${Math.floor(refundCents / 100)}`;
  if (request) {
    await recordEvent(c.env, {
      requestId: request.id,
      type: 'PAYMENT_REFUNDED',
      message: `${isFull ? 'Payment' : 'Partial payment'} of ${amountLabel} refunded${body.reason ? ` — ${body.reason}` : ''}`,
      actorRole: 'ADMIN',
      actorUserId: admin.id,
      data: { paymentId: payment.id, amountCents: refundCents, partial: !isFull },
    });
    await notify(c.env, {
      userId: request.driver_user_id,
      type: 'PAYMENT_REFUNDED',
      title: 'Payment refunded',
      body: `${amountLabel} for ${request.reference} has been refunded.`,
      data: { requestId: request.id, paymentId: payment.id, amountCents: refundCents },
      requestId: request.id,
    }).catch(() => undefined);
  }

  await audit(c.env, {
    actorUserId: admin.id,
    actorRole: 'ADMIN',
    action: 'PAYMENT_REFUNDED',
    entityType: 'payment',
    entityId: payment.id,
    data: { requestId: payment.request_id, amountCents: refundCents, partial: !isFull, reason: body.reason ?? null },
    requestId: c.get('requestId'),
  });

  return ok(
    {
      refund: {
        paymentId: payment.id,
        amountCents: refundCents,
        refundedCents: alreadyRefunded + refundCents,
        partial: !isFull,
        status: isFull ? 'REFUNDED' : 'PAID',
      },
    },
    c.get('requestId'),
  );
});

// ---------------------------------------------------------------------------
// Payout requests (mechanic withdrawals)
// ---------------------------------------------------------------------------

routes.get('/payouts', async (c) => {
  const status = c.req.query('status');
  const rows = await c.env.DB.prepare(
    `SELECT p.*, u.full_name, u.email
     FROM payout_requests p JOIN users u ON u.id = p.mechanic_user_id
     ${status ? 'WHERE p.status = ?' : ''}
     ORDER BY p.created_at DESC LIMIT 100`,
  )
    .bind(...(status ? [status] : []))
    .all<{
      id: string;
      mechanic_user_id: string;
      full_name: string;
      email: string;
      amount_cents: number;
      status: string;
      account_json: string;
      note: string | null;
      decided_at: string | null;
      created_at: string;
    }>();
  return ok(
    {
      items: rows.results.map((r) => ({
        id: r.id,
        mechanicUserId: r.mechanic_user_id,
        mechanicName: r.full_name,
        mechanicEmail: r.email,
        amountCents: r.amount_cents,
        status: r.status,
        account: safeJson(r.account_json),
        note: r.note,
        decidedAt: r.decided_at,
        createdAt: r.created_at,
      })),
    },
    c.get('requestId'),
  );
});

routes.post('/payouts/:id/decide', async (c) => {
  const admin = await requireUser(c);
  await enforceRateLimit(c.env, 'admin-money', admin.id, 10, 300, 'Too many payout decisions. Please wait.');
  const body = (await c.req.json().catch(() => ({}))) as { decision?: string; note?: string };
  if (body.decision !== 'PAID' && body.decision !== 'REJECTED') {
    throw errors.validation('decision must be PAID or REJECTED.');
  }
  const payout = await c.env.DB.prepare('SELECT * FROM payout_requests WHERE id = ?')
    .bind(c.req.param('id'))
    .first<{ id: string; mechanic_user_id: string; amount_cents: number; status: string }>();
  if (!payout) throw errors.notFound('Payout request not found.');
  if (payout.status !== 'PENDING') {
    throw errors.conflict('PAYOUT_NOT_PENDING', 'This payout has already been decided.');
  }

  const now = nowIso();
  await c.env.DB.prepare(
    `UPDATE payout_requests SET status = ?, note = COALESCE(?, note), decided_by = ?, decided_at = ?, updated_at = ?
     WHERE id = ?`,
  )
    .bind(body.decision, body.note ?? null, admin.id, now, now, payout.id)
    .run();

  if (body.decision === 'PAID') {
    await notify(c.env, {
      userId: payout.mechanic_user_id,
      type: 'PAYOUT_PAID',
      title: 'Payout sent',
      body: `Your payout of ₹${Math.round(payout.amount_cents / 100)} is on its way.`,
      data: { payoutId: payout.id },
    }).catch(() => undefined);
  }

  await audit(c.env, {
    actorUserId: admin.id,
    actorRole: 'ADMIN',
    action: `PAYOUT_${body.decision}`,
    entityType: 'payout_request',
    entityId: payout.id,
    data: { mechanicUserId: payout.mechanic_user_id, amountCents: payout.amount_cents, note: body.note ?? null },
    requestId: c.get('requestId'),
  });

  return ok({ payout: { id: payout.id, status: body.decision } }, c.get('requestId'));
});

function safeJson(raw: string | null): unknown {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Audit logs + disputes
// ---------------------------------------------------------------------------

routes.get('/audit-logs', async (c) => {
  const query = parseInput(paginationSchema, c.req.query());
  const rows = await c.env.DB.prepare(
    'SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT ? OFFSET ?',
  )
    .bind(query.limit, query.offset)
    .all();
  const total = await c.env.DB.prepare('SELECT COUNT(*) AS c FROM audit_logs').first<{ c: number }>();
  return ok(
    {
      items: rows.results.map((r) => {
        const a = r as never as {
          id: string;
          actor_user_id: string | null;
          actor_role: string | null;
          action: string;
          entity_type: string | null;
          entity_id: string | null;
          data_json: string | null;
          request_id: string | null;
          created_at: string;
        };
        return {
          id: a.id,
          actorUserId: a.actor_user_id,
          actorName: null,
          actorRole: a.actor_role as never,
          action: a.action,
          entityType: a.entity_type,
          entityId: a.entity_id,
          data: a.data_json ? (JSON.parse(a.data_json) as Record<string, unknown>) : null,
          requestId: a.request_id,
          createdAt: a.created_at,
        };
      }),
      total: total?.c ?? 0,
      limit: query.limit,
      offset: query.offset,
    },
    c.get('requestId'),
  );
});

routes.get('/disputes', async (c) => {
  const rows = await c.env.DB.prepare(
    `SELECT d.*, e.reference, u.full_name AS raised_by_name
     FROM disputes d
     JOIN emergency_requests e ON e.id = d.request_id
     JOIN users u ON u.id = d.raised_by
     ORDER BY d.created_at DESC LIMIT 100`,
  ).all();
  return ok(
    {
      items: rows.results.map((r) => {
        const d = r as never as {
          id: string;
          request_id: string;
          reference: string;
          raised_by: string;
          raised_by_name: string;
          reason: string;
          category: string | null;
          status: string;
          resolution: string | null;
          created_at: string;
        };
        return {
          id: d.id,
          requestId: d.request_id,
          reference: d.reference,
          raisedBy: d.raised_by,
          raisedByName: d.raised_by_name,
          category: d.category ?? 'OTHER',
          reason: d.reason,
          status: d.status,
          resolution: d.resolution,
          createdAt: d.created_at,
        };
      }),
    },
    c.get('requestId'),
  );
});

routes.post('/disputes/:id/resolve', async (c) => {
  const admin = await requireUser(c);
  const body = (await c.req.json().catch(() => ({}))) as { resolution?: string };
  if (!body.resolution) throw errors.validation('resolution is required.');
  const dispute = await c.env.DB.prepare(
    `SELECT d.id, d.request_id, d.raised_by, d.status, e.reference
     FROM disputes d JOIN emergency_requests e ON e.id = d.request_id
     WHERE d.id = ?`,
  )
    .bind(c.req.param('id'))
    .first<{ id: string; request_id: string; raised_by: string; status: string; reference: string }>();
  if (!dispute) throw errors.notFound('Dispute not found.');
  if (dispute.status === 'RESOLVED') {
    throw errors.conflict('DISPUTE_ALREADY_RESOLVED', 'This dispute is already resolved.');
  }
  const result = await c.env.DB.prepare(
    `UPDATE disputes SET status = 'RESOLVED', resolution = ?, resolved_by = ?, resolved_at = ?, updated_at = ?
     WHERE id = ? AND status != 'RESOLVED'`,
  )
    .bind(body.resolution, admin.id, nowIso(), nowIso(), c.req.param('id'))
    .run();
  if (result.meta.changes === 0) throw errors.conflict('DISPUTE_ALREADY_RESOLVED', 'This dispute is already resolved.');
  await audit(c.env, {
    actorUserId: admin.id,
    actorRole: 'ADMIN',
    action: 'DISPUTE_RESOLVED',
    entityType: 'dispute',
    entityId: c.req.param('id'),
    data: { resolution: body.resolution },
    requestId: c.get('requestId'),
  });
  await notify(c.env, {
    userId: dispute.raised_by,
    type: 'DISPUTE_RESOLVED',
    title: 'Dispute resolved',
    body: `Your dispute on ${dispute.reference} was resolved: ${body.resolution.slice(0, 160)}`,
    data: {
      disputeId: dispute.id,
      requestId: dispute.request_id,
      reference: dispute.reference,
      resolution: body.resolution,
    },
  }).catch(() => undefined);
  return ok({ resolved: true }, c.get('requestId'));
});

export default routes;
