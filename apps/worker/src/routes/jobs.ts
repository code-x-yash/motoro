import { Hono } from 'hono';
import type { Context } from 'hono';
import { z } from 'zod';
import type { Env } from '../env';
import { ok } from '../lib/response';
import { errors } from '../lib/errors';
import { requireUser, requirePermission, type AuthUser } from '../lib/auth';
import { parseInput } from '../lib/validate';
import {
  createDiagnosisSchema,
  createQuoteSchema,
  decideQuoteSchema,
  jobNoteSchema,
  jobPhotoSchema,
  paginationSchema,
  verifyOtpSchema,
} from '@rr/validation';
import {
  appendLocation,
  getRequest,
  loadRequestDto,
  requireRequest,
  setRequestStatus,
} from '../lib/requests';
import {
  assertJobAccess,
  requireJob,
  transitionJob,
  type JobRowFull,
} from '../lib/jobs';
import { createJobOtp, verifyJobOtp } from '../lib/otp';
import { notify } from '../lib/notify';
import { recordEvent } from '../lib/events';
import { computeQuoteTotals } from '../lib/pricing';
import { computeRequestTotal, ensureInvoice } from '../lib/payment-service';
import { newId, nowIso } from '../lib/ids';
import { audit } from '../lib/audit';
import { distanceKm } from '../lib/geo';
import { recordMechanicLocation } from '../lib/mechanics';
import { reassignRequest } from '../dispatch/service';
import { mapJobRow, mapQuoteRow, type QuoteRow } from '../lib/mappers';
import { broadcast, requestRoom } from '../lib/realtime';

const routes = new Hono<{ Bindings: Env }>();

async function loadJobWithRequest(
  c: Context<{ Bindings: Env }>,
  jobId: string | undefined,
  user: AuthUser,
) {
  if (!jobId) throw errors.validation('Job id is required.');
  const job = await requireJob(c.env, jobId);
  const request = await requireRequest(c.env, job.request_id);
  assertJobAccess(user, job, request);
  return { job, request };
}

/** Job list for the current role. */
routes.get('/', async (c) => {
  const user = await requireUser(c);
  const query = parseInput(paginationSchema, c.req.query());

  let sql = '';
  const binds: Array<string | number> = [];
  if (user.role === 'MECHANIC') {
    sql = `SELECT j.*, u.full_name AS mechanic_name FROM jobs j
           JOIN users u ON u.id = j.mechanic_user_id
           WHERE j.mechanic_user_id = ? AND j.deleted_at IS NULL`;
    binds.push(user.id);
  } else if (user.role === 'DRIVER') {
    sql = `SELECT j.*, u.full_name AS mechanic_name FROM jobs j
           JOIN users u ON u.id = j.mechanic_user_id
           JOIN emergency_requests e ON e.id = j.request_id
           WHERE e.driver_user_id = ? AND j.deleted_at IS NULL`;
    binds.push(user.id);
  } else {
    sql = `SELECT j.*, u.full_name AS mechanic_name FROM jobs j
           JOIN users u ON u.id = j.mechanic_user_id
           WHERE j.deleted_at IS NULL`;
  }

  const countRow = await c.env.DB.prepare(`SELECT COUNT(*) AS c FROM (${sql})`)
    .bind(...binds)
    .first<{ c: number }>();
  sql += ' ORDER BY j.created_at DESC LIMIT ? OFFSET ?';
  binds.push(query.limit ?? 20, query.offset ?? 0);

  const rows = await c.env.DB.prepare(sql).bind(...binds).all<JobRowFull>();
  const items = [];
  for (const row of rows.results) items.push(await mapJobRow(c.env, row));

  return ok({ items, total: countRow?.c ?? items.length, limit: query.limit, offset: query.offset }, c.get('requestId'));
});

