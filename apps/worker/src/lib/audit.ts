import type { Role } from '@rr/types';
import type { Env } from '../env';
import { newId, nowIso } from './ids';
import { logger } from './logger';

export interface AuditEntry {
  actorUserId?: string | null;
  actorRole?: Role | string | null;
  action: string;
  entityType?: string | null;
  entityId?: string | null;
  data?: Record<string, unknown> | null;
  ip?: string | null;
  requestId?: string | null;
}

/** Append-only audit trail. Never throws into the request path. */
export async function audit(env: Env, entry: AuditEntry): Promise<void> {
  try {
    await env.DB.prepare(
      `INSERT INTO audit_logs (id, actor_user_id, actor_role, action, entity_type, entity_id, data_json, ip, request_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        newId(),
        entry.actorUserId ?? null,
        entry.actorRole ?? null,
        entry.action,
        entry.entityType ?? null,
        entry.entityId ?? null,
        entry.data ? JSON.stringify(entry.data) : null,
        entry.ip ?? null,
        entry.requestId ?? null,
        nowIso(),
      )
      .run();
  } catch (err) {
    logger.warn(entry.requestId ?? 'audit', 'audit_log_failed', {
      action: entry.action,
      error: String(err),
    });
  }
}
