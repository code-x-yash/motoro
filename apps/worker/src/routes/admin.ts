import { Hono } from 'hono';
import type { Env } from '../env';
import { ok } from '../lib/response';
import { errors } from '../lib/errors';
import { requireUser, requireRole } from '../lib/auth';
import { parseInput } from '../lib/validate';
import {
  adminSuspendSchema,
  adminVerifyMechanicSchema,
  paginationSchema,
  platformConfigSchema,
  pricingRuleSchema,
  serviceCategorySchema,
} from '@rr/validation';
import { audit } from '../lib/audit';
import { invalidateConfigCache, listConfig, setConfigValue } from '../lib/config';
import { newId, nowIso } from '../lib/ids';
import { revokeAllSessions } from '../lib/session';
import { setMechanicStatus } from '../lib/mechanics';
import { notify } from '../lib/notify';
import { SKILL_CATALOG, EQUIPMENT_CATALOG } from '@rr/config';

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
      `SELECT COALESCE(SUM(amount_cents), 0) AS total FROM payments WHERE status = 'PAID'`,
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
  const result = await c.env.DB.prepare(
    `UPDATE disputes SET status = 'RESOLVED', resolution = ?, resolved_by = ?, resolved_at = ?, updated_at = ?
     WHERE id = ?`,
  )
    .bind(body.resolution, admin.id, nowIso(), nowIso(), c.req.param('id'))
    .run();
  if (result.meta.changes === 0) throw errors.notFound('Dispute not found.');
  await audit(c.env, {
    actorUserId: admin.id,
    actorRole: 'ADMIN',
    action: 'DISPUTE_RESOLVED',
    entityType: 'dispute',
    entityId: c.req.param('id'),
    data: { resolution: body.resolution },
    requestId: c.get('requestId'),
  });
  return ok({ resolved: true }, c.get('requestId'));
});

export default routes;