/** Job detail (job + request + diagnosis + quote). */
routes.get('/:id', async (c) => {
  const user = await requireUser(c);
  const { job, request } = await loadJobWithRequest(c, c.req.param('id'), user);

  const diagnosis = await c.env.DB.prepare(
    'SELECT * FROM diagnoses WHERE request_id = ? ORDER BY created_at DESC LIMIT 1',
  )
    .bind(request.id)
    .first<{ id: string; request_id: string; mechanic_user_id: string; notes: string; created_at: string }>();
  const diagnosisItems = diagnosis
    ? (
        await c.env.DB.prepare('SELECT * FROM diagnosis_items WHERE diagnosis_id = ? ORDER BY sort')
          .bind(diagnosis.id)
          .all<{ id: string; code: string; label: string; result: string; notes: string | null }>()
      ).results
    : [];

  const quote = await c.env.DB.prepare(
    'SELECT * FROM quotes WHERE request_id = ? ORDER BY created_at DESC LIMIT 1',
  )
    .bind(request.id)
    .first<QuoteRow>();

  return ok(
    {
      job: await mapJobRow(c.env, job),
      request: await loadRequestDto(c.env, request.id, { withTimeline: true }),
      diagnosis: diagnosis
        ? {
            id: diagnosis.id,
            requestId: diagnosis.request_id,
            mechanicUserId: diagnosis.mechanic_user_id,
            notes: diagnosis.notes,
            items: diagnosisItems.map((i) => ({
              id: i.id,
              code: i.code,
              label: i.label,
              result: i.result as 'OK' | 'FAIL' | 'NA' | 'UNCERTAIN',
              notes: i.notes,
            })),
            createdAt: diagnosis.created_at,
          }
        : null,
      quote: quote ? await mapQuoteRow(c.env, quote) : null,
    },
    c.get('requestId'),
  );
});

/** Mechanic starts travelling to the customer. */
routes.post('/:id/en-route', requirePermission('JOB_UPDATE'), async (c) => {
  const user = await requireUser(c);
  const { job, request } = await loadJobWithRequest(c, c.req.param('id'), user);
  if (job.mechanic_user_id !== user.id) throw errors.forbidden('This is not your job.');
  const body = parseInput(jobNoteSchema, await c.req.json().catch(() => ({})));

  const updated = await transitionJob(c.env, job, 'EN_ROUTE', {
    actorUserId: user.id,
    actorRole: 'MECHANIC',
    note: body.note,
    latitude: body.latitude,
    longitude: body.longitude,
    message: 'Mechanic is on the way',
  });
  if (body.latitude !== undefined && body.longitude !== undefined) {
    await appendLocation(c.env, {
      requestId: request.id,
      source: 'MECHANIC',
      actorUserId: user.id,
      latitude: body.latitude,
      longitude: body.longitude,
    });
    await recordMechanicLocation(c.env, user.id, body.latitude, body.longitude);
  }

  await notify(c.env, {
    userId: request.driver_user_id,
    type: 'MECHANIC_EN_ROUTE',
    title: 'Your mechanic is on the way',
    body: 'Follow live progress in the app.',
    data: { requestId: request.id, jobId: job.id },
    channels: ['SMS'],
    requestId: request.id,
  });

  return ok({ job: await mapJobRow(c.env, updated) }, c.get('requestId'));
});

/** Mechanic arrived → customer receives a job-start OTP. */
routes.post('/:id/arrived', requirePermission('JOB_UPDATE'), async (c) => {
  const user = await requireUser(c);
  const { job, request } = await loadJobWithRequest(c, c.req.param('id'), user);
  if (job.mechanic_user_id !== user.id) throw errors.forbidden('This is not your job.');
  const body = parseInput(jobNoteSchema, await c.req.json().catch(() => ({})));

  const updated = await transitionJob(c.env, job, 'ARRIVED', {
    actorUserId: user.id,
    actorRole: 'MECHANIC',
    note: body.note,
    latitude: body.latitude,
    longitude: body.longitude,
    message: 'Mechanic has arrived at your location',
  });

  const otp = await createJobOtp(c.env, job.id);

  await notify(c.env, {
    userId: request.driver_user_id,
    type: 'MECHANIC_ARRIVED',
    title: 'Your mechanic has arrived',
    body: `Share this OTP with your mechanic to start the job: ${otp}`,
    data: { requestId: request.id, jobId: job.id, otp },
    channels: ['SMS'],
    requestId: request.id,
  });

  await audit(c.env, {
    actorUserId: user.id,
    actorRole: 'MECHANIC',
    action: 'JOB_ARRIVED',
    entityType: 'job',
    entityId: job.id,
    requestId: c.get('requestId'),
  });

  return ok({ job: await mapJobRow(c.env, updated), otpSent: true }, c.get('requestId'));
});

