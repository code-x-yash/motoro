import type { Env } from '../env';
import { AppError } from './errors';
import { generateOtp, sha256HexAsync } from './crypto';
import { isoIn, nowIso } from './ids';

/** Job start OTP: the customer shares it with the mechanic on arrival. */

const OTP_TTL_MINUTES = 15;
const MAX_ATTEMPTS = 5;

export async function createJobOtp(env: Env, jobId: string): Promise<string> {
  const code = generateOtp();
  const hash = await sha256HexAsync(code);
  await env.DB.prepare(
    `UPDATE jobs SET otp_code_hash = ?, otp_expires_at = ?, otp_attempts = 0, updated_at = ?
     WHERE id = ?`,
  )
    .bind(hash, isoIn(OTP_TTL_MINUTES * 60), nowIso(), jobId)
    .run();
  return code;
}

export async function verifyJobOtp(env: Env, jobId: string, code: string): Promise<boolean> {
  const job = await env.DB.prepare(
    'SELECT otp_code_hash, otp_expires_at, otp_attempts, otp_verified_at FROM jobs WHERE id = ?',
  )
    .bind(jobId)
    .first<{
      otp_code_hash: string | null;
      otp_expires_at: string | null;
      otp_attempts: number;
      otp_verified_at: string | null;
    }>();

  if (!job) throw new AppError('NOT_FOUND', 'Job not found.', 404);
  if (job.otp_verified_at) return true;
  if (!job.otp_code_hash || !job.otp_expires_at) {
    throw new AppError('OTP_NOT_REQUESTED', 'No OTP is active for this job.', 409);
  }
  if (new Date(job.otp_expires_at).getTime() < Date.now()) {
    throw new AppError('OTP_EXPIRED', 'This OTP has expired. Ask the customer for the new code.', 409);
  }
  if (job.otp_attempts >= MAX_ATTEMPTS) {
    throw new AppError('OTP_LOCKED', 'Too many incorrect attempts. Request a new OTP.', 429);
  }

  const hash = await sha256HexAsync(code);
  if (hash !== job.otp_code_hash) {
    await env.DB.prepare('UPDATE jobs SET otp_attempts = otp_attempts + 1, updated_at = ? WHERE id = ?')
      .bind(nowIso(), jobId)
      .run();
    throw new AppError('OTP_INVALID', 'Incorrect OTP. Please check with the customer.', 401);
  }

  await env.DB.prepare(
    'UPDATE jobs SET otp_verified_at = ?, otp_code_hash = NULL, updated_at = ? WHERE id = ?',
  )
    .bind(nowIso(), nowIso(), jobId)
    .run();
  return true;
}
