import type {
  DriverProfileDto,
  MechanicProfileDto,
  SessionPayload,
  SessionUser,
  WorkshopProfileDto,
  TowingProfileDto,
} from '@rr/types';
import type { Env } from '../env';
import { mapEmergencyContact, mapMechanicProfile, mapTowing, mapWorkshop } from './mappers';

/** Builds the full session payload (user + role profile) for /api/auth/me. */
export async function loadSessionUser(env: Env, userId: string): Promise<SessionPayload> {
  const row = await env.DB.prepare(
    `SELECT id, role, email, phone, full_name, locale, status, avatar_key, email_verified_at, phone_verified_at, created_at
     FROM users WHERE id = ?`,
  )
    .bind(userId)
    .first<{
      id: string;
      role: string;
      email: string;
      phone: string | null;
      full_name: string;
      locale: string;
      status: string;
      avatar_key: string | null;
      email_verified_at: string | null;
      phone_verified_at: string | null;
      created_at: string;
    }>();

  if (!row) throw new Error('User not found');

  const user = {
    id: row.id,
    role: row.role as SessionUser['role'],
    email: row.email,
    phone: row.phone,
    fullName: row.full_name,
    locale: row.locale as 'en' | 'hi',
    status: row.status as SessionUser['status'],
    emailVerifiedAt: row.email_verified_at,
    phoneVerifiedAt: row.phone_verified_at,
    avatarUrl: null,
    createdAt: row.created_at,
  };

  let profile:
    | DriverProfileDto
    | MechanicProfileDto
    | WorkshopProfileDto
    | TowingProfileDto
    | null = null;

  switch (row.role) {
    case 'DRIVER': {
      const driver = await env.DB.prepare('SELECT * FROM drivers WHERE user_id = ?')
        .bind(userId)
        .first<{ membership: DriverProfileDto['membership'] }>();
      const contacts = await env.DB.prepare(
        'SELECT id, name, phone, relationship FROM emergency_contacts WHERE user_id = ? AND deleted_at IS NULL ORDER BY created_at',
      )
        .bind(userId)
        .all<{ id: string; name: string; phone: string; relationship: string }>();
      profile = {
        userId,
        membership: driver?.membership ?? 'FREE',
        emergencyContacts: contacts.results.map(mapEmergencyContact),
      };
      break;
    }
    case 'MECHANIC': {
      const mechanic = await env.DB.prepare(
        `SELECT m.*, u.full_name FROM mechanics m JOIN users u ON u.id = m.user_id WHERE m.user_id = ?`,
      )
        .bind(userId)
        .first<Parameters<typeof mapMechanicProfile>[1]>();
      if (mechanic) profile = await mapMechanicProfile(env, mechanic);
      break;
    }
    case 'WORKSHOP': {
      const workshop = await env.DB.prepare(
        'SELECT * FROM workshops WHERE owner_user_id = ? AND deleted_at IS NULL LIMIT 1',
      )
        .bind(userId)
        .first<Parameters<typeof mapWorkshop>[1]>();
      if (workshop) profile = await mapWorkshop(env, workshop);
      break;
    }
    case 'TOWING_PARTNER': {
      const towing = await env.DB.prepare(
        'SELECT * FROM towing_partners WHERE owner_user_id = ? AND deleted_at IS NULL LIMIT 1',
      )
        .bind(userId)
        .first<Parameters<typeof mapTowing>[1]>();
      if (towing) profile = await mapTowing(env, towing);
      break;
    }
    default:
      profile = null;
  }

  return { user, profile };
}
