import type { Env } from '../env';
import { logger } from './logger';
import { pushToUser } from './webpush';

/** Queue payload for `notification.dispatch`. */
export interface DeliveryMessage {
  kind: string;
  userId?: string;
  notificationId?: string;
  type: string;
  title: string;
  body: string;
  channels: string[];
  data?: Record<string, unknown> | null;
  /** Explicit SMS recipient (e.g. an emergency contact); falls back to the user's own phone. */
  smsTo?: string;
}

interface DeliveryTarget {
  email: string | null;
  phone: string | null;
}

function emailConfigured(env: Env): boolean {
  return Boolean(env.EMAIL_PROVIDER_KEY?.trim());
}

function smsConfigured(env: Env): boolean {
  return Boolean(env.SMS_API_KEY?.trim());
}

function whatsappConfigured(env: Env): boolean {
  return Boolean(env.WHATSAPP_PROVIDER_KEY?.trim() && env.WHATSAPP_PHONE_ID?.trim());
}

export async function sendEmail(
  env: Env,
  target: { to: string; subject: string; html: string; text: string },
): Promise<void> {
  const key = env.EMAIL_PROVIDER_KEY!.trim();
  const provider = (env.EMAIL_PROVIDER ?? 'resend').toLowerCase();
  const from = env.EMAIL_FROM?.trim() || 'Motoro <onboarding@resend.dev>';

  const endpoint = provider === 'postmark'
    ? 'https://api.postmarkapp.com/email'
    : 'https://api.resend.com/emails';

  const headers: Record<string, string> =
    provider === 'postmark'
      ? { 'x-postmark-server-token': key, 'content-type': 'application/json' }
      : { authorization: `Bearer ${key}`, 'content-type': 'application/json' };

  const payload =
    provider === 'postmark'
      ? { From: from, To: target.to, Subject: target.subject, HtmlBody: target.html, TextBody: target.text }
      : { from, to: [target.to], subject: target.subject, html: target.html, text: target.text };

  const res = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify(payload) });
  if (!res.ok) {
    const detail = (await res.text()).slice(0, 300);
    throw new Error(`email provider responded ${res.status}: ${detail}`);
  }
}

/**
 * SMS dispatch — `SMS_PROVIDER` picks the gateway:
 *  - textbee (default): the sender's own Android phone + SIM, free-form text.
 *  - fast2sms: India OTP route (`route=otp`, fixed "Your OTP: {code}" template,
 *    no DLT registration). Only numeric OTP content is deliverable; free-text
 *    (notifications) is logged and skipped because that route rejects it.
 */
export async function sendSms(
  env: Env,
  target: { to: string; body: string; otp?: string },
): Promise<void> {
  const provider = (env.SMS_PROVIDER || 'textbee').trim().toLowerCase();
  if (provider === 'fast2sms') {
    await sendViaFast2Sms(env, target);
    return;
  }
  await sendViaTextbee(env, target);
}

async function sendViaTextbee(env: Env, target: { to: string; body: string }): Promise<void> {
  const base = (env.SMS_API_URL?.trim() || 'https://api.textbee.dev/api/v1').replace(/\/$/, '');
  const res = await fetch(`${base}/gateway/send-sms`, {
    method: 'POST',
    headers: {
      'x-api-key': env.SMS_API_KEY!.trim(),
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      recipients: [target.to],
      message: target.body,
    }),
  });
  if (!res.ok) {
    const detail = (await res.text()).slice(0, 300);
    throw new Error(`sms provider responded ${res.status}: ${detail}`);
  }
}

/** fast2SMS: POST /dev/bulkV2 (docs.fast2sms.com). Route via SMS_FAST2SMS_ROUTE. */
async function sendViaFast2Sms(
  env: Env,
  target: { to: string; body: string; otp?: string },
): Promise<void> {
  const otp = target.otp?.trim();
  if (!otp || !/^\d{4,10}$/.test(otp)) {
    logger.info('sms', 'fast2sms_free_text_skipped', { to: target.to });
    return;
  }
  const digits = target.to.replace(/\D/g, '');
  const numbers = digits.length === 12 && digits.startsWith('91') ? digits.slice(2) : digits.replace(/^0/, '');
  const route = (env.SMS_FAST2SMS_ROUTE || 'otp').trim().toLowerCase() === 'q' ? 'q' : 'otp';
  const payload =
    route === 'q'
      ? { message: target.body, route: 'q', numbers, flash: '0' }
      : { variables_values: otp, route: 'otp', numbers, flash: '0' };
  const res = await fetch('https://www.fast2sms.com/dev/bulkV2', {
    method: 'POST',
    headers: {
      authorization: env.SMS_API_KEY!.trim(),
      'content-type': 'application/json',
      accept: '*/*',
    },
    body: JSON.stringify(payload),
  });
  const detail = (await res.text()).slice(0, 300);
  if (!res.ok) {
    throw new Error(`sms provider responded ${res.status}: ${detail}`);
  }
  let parsed: { return?: boolean } | null = null;
  try {
    parsed = JSON.parse(detail) as { return?: boolean };
  } catch {
    throw new Error(`sms provider sent a malformed response: ${detail}`);
  }
  if (parsed?.return !== true) {
    throw new Error(`sms provider rejected the send: ${detail}`);
  }
}