/** Mechanic submits the customer OTP → job verified, repair may start. */
routes.post('/:id/verify', requirePermission('JOB_UPDATE'), async (c) => {
  const user = await requireUser(c);
  const { job } = await loadJobWithRequest(c, c.req.param('id'), user);
  if (job.mechanic_user_id !== user.id) throw errors.forbidden('This is not your job.');
  const input = parseInput(verifyOtpSchema, await c.req.json().catch(() => ({})));

  await verifyJobOtp(c.env, job.id, input.otp);
  const updated = await transitionJob(c.env, job, 'VERIFIED', {
    actorUserId: user.id,
    actorRole: 'MECHANIC',
    message: 'Arrival verified with customer OTP',
    extra: { otp_verified_at: nowIso() },
  });

  await audit(c.env, {
    actorUserId: user.id,
    actorRole: 'MECHANIC',
    action: 'JOB_OTP_VERIFIED',
    entityType: 'job',
    entityId: job.id,
    requestId: c.get('requestId'),
  });

  return ok({ job: await mapJobRow(c.env, updated) }, c.get('requestId'));
});

/** Mechanic live location during travel (drives stall detection + ETA). */
routes.post('/:id/location', requirePermission('JOB_UPDATE'), async (c) => {
  const user = await requireUser(c);
  const { job, request } = await loadJobWithRequest(c, c.req.param('id'), user);
  if (job.mechanic_user_id !== user.id) throw errors.forbidden('This is not your job.');
  const input = parseInput(
    jobNoteSchema.extend({
      latitude: z.number().min(-90).max(90),
      longitude: z.number().min(-180).max(180),
    }),
    await c.req.json().catch(() => ({})),
  );

  await recordMechanicLocation(c.env, user.id, input.latitude, input.longitude);
  await appendLocation(c.env, {
    requestId: request.id,
    source: 'MECHANIC',
    actorUserId: user.id,
    latitude: input.latitude,
    longitude: input.longitude,
    accuracy: null,
  });

  // Auto-transition EN_ROUTE -> MECHANIC_NEARBY when within 1.5 km.
  const dist = distanceKm(request.latitude, request.longitude, input.latitude, input.longitude);
  if (request.status === 'MECHANIC_EN_ROUTE' && dist <= 1.5) {
    try {
      await setRequestStatus(c.env, request, 'MECHANIC_NEARBY', {
        actorRole: 'MECHANIC',
        actorUserId: user.id,
        message: 'Your mechanic is nearby',
        data: { distanceKm: Math.round(dist * 10) / 10 },
      });
    } catch {
      /* state machine may not allow it; location still recorded */
    }
  }

  return ok({ accepted: true, distanceKm: Math.round(dist * 100) / 100 }, c.get('requestId'));
});

