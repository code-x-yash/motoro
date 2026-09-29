import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import type { Env } from '../env';
import { nowIso } from './ids';
import { logger } from './logger';

interface InvoicePdfRow {
  id: string;
  number: string;
  request_id: string;
  subtotal_cents: number;
  tax_cents: number;
  discount_cents?: number;
  total_cents: number;
  status: string;
  pdf_key: string | null;
  created_at: string;
}

interface InvoiceLine {
  description: string;
  quantity: number;
  unitPriceCents: number;
  totalCents: number;
}

const BRAND = rgb(0.851, 0.22, 0.035);
const INK = rgb(0.11, 0.1, 0.09);
const MUTED = rgb(0.47, 0.44, 0.42);
const LINE = rgb(0.9, 0.88, 0.87);

function inr(cents: number): string {
  return `INR ${(cents / 100).toLocaleString('en-IN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

/**
 * Lazily generates the invoice PDF on first view and stores it in R2.
 * Returns the row with `pdf_key` set (or the original row on failure).
 */
export async function ensureInvoicePdf(env: Env, invoice: InvoicePdfRow): Promise<InvoicePdfRow> {
  if (invoice.pdf_key) {
    // Seeded/demo keys may point at objects that were never uploaded — regenerate if missing.
    const head = await env.FILES.head(invoice.pdf_key).catch(() => null);
    if (head) return invoice;
  }

  try {
    const request = await env.DB.prepare(
      `SELECT r.reference, r.issue_type, r.address, r.created_at, r.coupon_code, u.full_name
       FROM emergency_requests r JOIN users u ON u.id = r.driver_user_id
       WHERE r.id = ?`,
    )
      .bind(invoice.request_id)
      .first<{
        reference: string;
        issue_type: string;
        address: string | null;
        created_at: string;
        coupon_code: string | null;
        full_name: string;
      }>();

    const quote = await env.DB.prepare(
      `SELECT id, subtotal_cents, discount_cents, tax_cents, tax_percent FROM quotes
       WHERE request_id = ? AND status = 'APPROVED' ORDER BY decided_at DESC LIMIT 1`,
    )
      .bind(invoice.request_id)
      .first<{
        id: string;
        subtotal_cents: number;
        discount_cents: number;
        tax_cents: number;
        tax_percent: number;
      }>();

    const lines: InvoiceLine[] = [];
    let quoteTotalCents = 0;
    if (quote) {
      const items = await env.DB.prepare(
        `SELECT description, quantity, unit_price_cents, total_cents FROM quote_items
         WHERE quote_id = ? ORDER BY sort, created_at`,
      )
        .bind(quote.id)
        .all<{ description: string; quantity: number; unit_price_cents: number; total_cents: number }>();
      for (const item of items.results) {
        lines.push({
          description: item.description,
          quantity: item.quantity,
          unitPriceCents: item.unit_price_cents,
          totalCents: item.total_cents,
        });
      }
      quoteTotalCents =
        Math.max(0, quote.subtotal_cents - quote.discount_cents) + quote.tax_cents;
    }
    const discountCents = invoice.discount_cents ?? 0;
    const serviceFeeCents = Math.max(0, invoice.total_cents + discountCents - quoteTotalCents);
    if (serviceFeeCents > 0) {
      lines.push({ description: 'Roadside service fee', quantity: 1, unitPriceCents: serviceFeeCents, totalCents: serviceFeeCents });
    }

    const doc = await PDFDocument.create();
    doc.setTitle(`Motoro invoice ${invoice.number}`);
    doc.setCreator('Motoro');
    const page = doc.addPage([595, 842]); // A4
    const bold = await doc.embedFont(StandardFonts.HelveticaBold);
    const regular = await doc.embedFont(StandardFonts.Helvetica);
    const { height } = page.getSize();
    const margin = 48;
    const right = 595 - margin;
    let y = height - margin;

    const text = (value: string, x: number, top: number, size: number, font = regular, color = INK) =>
      page.drawText(value, { x, y: height - top, size, font, color });

    // Header
    text('Motoro', margin, y, 26, bold, BRAND);
    text('TAX INVOICE', right - 90, y, 14, bold, INK);
    y += 22;
    text(invoice.status === 'PAID' ? 'Status: PAID' : `Status: ${invoice.status}`, right - 90, y, 10, regular, MUTED);
    y += 16;
    text(`Invoice no. ${invoice.number}`, right - 150, y, 10, regular, MUTED);
    y += 14;
    text(`Issued ${invoice.created_at.slice(0, 10)}`, right - 140, y, 10, regular, MUTED);
    page.drawLine({ start: { x: margin, y: height - (y + 8) }, end: { x: right, y: height - (y + 8) }, thickness: 1, color: LINE });
    y += 34;

    // Billed to
    text('Billed to', margin, y, 9, bold, MUTED);
    y += 15;
    text((request?.full_name ?? 'Customer').slice(0, 48), margin, y, 12, bold, INK);
    y += 15;
    text(`Request ${request?.reference ?? invoice.request_id.slice(0, 8)}`, margin, y, 10, regular, MUTED);
    y += 14;
    if (request?.address) {
      text(request.address.slice(0, 70), margin, y, 10, regular, MUTED);
      y += 14;
    }
    if (request?.issue_type) {
      text(`Issue: ${request.issue_type}`, margin, y, 10, regular, MUTED);
      y += 14;
    }
    y += 10;

    // Table header
    const col = { desc: margin, qty: 340, rate: 400, amount: 500 };
    text('Description', col.desc, y, 9, bold, MUTED);
    text('Qty', col.qty, y, 9, bold, MUTED);
    text('Rate', col.rate, y, 9, bold, MUTED);
    text('Amount', col.amount - 30, y, 9, bold, MUTED);
    y += 8;
    page.drawLine({ start: { x: margin, y: height - y }, end: { x: right, y: height - y }, thickness: 0.8, color: LINE });
    y += 16;

    for (const line of lines) {
      if (y > 700) break; // guard: keep to one page for MVP-sized quotes
      text(line.description.slice(0, 44), col.desc, y, 10, regular, INK);
      text(String(line.quantity), col.qty, y, 10, regular, INK);
      text(inr(line.unitPriceCents), col.rate, y, 10, regular, INK);
      text(inr(line.totalCents), col.amount - 30, y, 10, regular, INK);
      y += 16;
    }

    page.drawLine({ start: { x: margin, y: height - y }, end: { x: right, y: height - y }, thickness: 0.8, color: LINE });
    y += 22;

    // Totals
    const totalsX = 400;
    const totalRow = (label: string, value: string, boldRow = false) => {
      text(label, totalsX, y, 10, boldRow ? bold : regular, boldRow ? INK : MUTED);
      text(value, 500, y, 10, boldRow ? bold : regular, INK);
      y += boldRow ? 20 : 15;
    };
    totalRow('Subtotal', inr(invoice.subtotal_cents));
    totalRow(
      `GST (${quote?.tax_percent ?? 18}%)`,
      inr(invoice.tax_cents),
    );
    if (discountCents > 0) {
      totalRow(
        `Discount${request?.coupon_code ? ` (${request.coupon_code})` : ''}`,
        `-${inr(discountCents)}`,
      );
    }
    page.drawLine({
      start: { x: totalsX, y: height - (y - 10) },
      end: { x: right, y: height - (y - 10) },
      thickness: 0.8,
      color: LINE,
    });
    totalRow('Total', inr(invoice.total_cents), true);

    y += 18;
    text('Payments accepted: UPI, card, netbanking, wallet or cash to the mechanic.', margin, y, 9, regular, MUTED);
    y += 14;
    text('Computer-generated invoice. GSTIN to be added by the platform operator.', margin, y, 9, regular, MUTED);
    y += 14;
    text(`Generated ${nowIso().slice(0, 19).replace('T', ' ')} UTC`, margin, y, 8, regular, MUTED);

    const bytes = await doc.save();
    const key = `invoices/${invoice.id}.pdf`;
    await env.FILES.put(key, bytes, {
      httpMetadata: { contentType: 'application/pdf' },
    });
    await env.DB.prepare('UPDATE invoices SET pdf_key = ? WHERE id = ?').bind(key, invoice.id).run();
    return { ...invoice, pdf_key: key };
  } catch (err) {
    logger.error(invoice.request_id, 'invoice_pdf_failed', { error: String(err) });
    return invoice;
  }
}
