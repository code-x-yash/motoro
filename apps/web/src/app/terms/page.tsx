'use client';

import Link from 'next/link';
import { BRAND, DEFAULT_CONFIG, formatMoney } from '@rr/config';
import { AppShell } from '@/components/app-shell';

const SECTIONS: Array<{ title: string; body: string }> = [
  {
    title: 'The service',
    body: `${BRAND.name} connects drivers with independent, verified mechanics for roadside assistance — battery jump-starts, flat tyres, fuel delivery, lockouts, diagnostics, repairs and towing. We dispatch, track and process payment; the repair contract is between you and the attending mechanic.`,
  },
  {
    title: 'Quotes and approval',
    body: 'After diagnosis you receive an itemised quote on your phone. No work begins until you approve it. If you reject the quote, towing to a workshop can be arranged at the quoted towing rate.',
  },
  {
    title: 'Pricing, GST and payment',
    body: 'Prices include a transparent base fee, distance charge, and any night or emergency surcharges shown before you confirm. GST is charged where applicable and shown on your invoice. Pay online by UPI, card, netbanking or wallet, or in cash directly to the mechanic.',
  },
  {
    title: 'Cancellations',
    body: `The first ${DEFAULT_CONFIG.cancellation.freeWindowSeconds} seconds after creating a request are free. After that, if a mechanic has already been dispatched, a cancellation fee of ${formatMoney(DEFAULT_CONFIG.cancellation.feeCents)} applies and will appear on your request for payment.`,
  },
  {
    title: 'Safety and conduct',
    body: 'Mechanics are ID-verified and may refuse unsafe work. You agree to provide accurate location and vehicle information, and to treat mechanics with respect. Job starts are OTP-verified so only you can authorise work on your vehicle.',
  },
  {
    title: 'Warranty and disputes',
    body: 'Repairs carry the mechanic’s workmanship warranty as stated on the quote. If something goes wrong, open a dispute from your request history within 7 days and our operations team will review photos, timeline and payment records.',
  },
  {
    title: 'Liability',
    body: 'To the extent permitted by law, our liability is limited to the amount you paid for the affected request. We do not exclude liability that cannot lawfully be excluded.',
  },
  {
    title: 'Contact',
    body: `Questions about these terms: ${BRAND.supportEmail} or ${BRAND.supportPhone}.`,
  },
];

export default function TermsPage() {
  const year = new Date().getFullYear();
  return (
    <AppShell allowAnonymous>
      <div className="mx-auto max-w-3xl space-y-6">
        <div className="animate-fade-up">
          <span className="section-eyebrow">Legal</span>
          <h1 className="page-title mt-3">Terms of service</h1>
          <p className="page-subtitle">
            Last updated {year} · The agreement between you and {BRAND.name}.
          </p>
        </div>

        {SECTIONS.map((section) => (
          <section key={section.title} className="card-bright animate-fade-up p-5">
            <h2 className="text-base font-semibold text-ink">{section.title}</h2>
            <p className="mt-2 text-sm leading-relaxed text-slate-600">{section.body}</p>
          </section>
        ))}

        <div className="flex items-center justify-between border-t border-slate-200 pt-4 text-sm">
          <Link href="/privacy" className="font-medium text-brand-700 hover:underline">
            Privacy policy
          </Link>
          <Link href="/help" className="font-medium text-brand-700 hover:underline">
            Help center
          </Link>
        </div>
      </div>
    </AppShell>
  );
}