/** Structured diagnosis (checklist + free text). */
routes.post('/:id/diagnosis', requirePermission('DIAGNOSIS_CREATE'), async (c) => {
  const user = await requireUser(c);
  const { job, request } = await loadJobWithRequest(c, c.req.param('id'), user);
  if (job.mechanic_user_id !== user.id) throw errors.forbidden('This is not your job.');
  const input = parseInput(createDiagnosisSchema, await c.req.json().catch(() => ({})));

  if (!['ARRIVED', 'VERIFIED', 'DIAGNOSING'].includes(job.status)) {
    throw errors.conflict('DIAGNOSIS_NOT_ALLOWED', 'Verify arrival before recording a diagnosis.');
  }

  const diagnosisId = newId();
  await c.env.DB.batch([
    c.env.DB.prepare('DELETE FROM diagnosis_items WHERE diagnosis_id IN (SELECT id FROM diagnoses WHERE request_id = ?)')
      .bind(request.id),
    c.env.DB.prepare('DELETE FROM diagnoses WHERE request_id = ?').bind(request.id),
    c.env.DB.prepare(
      `INSERT INTO diagnoses (id, request_id, mechanic_user_id, notes, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).bind(diagnosisId, request.id, user.id, input.notes, nowIso(), nowIso()),
    ...input.items.map((item, index) =>
      c.env.DB.prepare(
        `INSERT INTO diagnosis_items (id, diagnosis_id, code, label, result, notes, sort, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(newId(), diagnosisId, item.code, item.label, item.result, item.notes ?? null, index, nowIso()),
    ),
  ]);

  if (job.status !== 'DIAGNOSING') {
    await transitionJob(c.env, job, 'DIAGNOSING', {
      actorUserId: user.id,
      actorRole: 'MECHANIC',
      message: 'Diagnosis in progress',
      note: input.notes.slice(0, 200),
    });
  } else {
    await recordEvent(c.env, {
      requestId: request.id,
      type: 'DIAGNOSIS_UPDATED',
      message: 'Diagnosis updated',
      actorRole: 'MECHANIC',
      actorUserId: user.id,
    });
  }

  await notify(c.env, {
    userId: request.driver_user_id,
    type: 'DIAGNOSIS_READY',
    title: 'Diagnosis ready',
    body: 'Your mechanic has completed the diagnosis.',
    data: { requestId: request.id, jobId: job.id },
    requestId: request.id,
  });

  return ok({ diagnosisId, items: input.items.length }, c.get('requestId'));
});

/** Mechanic creates a quote (parts + labour + fees) for customer approval. */
routes.post('/:id/quote', requirePermission('QUOTE_CREATE'), async (c) => {
  const user = await requireUser(c);
  const { job, request } = await loadJobWithRequest(c, c.req.param('id'), user);
  if (job.mechanic_user_id !== user.id) throw errors.forbidden('This is not your job.');
  const input = parseInput(createQuoteSchema, await c.req.json().catch(() => ({})));

  if (!['DIAGNOSING', 'QUOTE_PENDING', 'ARRIVED', 'VERIFIED'].includes(job.status)) {
    throw errors.conflict(
      'QUOTE_NOT_ALLOWED',
      'Complete the diagnosis before sending a quote.',
    );
  }

  const diagnosis = await c.env.DB.prepare(
    'SELECT id FROM diagnoses WHERE request_id = ? ORDER BY created_at DESC LIMIT 1',
  )
    .bind(request.id)
    .first<{ id: string }>();

  const totals = computeQuoteTotals(input.items, input.taxPercent);
  const quoteId = newId();
  const now = nowIso();

  await c.env.DB.batch([
    c.env.DB.prepare('DELETE FROM quote_items WHERE quote_id IN (SELECT id FROM quotes WHERE request_id = ? AND status IN (\'DRAFT\',\'PENDING\',\'REJECTED\'))')
      .bind(request.id),
    c.env.DB.prepare(
      `INSERT INTO quotes (id, request_id, job_id, diagnosis_id, status, subtotal_cents, tax_cents,
                           fees_cents, discount_cents, total_cents, tax_percent, notes, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'PENDING', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        quoteId,
        request.id,
        job.id,
        diagnosis?.id ?? null,
        totals.subtotalCents,
        totals.taxCents,
        totals.feesCents,
        totals.discountCents,
        totals.totalCents,
        input.taxPercent,
        input.notes ?? null,
        user.id,
        now,
        now,
      ),
    ...input.items.map((item, index) => {
      const lineTotal = Math.round(item.quantity * item.unitPriceCents);
      return c.env.DB.prepare(
        `INSERT INTO quote_items (id, quote_id, type, description, quantity, unit_price_cents, total_cents, part_id, sort, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        newId(),
        quoteId,
        item.type,
        item.description,
        item.quantity,
        item.unitPriceCents,
        lineTotal,
        item.partId ?? null,
        index,
        now,
      );
    }),
  ]);

  const quoteRow = await c.env.DB.prepare('SELECT * FROM quotes WHERE id = ?')
    .bind(quoteId)
    .first<QuoteRow>();

  if (['ARRIVED', 'VERIFIED', 'DIAGNOSING'].includes(job.status)) {
    await transitionJob(c.env, job, 'QUOTE_PENDING', {
      actorUserId: user.id,
      actorRole: 'MECHANIC',
      message: 'Quote sent for approval',
      skipRequestUpdate: false,
    });
  }

  await notify(c.env, {
    userId: request.driver_user_id,
    type: 'QUOTE_CREATED',
    title: 'Quote ready for approval',
    body: `Your mechanic sent a quote of ₹${Math.round(totals.totalCents / 100)}. Review and approve to start the repair.`,
    data: { requestId: request.id, jobId: job.id, quoteId, totalCents: totals.totalCents },
    requestId: request.id,
  });

  await broadcast(c.env, requestRoom(request.id), {
    type: 'quote.updated',
    requestId: request.id,
    payload: {
      quoteId,
      jobId: job.id,
      action: 'created',
      status: 'PENDING',
      totalCents: totals.totalCents,
    },
  });

  return ok({ quote: quoteRow ? await mapQuoteRow(c.env, quoteRow) : null }, c.get('requestId'), 201);
});

