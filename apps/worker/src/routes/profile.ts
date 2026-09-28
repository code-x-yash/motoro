import { Hono } from 'hono';
import type { Env } from '../env';
import { ok } from '../lib/response';
import { errors } from '../lib/errors';
import { requireUser, requirePermission } from '../lib/auth';
import { parseInput } from '../lib/validate';
import { emergencyContactSchema, updateProfileSchema } from '@rr/validation';
import { newId, nowIso } from '../lib/ids';
import { audit } from '../lib/audit';
import { loadSessionUser } from '../lib/user-dto';
import { mapEmergencyContact } from '../lib/mappers';
import { revokeAllSessions } from '../lib/session';

const routes = new Hono<{ Bindings: Env }>();

routes.get('/', async (c) => {
  const user = await requireUser(c);
  const dto = await loadSessionUser(c.env, user.id);
  return ok({ user: dto.user, profile: dto.profile }, c.get('requestId'));
});

routes.patch('/', requirePermission('PROFILE_MANAGE'), async (c) => {
  const user = await requireUser(c);
  const input = parseInput(updateProfileSchema, await c.req.json().catch(() => ({})));
  const sets: string[] = [];
  const binds: Array<string | null> = [];
  if (input.fullName !== undefined) {
    sets.push('full_name = ?');
    binds.push(input.fullName);
  }
  if (input.phone !== undefined) {
    const clash = await c.env.DB.prepare(
      'SELECT id FROM users WHERE phone = ? AND id != ? AND deleted_at IS NULL',
    )
      .bind(input.phone, user.id)
      .first<{ id: string }>();
    if (clash) throw errors.conflict('PHONE_TAKEN', 'That phone number is already in use.');
    sets.push('phone = ?');
    binds.push(input.phone);
  }
  if (input.locale !== undefined) {
    sets.push('locale = ?');
    binds.push(input.locale);
  }
  if (sets.length === 0) {
    const dto = await loadSessionUser(c.env, user.id);
    return ok({ user: dto.user, profile: dto.profile }, c.get('requestId'));
  }

  sets.push('updated_at = ?');
  binds.push(nowIso(), user.id);
  await c.env.DB.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`).bind(...binds).run();
  if (input.phone !== undefined) {
    await revokeAllSessions(c.env, user.id).catch(() => undefined);
  }
  await audit(c.env, {
    actorUserId: user.id,
    actorRole: user.role,
    action: 'PROFILE_UPDATED',
    entityType: 'user',
    entityId: user.id,
    requestId: c.get('requestId'),
  });
  const dto = await loadSessionUser(c.env, user.id);
  return ok({ user: dto.user, profile: dto.profile }, c.get('requestId'));
});

// --- emergency contacts ------------------------------------------------------

routes.get('/emergency-contacts', async (c) => {
  const user = await requireUser(c);
  const rows = await c.env.DB.prepare(
    'SELECT id, name, phone, relationship FROM emergency_contacts WHERE user_id = ? AND deleted_at IS NULL ORDER BY created_at DESC',
  )
    .bind(user.id)
    .all<{ id: string; name: string; phone: string; relationship: string }>();
  return ok({ items: rows.results.map(mapEmergencyContact) }, c.get('requestId'));
});

routes.post('/emergency-contacts', requirePermission('CONTACT_MANAGE'), async (c) => {
  const user = await requireUser(c);
  const input = parseInput(emergencyContactSchema, await c.req.json().catch(() => ({})));
  const id = newId();
  await c.env.DB.prepare(
    `INSERT INTO emergency_contacts (id, user_id, name, phone, relationship, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  )
    .bind(id, user.id, input.name, input.phone, input.relationship, nowIso())
    .run();
  return ok(
    { contact: { id, ...input } },
    c.get('requestId'),
    201,
  );
});

routes.delete('/emergency-contacts/:id', requirePermission('CONTACT_MANAGE'), async (c) => {
  const user = await requireUser(c);
  const id = c.req.param('id');
  const result = await c.env.DB.prepare(
    'UPDATE emergency_contacts SET deleted_at = ? WHERE id = ? AND user_id = ? AND deleted_at IS NULL',
  )
    .bind(nowIso(), id, user.id)
    .run();
  if (result.meta.changes === 0) throw errors.notFound('Contact not found.');
  return ok({ deleted: true }, c.get('requestId'));
});

export default routes;