export async function sendWhatsApp(env: Env, target: { to: string; body: string }): Promise<void> {
  const phoneId = env.WHATSAPP_PHONE_ID!.trim();
  const endpoint = `https://graph.facebook.com/v20.0/${phoneId}/messages`;
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${env.WHATSAPP_PROVIDER_KEY!.trim()}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to: target.to.replace(/[^\d]/g, ''),
      type: 'text',
      text: { body: target.body },
    }),
  });
  if (!res.ok) {
    const detail = (await res.text()).slice(0, 300);
    throw new Error(`whatsapp provider responded ${res.status}: ${detail}`);
  }
}

function resetEmailHtml(message: DeliveryMessage, resetUrl: string): string {
  return `<!doctype html><html><body style="font-family:Arial,Helvetica,sans-serif;background:#fbfaf7;padding:24px;color:#1c1917">
  <div style="max-width:480px;margin:0 auto;background:#ffffff;border:1px solid #e7e5e4;border-radius:12px;padding:28px">
    <h2 style="margin:0 0 8px;color:#d93809">Motoro</h2>
    <h3 style="margin:0 0 16px">${message.title}</h3>
    <p style="font-size:14px;line-height:1.6;color:#44403c">${message.body}</p>
    <p style="margin:24px 0"><a href="${resetUrl}" style="background:#d93809;color:#fff;padding:12px 20px;border-radius:8px;text-decoration:none;display:inline-block">Reset password</a></p>
    <p style="font-size:12px;color:#78716c">This link expires in 1 hour. If you did not request this, you can safely ignore this email.</p>
  </div></body></html>`;
}

function genericEmailHtml(message: DeliveryMessage): string {
  const actionUrl = typeof message.data?.actionUrl === 'string' ? message.data.actionUrl : null;
  const action =
    actionUrl && message.data?.actionLabel
      ? `<p style="margin:24px 0"><a href="${actionUrl}" style="background:#d93809;color:#fff;padding:12px 20px;border-radius:8px;text-decoration:none;display:inline-block">${String(message.data.actionLabel)}</a></p>`
      : '';
  return `<!doctype html><html><body style="font-family:Arial,Helvetica,sans-serif;background:#fbfaf7;padding:24px;color:#1c1917">
  <div style="max-width:480px;margin:0 auto;background:#ffffff;border:1px solid #e7e5e4;border-radius:12px;padding:28px">
    <h2 style="margin:0 0 8px;color:#d93809">Motoro</h2>
    <h3 style="margin:0 0 16px">${message.title}</h3>
    <p style="font-size:14px;line-height:1.6;color:#44403c">${message.body}</p>
    ${action}
  </div></body></html>`;
}

/**
 * Delivers a queued notification over its requested channels. Providers that
 * are not configured are skipped (in-app already persisted the notification);
 * a configured provider that fails throws so the queue retries.
 */
export async function deliver(env: Env, message: DeliveryMessage): Promise<void> {
  let target: DeliveryTarget = { email: null, phone: null };
  if (message.userId) {
    const row = await env.DB.prepare('SELECT email, phone FROM users WHERE id = ? AND deleted_at IS NULL')
      .bind(message.userId)
      .first<{ email: string; phone: string | null }>();
    target = { email: row?.email ?? null, phone: row?.phone ?? null };
  }

  const failures: string[] = [];

  for (const channel of message.channels) {
    try {
      if (channel === 'EMAIL') {
        if (!emailConfigured(env)) {
          logger.info('delivery', 'email_not_configured', { type: message.type });
          continue;
        }
        if (!target.email) {
          logger.warn('delivery', 'email_target_missing', { type: message.type });
          continue;
        }
        const resetUrl = typeof message.data?.resetUrl === 'string' ? message.data.resetUrl : null;
        await sendEmail(env, {
          to: target.email,
          subject: message.title,
          text: message.body,
          html: resetUrl ? resetEmailHtml(message, resetUrl) : genericEmailHtml(message),
        });
        logger.info('delivery', 'email_sent', { type: message.type, to: target.email });
      } else if (channel === 'SMS') {
        if (!smsConfigured(env)) {
          logger.info('delivery', 'sms_not_configured', { type: message.type });
          continue;
        }
        const to = message.smsTo?.trim() || target.phone;
        if (!to) {
          logger.warn('delivery', 'sms_target_missing', { type: message.type });
          continue;
        }
        await sendSms(env, { to, body: `${message.title}: ${message.body}` });
        logger.info('delivery', 'sms_sent', { type: message.type, to });
      } else if (channel === 'WHATSAPP') {
        if (!whatsappConfigured(env)) {
          logger.info('delivery', 'whatsapp_not_configured', { type: message.type });
          continue;
        }
        if (!target.phone) {
          logger.warn('delivery', 'whatsapp_target_missing', { type: message.type });
          continue;
        }
        await sendWhatsApp(env, { to: target.phone, body: `${message.title}: ${message.body}` });
        logger.info('delivery', 'whatsapp_sent', { type: message.type });
      } else if (channel === 'PUSH') {
        if (!message.userId) continue;
        await pushToUser(env, message.userId, {
          title: message.title,
          body: message.body,
          type: message.type,
          data: message.data ?? null,
        });
        logger.info('delivery', 'push_attempted', { type: message.type });
      }
    } catch (err) {
      logger.error('delivery', 'channel_failed', { channel, type: message.type, error: String(err) });
      failures.push(channel);
    }
  }

  if (failures.length > 0) {
    throw new Error(`delivery failed on channels: ${failures.join(', ')}`);
  }
}