/** Driver approves / rejects the quote. */
async function decideQuoteHandler(c: Context<{ Bindings: Env }>, decision: 'APPROVED' | 'REJECTED') {
  const user = await requireUser(c);
  const body = (await c.req.json().catch(() => ({}))) as { reason?: string };
  const input = parseInput(decideQuoteSchema, { decision, reason: body.reason });
  const { job, request } = await loadJobWithRequest(c, c.req.param('id'), user);
  if (request.driver_user_id !== user.id && user.role !== 'ADMIN') {
    throw errors.forbidden('Only the requesting driver can decide on a quote.');
  }

  const quote = await c.env.DB.prepare(
    `SELECT * FROM quotes WHERE request_id = ? AND status = 'PENDING' ORDER BY created_at DESC LIMIT 1`,
  )
    .bind(request.id)
    .first<QuoteRow>();
  if (!quote) throw errors.conflict('NO_PENDING_QUOTE', 'There is no quote waiting for your decision.');

  const now = nowIso();
  await c.env.DB.prepare(
    'UPDATE quotes SET status = ?, decided_by = ?, decided_at = ?, decide_reason = ?, updated_at = ? WHERE id = ?',
  )
    .bind(decision, user.id, now, input.reason ?? null, now, quote.id)
    .run();

  if (decision === 'APPROVED') {
    await transitionJob(c.env, job, 'QUOTE_APPROVED', {
      actorUserId: user.id,
      actorRole: 'DRIVER',
      message: 'Quote approved — starting repair',
    });
    await notify(c.env, {
      userId: job.mechanic_user_id,
      type: 'QUOTE_APPROVED',
      title: 'Quote approved',
      body: 'The customer approved your quote. You can start the repair.',
      data: { requestId: request.id, jobId: job.id, quoteId: quote.id },
      requestId: request.id,
    });
  } else {
    await transitionJob(c.env, job, 'DIAGNOSING', {
      actorUserId: user.id,
      actorRole: 'DRIVER',
      message: 'Quote rejected — discussing next steps',
      note: input.reason,
    });
    await notify(c.env, {
      userId: job.mechanic_user_id,
      type: 'QUOTE_REJECTED',
      title: 'Quote rejected',
      body: input.reason ? `Reason: ${input.reason}` : 'The customer rejected your quote.',
      data: { requestId: request.id, jobId: job.id, quoteId: quote.id },
      requestId: request.id,
    });
  }

  await audit(c.env, {
    actorUserId: user.id,
    actorRole: user.role,
    action: `QUOTE_${decision}`,
    entityType: 'quote',
    entityId: quote.id,
    data: { requestId: request.id },
    requestId: c.get('requestId'),
  });

  await broadcast(c.env, requestRoom(request.id), {
    type: 'quote.updated',
    requestId: request.id,
    payload: {
      quoteId: quote.id,
      jobId: job.id,
      action: 'decided',
      status: decision,
      totalCents: quote.total_cents,
    },
  });

  const quoteRow = await c.env.DB.prepare('SELECT * FROM quotes WHERE id = ?')
    .bind(quote.id)
    .first<QuoteRow>();
  return ok({ quote: quoteRow ? await mapQuoteRow(c.env, quoteRow) : null }, c.get('requestId'));
}

