'use client';

import Link from 'next/link';
import { BRAND } from '@rr/config';
import { AppShell } from '@/components/app-shell';

const SECTIONS: Array<{ title: string; body: string }> = [
  {
    title: 'What we collect',
    body: 'Your name, phone number, email, vehicles, and — while a request is active — your live location so a mechanic can reach you. Mechanics share their location and job details while they are on duty. Payment card numbers never touch our servers; card and UPI payments are processed by our payment partner.',
  },
  {
    title: 'Why we collect it',
    body: 'To dispatch the nearest mechanic, show you live tracking, generate GST invoices, keep a verifiable history of every job, and send you service notifications (SMS, WhatsApp, email or push, depending on your preferences).',
  },
  {
    title: 'Who can see it',
    body: 'Your location is shared only with the mechanic assigned to your active request, and with our operations team while the request is open. Emergency contacts you explicitly share with receive only a tracking link. We never sell your personal data.',
  },
  {
    title: 'How long we keep it',
    body: 'Requests, invoices and payment records are kept for tax and dispute-resolution purposes. Location trails are deleted when a request closes. You can request deletion of your account and associated personal data from profile settings or by contacting support.',
  },
  {
    title: 'Cookies and storage',
    body: 'We use a session cookie to keep you signed in and local storage for preferences such as language. There are no third-party advertising trackers.',
  },
  {
    title: 'Your rights',
    body: 'You can access, correct, export or delete your personal data, and opt out of non-essential notifications at any time. Write to us at ' + BRAND.supportEmail + ' and we respond within 30 days.',
  },
];

export default function PrivacyPage() {
  const year = new Date().getFullYear();
  return (
    <AppShell allowAnonymous>
      <div className="mx-auto max-w-3xl space-y-6">
        <div className="animate-fade-up">
          <span className="section-eyebrow">Legal</span>
          <h1 className="page-title mt-3">Privacy policy</h1>
          <p className="page-subtitle">
            Last updated {year} · How {BRAND.name} collects, uses and protects your information.
          </p>
        </div>

        {SECTIONS.map((section) => (
          <section key={section.title} className="card-bright animate-fade-up p-5">
            <h2 className="text-base font-semibold text-ink">{section.title}</h2>
            <p className="mt-2 text-sm leading-relaxed text-slate-600">{section.body}</p>
          </section>
        ))}

        <div className="flex items-center justify-between border-t border-slate-200 pt-4 text-sm">
          <Link href="/terms" className="font-medium text-brand-700 hover:underline">
            Terms of service
          </Link>
          <Link href="/help" className="font-medium text-brand-700 hover:underline">
            Help center
          </Link>
        </div>
      </div>
    </AppShell>
  );
}
