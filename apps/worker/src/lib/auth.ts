import type { Context, MiddlewareHandler } from 'hono';
import type { Role } from '@rr/types';
import type { Env } from '../env';
import { errors } from './errors';
import { getSessionUser, sessionTokenFromRequest, type SessionUserRecord } from './session';

export type AuthUser = SessionUserRecord['user'];

declare module 'hono' {
  interface ContextVariableMap {
    authUser: AuthUser;
    requestId: string;
    sessionToken?: string;
  }
}

const PERMISSIONS: Record<Role, string[]> = {
  DRIVER: [
    'EMERGENCY_CREATE',
    'EMERGENCY_VIEW_OWN',
    'EMERGENCY_CANCEL_OWN',
    'VEHICLE_MANAGE',
    'QUOTE_DECIDE',
    'PAYMENT_CREATE',
    'REVIEW_CREATE',
    'PROFILE_MANAGE',
    'CONTACT_MANAGE',
    'UPLOAD',
  ],
  MECHANIC: [
    'DISPATCH_RESPOND',
    'JOB_UPDATE',
    'DIAGNOSIS_CREATE',
    'QUOTE_CREATE',
    'PROFILE_MANAGE',
    'MECHANIC_AVAILABILITY',
    'UPLOAD',
  ],
  WORKSHOP: ['JOB_UPDATE', 'MECHANIC_MANAGE', 'PROFILE_MANAGE', 'UPLOAD', 'DISPATCH_RESPOND'],
  TOWING_PARTNER: ['TOWING_JOB_UPDATE', 'PROFILE_MANAGE', 'UPLOAD'],
  OPERATIONS: [
    'OPS_VIEW',
    'OPS_ASSIGN',
    'OPS_ESCALATE',
    'OPS_NOTE',
    'OPS_CONTACT',
    'OPS_CANCEL',
    'EMERGENCY_VIEW_ALL',
    'UPLOAD',
  ],
  ADMIN: ['*'],
};

export function hasPermission(role: Role, permission: string): boolean {
  const list = PERMISSIONS[role];
  if (!list) return false;
  return list.includes('*') || list.includes(permission);
}

export function permissionsFor(role: Role): string[] {
  return PERMISSIONS[role] ?? [];
}

/** Reads the session cookie and attaches the user when present (never throws). */
export const attachUser: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
  const token = sessionTokenFromRequest(c.req.raw, c.env);
  if (token) {
    const record = await getSessionUser(c.env, token);
    if (record) {
      c.set('authUser', record.user);
      c.set('sessionToken', token);
    }
  }
  await next();
};

/** Throws UNAUTHENTICATED when no valid session exists. */
export async function requireUser(c: Context<{ Bindings: Env }>): Promise<AuthUser> {
  const user = c.get('authUser');
  if (!user) throw errors.unauthorized();
  return user;
}

export function requireRole(...roles: Role[]): MiddlewareHandler<{ Bindings: Env }> {
  return async (c, next) => {
    const user = await requireUser(c);
    if (!roles.includes(user.role as Role)) {
      throw errors.forbidden(`This action requires one of: ${roles.join(', ')}.`);
    }
    await next();
  };
}

export function requirePermission(permission: string): MiddlewareHandler<{ Bindings: Env }> {
  return async (c, next) => {
    const user = await requireUser(c);
    if (!hasPermission(user.role as Role, permission)) {
      throw errors.forbidden('You do not have permission to perform this action.');
    }
    await next();
  };
}

/** Resource ownership check: the actor must own the resource or hold an allowed role. */
export function assertOwnership(
  user: AuthUser,
  ownerUserId: string | null | undefined,
  allowedRoles: Role[] = ['ADMIN', 'OPERATIONS'],
): void {
  if (ownerUserId && user.id === ownerUserId) return;
  if (allowedRoles.includes(user.role as Role)) return;
  throw errors.forbidden('You do not have access to this resource.');
}

export async function currentUserOrNull(c: Context<{ Bindings: Env }>): Promise<AuthUser | null> {
  const existing = c.get('authUser');
  if (existing) return existing;
  const token = sessionTokenFromRequest(c.req.raw, c.env);
  if (!token) return null;
  const record = await getSessionUser(c.env, token);
  return record?.user ?? null;
}