routes.post('/:id/quote/approve', requirePermission('QUOTE_DECIDE'), async (c) =>
  decideQuoteHandler(c as never, 'APPROVED'),
);
routes.post('/:id/quote/reject', requirePermission('QUOTE_DECIDE'), async (c) =>
  decideQuoteHandler(c as never, 'REJECTED'),
);

/** Mechanic starts the repair (only after customer approval). */
routes.post('/:id/start', requirePermission('JOB_UPDATE'), async (c) => {
  const user = await requireUser(c);
  const { job, request } = await loadJobWithRequest(c, c.req.param('id'), user);
  if (job.mechanic_user_id !== user.id) throw errors.forbidden('This is not your job.');

  const approved = await c.env.DB.prepare(
    `SELECT id FROM quotes WHERE request_id = ? AND status = 'APPROVED' LIMIT 1`,
  )
    .bind(request.id)
    .first<{ id: string }>();
  if (!approved) {
    throw errors.conflict('QUOTE_REQUIRED', 'The customer must approve a quote before repair starts.');
  }

  const updated = await transitionJob(c.env, job, 'REPAIRING', {
    actorUserId: user.id,
    actorRole: 'MECHANIC',
    message: 'Repair in progress',
  });
  return ok({ job: await mapJobRow(c.env, updated) }, c.get('requestId'));
});

/** Mechanic completes the job → invoice + report + payment pending. */
routes.post('/:id/complete', requirePermission('JOB_UPDATE'), async (c) => {
  const user = await requireUser(c);
  const { job, request } = await loadJobWithRequest(c, c.req.param('id'), user);
  if (job.mechanic_user_id !== user.id) throw errors.forbidden('This is not your job.');

  const total = await computeRequestTotal(c.env, request);
  await c.env.DB.prepare(
    'UPDATE emergency_requests SET total_amount_cents = ?, completed_at = ?, updated_at = ? WHERE id = ?',
  )
    .bind(total, nowIso(), nowIso(), request.id)
    .run();

  const updated = await transitionJob(c.env, job, 'COMPLETED', {
    actorUserId: user.id,
    actorRole: 'MECHANIC',
    message: 'Service completed',
  });

  await c.env.DB.prepare(
    'UPDATE mechanics SET jobs_completed = jobs_completed + 1, updated_at = ? WHERE user_id = ?',
  )
    .bind(nowIso(), job.mechanic_user_id)
    .run();

  // Service report (structured; PDF generation can be added later).
  const quote = await c.env.DB.prepare(
    `SELECT * FROM quotes WHERE request_id = ? AND status = 'APPROVED' ORDER BY decided_at DESC LIMIT 1`,
  )
    .bind(request.id)
    .first<QuoteRow>();
  const photos = await c.env.DB.prepare(
    'SELECT stage, object_key FROM job_photos WHERE request_id = ? ORDER BY created_at',
  )
    .bind(request.id)
    .all<{ stage: string; object_key: string }>();

  await c.env.DB.prepare(
    `INSERT INTO service_reports (id, request_id, job_id, summary_json, generated_at)
     VALUES (?, ?, ?, ?, ?)`,
  )
    .bind(
      newId(),
      request.id,
      job.id,
      JSON.stringify({
        reference: request.reference,
        issueType: request.issue_type,
        description: request.description,
        diagnosis: await c.env.DB.prepare('SELECT notes FROM diagnoses WHERE request_id = ? ORDER BY created_at DESC LIMIT 1')
          .bind(request.id)
          .first()
          .then((r) => (r as { notes?: string } | null)?.notes ?? null),
        quote: quote
          ? {
              totalCents: quote.total_cents,
              subtotalCents: quote.subtotal_cents,
              taxCents: quote.tax_cents,
            }
          : null,
        totalCents: total,
        mechanic: job.mechanic_name,
        vehicleRegistration: request.vehicle_registration ?? null,
        photos: photos.results.map((p) => ({ stage: p.stage, key: p.object_key })),
        completedAt: nowIso(),
      }),
      nowIso(),
    )
    .run();

  await ensureInvoice(c.env, request, total);

  const fresh = await getRequest(c.env, request.id);
  if (fresh && fresh.status === 'COMPLETED') {
    await setRequestStatus(c.env, fresh, 'PAYMENT_PENDING', {
      actorRole: 'SYSTEM',
      message: 'Payment pending',
      extra: { payment_status: 'PENDING', total_amount_cents: total },
    });
  }

  await notify(c.env, {
    userId: request.driver_user_id,
    type: 'REPAIR_COMPLETED',
    title: 'Repair completed',
    body: `Your vehicle is ready. Amount payable: ₹${Math.round(total / 100)}.`,
    data: { requestId: request.id, jobId: job.id, totalCents: total },
    channels: ['SMS'],
    requestId: request.id,
  });

  await audit(c.env, {
    actorUserId: user.id,
    actorRole: 'MECHANIC',
    action: 'JOB_COMPLETED',
    entityType: 'job',
    entityId: job.id,
    data: { totalCents: total },
    requestId: c.get('requestId'),
  });

  return ok(
    { job: await mapJobRow(c.env, updated), totalCents: total },
    c.get('requestId'),
  );
});

