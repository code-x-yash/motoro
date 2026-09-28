import { Hono } from 'hono';
import type { Env } from '../env';
import { ok } from '../lib/response';
import { errors } from '../lib/errors';
import { requireUser, requirePermission } from '../lib/auth';
import { parseInput } from '../lib/validate';
import { createVehicleSchema, paginationSchema, updateVehicleSchema } from '@rr/validation';
import { mapVehicleRow, type VehicleRow } from '../lib/mappers';
import { newId, nowIso } from '../lib/ids';
import { audit } from '../lib/audit';

const routes = new Hono<{ Bindings: Env }>();

routes.get('/', async (c) => {
  const user = await requireUser(c);
  const rows = await c.env.DB.prepare(
    'SELECT * FROM vehicles WHERE user_id = ? AND deleted_at IS NULL ORDER BY created_at DESC',
  )
    .bind(user.id)
    .all<VehicleRow>();
  return ok({ items: rows.results.map(mapVehicleRow) }, c.get('requestId'));
});

routes.get('/:id', async (c) => {
  const user = await requireUser(c);
  const row = await c.env.DB.prepare(
    'SELECT * FROM vehicles WHERE id = ? AND deleted_at IS NULL',
  )
    .bind(c.req.param('id'))
    .first<VehicleRow>();
  if (!row) throw errors.notFound('Vehicle not found.');
  if (row.user_id !== user.id && user.role !== 'ADMIN' && user.role !== 'OPERATIONS') {
    throw errors.forbidden('You do not have access to this vehicle.');
  }
  return ok({ vehicle: mapVehicleRow(row) }, c.get('requestId'));
});

routes.post('/', requirePermission('VEHICLE_MANAGE'), async (c) => {
  const user = await requireUser(c);
  const input = parseInput(createVehicleSchema, await c.req.json().catch(() => ({})));
  const id = newId();
  const now = nowIso();

  const duplicate = await c.env.DB.prepare(
    'SELECT id FROM vehicles WHERE registration_number = ? AND user_id = ? AND deleted_at IS NULL',
  )
    .bind(input.registrationNumber, user.id)
    .first<{ id: string }>();
  if (duplicate) throw errors.conflict('VEHICLE_EXISTS', 'This vehicle is already in your garage.');

  await c.env.DB.prepare(
    `INSERT INTO vehicles (id, user_id, registration_number, make, model, variant, year, fuel_type,
                           vehicle_type, insurance_expiry, rc_number, color, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      id,
      user.id,
      input.registrationNumber,
      input.make,
      input.model,
      input.variant ?? null,
      input.year ?? null,
      input.fuelType,
      input.vehicleType,
      input.insuranceExpiry ?? null,
      input.rcNumber ?? null,
      input.color ?? null,
      now,
      now,
    )
    .run();

  const row = await c.env.DB.prepare('SELECT * FROM vehicles WHERE id = ?').bind(id).first<VehicleRow>();
  await audit(c.env, {
    actorUserId: user.id,
    actorRole: user.role,
    action: 'VEHICLE_CREATED',
    entityType: 'vehicle',
    entityId: id,
    requestId: c.get('requestId'),
  });
  return ok({ vehicle: row ? mapVehicleRow(row) : null }, c.get('requestId'), 201);
});

routes.patch('/:id', requirePermission('VEHICLE_MANAGE'), async (c) => {
  const user = await requireUser(c);
  const input = parseInput(updateVehicleSchema, await c.req.json().catch(() => ({})));
  const id = c.req.param('id');

  const existing = await c.env.DB.prepare('SELECT * FROM vehicles WHERE id = ? AND deleted_at IS NULL')
    .bind(id)
    .first<VehicleRow>();
  if (!existing) throw errors.notFound('Vehicle not found.');
  if (existing.user_id !== user.id) throw errors.forbidden('You do not have access to this vehicle.');

  const columnMap: Record<string, string> = {
    registrationNumber: 'registration_number',
    make: 'make',
    model: 'model',
    variant: 'variant',
    year: 'year',
    fuelType: 'fuel_type',
    vehicleType: 'vehicle_type',
    insuranceExpiry: 'insurance_expiry',
    rcNumber: 'rc_number',
    color: 'color',
  };
  const sets: string[] = [];
  const binds: Array<string | number | null> = [];
  for (const [key, column] of Object.entries(columnMap)) {
    const value = (input as Record<string, unknown>)[key];
    if (value !== undefined) {
      sets.push(`${column} = ?`);
      binds.push(value as string | number | null);
    }
  }
  if (sets.length === 0) return ok({ vehicle: mapVehicleRow(existing) }, c.get('requestId'));

  sets.push('updated_at = ?');
  binds.push(nowIso(), id);
  await c.env.DB.prepare(`UPDATE vehicles SET ${sets.join(', ')} WHERE id = ?`).bind(...binds).run();

  const row = await c.env.DB.prepare('SELECT * FROM vehicles WHERE id = ?').bind(id).first<VehicleRow>();
  return ok({ vehicle: row ? mapVehicleRow(row) : null }, c.get('requestId'));
});

routes.delete('/:id', requirePermission('VEHICLE_MANAGE'), async (c) => {
  const user = await requireUser(c);
  const id = c.req.param('id');
  const existing = await c.env.DB.prepare('SELECT * FROM vehicles WHERE id = ? AND deleted_at IS NULL')
    .bind(id)
    .first<VehicleRow>();
  if (!existing) throw errors.notFound('Vehicle not found.');
  if (existing.user_id !== user.id) throw errors.forbidden('You do not have access to this vehicle.');

  await c.env.DB.prepare('UPDATE vehicles SET deleted_at = ?, updated_at = ? WHERE id = ?')
    .bind(nowIso(), nowIso(), id)
    .run();
  return ok({ deleted: true }, c.get('requestId'));
});

export const pagination = paginationSchema;
export default routes;
