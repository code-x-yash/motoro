import type { Env } from '../env';
import { isProduction } from '../env';
import { AppError } from './errors';
import { generateOtp, sha256HexAsync } from './crypto';
import { isoIn, nowIso, newId } from './ids';
import { logger } from './logger';
import { sendSms } from './delivery';

/**
 * Signup / password-reset OTPs: code is stored only as a sha256 hash with a
 * hard TTL and attempt cap. Delivery goes through the textbee SMS gateway;
 * non-production responses may include `devOtp` so flows are testable
 * without a phone (same pattern as forgot-password's devToken).
 */

export type AuthOtpPurpose = 'SIGNUP' | 'RESET';

const OTP_TTL_MINUTES = 5;
const MAX_ATTEMPTS = 5;

export interface AuthOtpRequest {
  code: string;
  devOtp?: string;
}

export async function createAuthOtp(
  env: Env,
  purpose: AuthOtpPurpose,
  phone: string,
  meta?: Record<string, unknown>,
): Promise<AuthOtpRequest> {
  // Supersede any earlier live code for this target+purpose.
  await env.DB.prepare('DELETE FROM auth_otps WHERE purpose = ? AND phone = ?')
    .bind(purpose, phone)
    .run();

  const code = generateOtp();
  const hash = await sha256HexAsync(code);
  await env.DB.prepare(
    `INSERT INTO auth_otps (id, purpose, phone, code_hash, meta_json, attempts, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?, 0, ?, ?)`,
  )
    .bind(newId(), purpose, phone, hash, meta ? JSON.stringify(meta) : null, isoIn(OTP_TTL_MINUTES * 60), nowIso())
    .run();

  const message = `Your Motoro verification code is ${code}. Valid for ${OTP_TTL_MINUTES} minutes. Never share it with anyone.`;
  if (smsConfigured(env)) {
    try {
      await sendSms(env, { to: phone, body: message });
      logger.info(phone, 'auth_otp_sent', { purpose });
    } catch (err) {
      if (isProduction(env)) {
        throw new AppError('SMS_SEND_FAILED', 'Could not send the verification SMS. Please try again.', 502);
      }
      logger.warn(phone, 'auth_otp_sms_failed_dev_fallback', { error: String(err) });
    }
  } else if (isProduction(env)) {
    throw new AppError('SMS_NOT_CONFIGURED', 'SMS delivery is not configured on this deployment.', 503);
  }

  return { code, devOtp: isProduction(env) ? undefined : code };
}

function smsConfigured(env: Env): boolean {
  return Boolean(env.SMS_API_KEY?.trim());
}

export interface VerifiedAuthOtp {
  phone: string;
  meta: Record<string, unknown> | null;
}

/** Consumes the live code on success (single-use). Throws AppError on any failure. */
export async function verifyAuthOtp(
  env: Env,
  purpose: AuthOtpPurpose,
  phone: string,
  code: string,
): Promise<VerifiedAuthOtp> {
  const row = await env.DB.prepare(
    `SELECT id, code_hash, meta_json, attempts, expires_at FROM auth_otps
     WHERE purpose = ? AND phone = ? ORDER BY created_at DESC LIMIT 1`,
  )
    .bind(purpose, phone)
    .first<{ id: string; code_hash: string; meta_json: string | null; attempts: number; expires_at: string }>();

  if (!row) throw new AppError('OTP_NOT_REQUESTED', 'No OTP is active. Request a new code.', 409);
  if (new Date(row.expires_at).getTime() < Date.now()) {
    throw new AppError('OTP_EXPIRED', 'This code has expired. Request a new one.', 409);
  }
  if (row.attempts >= MAX_ATTEMPTS) {
    throw new AppError('OTP_LOCKED', 'Too many incorrect attempts. Request a new code.', 429);
  }

  const hash = await sha256HexAsync(code);
  if (hash !== row.code_hash) {
    await env.DB.prepare('UPDATE auth_otps SET attempts = attempts + 1 WHERE id = ?').bind(row.id).run();
    throw new AppError('OTP_INVALID', 'Incorrect code. Please check and try again.', 401);
  }

  await env.DB.prepare('DELETE FROM auth_otps WHERE id = ?').bind(row.id).run();
  let meta: Record<string, unknown> | null = null;
  if (row.meta_json) {
    try {
      meta = JSON.parse(row.meta_json) as Record<string, unknown>;
    } catch {
      meta = null;
    }
  }
  return { phone, meta };
}