/** Upload before/diagnosis/after photos (metadata only — files live in R2). */
routes.post('/:id/photos', requirePermission('UPLOAD'), async (c) => {
  const user = await requireUser(c);
  const { job, request } = await loadJobWithRequest(c, c.req.param('id'), user);
  if (job.mechanic_user_id !== user.id && request.driver_user_id !== user.id && user.role !== 'ADMIN' && user.role !== 'OPERATIONS') {
    throw errors.forbidden('You cannot add photos to this job.');
  }
  const input = parseInput(jobPhotoSchema, await c.req.json().catch(() => ({})));

  const id = newId();
  await c.env.DB.prepare(
    `INSERT INTO job_photos (id, job_id, request_id, stage, object_key, caption, uploaded_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(id, job.id, request.id, input.stage, input.objectKey, input.caption ?? null, user.id, nowIso())
    .run();

  await recordEvent(c.env, {
    requestId: request.id,
    type: 'PHOTO_ADDED',
    message: `${input.stage.toLowerCase()} photo uploaded`,
    actorRole: user.role,
    actorUserId: user.id,
    data: { stage: input.stage },
  });

  return ok({ photo: { id, ...input } }, c.get('requestId'), 201);
});

/** Digital roadside assistance report. */
routes.get('/:id/report', async (c) => {
  const user = await requireUser(c);
  const { job, request } = await loadJobWithRequest(c, c.req.param('id'), user);
  const row = await c.env.DB.prepare(
    'SELECT * FROM service_reports WHERE request_id = ? ORDER BY generated_at DESC LIMIT 1',
  )
    .bind(request.id)
    .first<{ summary_json: string; generated_at: string }>();
  if (!row) {
    throw errors.notFound('Service report is generated after the job completes.');
  }
  return ok(
    {
      report: {
        requestId: request.id,
        reference: request.reference,
        generatedAt: row.generated_at,
        summary: JSON.parse(row.summary_json) as Record<string, unknown>,
        driverName: request.driver_name,
        mechanicName: job.mechanic_name,
      },
    },
    c.get('requestId'),
  );
});

/** Mechanic cannot continue → automatic reassignment (never stranded). */
routes.post('/:id/cancel', requirePermission('JOB_UPDATE'), async (c) => {
  const user = await requireUser(c);
  const { job, request } = await loadJobWithRequest(c, c.req.param('id'), user);
  if (job.mechanic_user_id !== user.id && user.role !== 'OPERATIONS' && user.role !== 'ADMIN') {
    throw errors.forbidden('You cannot cancel this job.');
  }
  const body = (await c.req.json().catch(() => ({}))) as { reason?: string };
  const reason = body.reason?.slice(0, 200) ?? 'MECHANIC_CANCELLED';

  const result = await reassignRequest(c.env, request.id, {
    actorRole: user.role,
    actorUserId: user.id,
    reason,
  });

  await audit(c.env, {
    actorUserId: user.id,
    actorRole: user.role,
    action: 'JOB_CANCELLED_REASSIGNED',
    entityType: 'job',
    entityId: job.id,
    data: { reason },
    requestId: c.get('requestId'),
  });

  return ok({ reassigned: result.reassigned }, c.get('requestId'));
});

export default routes;
