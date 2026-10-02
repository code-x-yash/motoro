'use client';

import Link from 'next/link';
import { BRAND } from '@rr/config';
import { AppShell } from '@/components/app-shell';

const SECTIONS: Array<{ title: string; body: string[]; bullets?: string[] }> = [
  {
    title: 'What we collect',
    body: [
      `We collect only what we need to run roadside dispatch for ${BRAND.legalName}:`,
    ],
    bullets: [
      'Profile details — your name, email address and mobile number.',
      'Vehicle details — make, model, registration number, fuel type and photos you upload.',
      'Location while a request is active, so a provider can reach you.',
      'Payment reference IDs and invoice details. We never store your card number, CVV or UPI PIN — those are entered only on our payment partner’s interface.',
      'Usage data such as request history, ratings and support conversations.',
    ],
  },
  {
    title: 'How we use your information',
    body: [
      'We use your information to dispatch the nearest provider, show live tracking, generate GST-ready invoices, keep a verifiable history of every job, prevent fraud and abuse, and send you service notifications (SMS, WhatsApp, email or push, according to your preferences).',
      'We also use aggregated, de-identified data to measure response times, improve dispatch and plan coverage — data that no longer identifies you.',
    ],
  },
  {
    title: 'Location data',
    body: [
      'Your location is collected only while you have an open request, and it stops being collected when the request is closed or cancelled.',
      'During that window your live location is shared with the provider assigned to your request and with our operations team, so the job can be tracked and escalated if needed.',
      'We do not build a continuous movement history of your device, and we never sell location data.',
    ],
  },
  {
    title: 'How we share information',
    body: ['We share personal information only with:'],
    bullets: [
      'The mechanic, workshop or towing partner assigned to your active request — name, phone, address, vehicle and location for that job only.',
      'Our operations and support team, who monitor open requests 24×7.',
      'Our payment processor, which handles UPI, card and netbanking transactions under its own regulated controls.',
      'Law enforcement, regulators or courts, when disclosure is required by law or is necessary to protect safety and prevent fraud.',
    ],
  },
  {
    title: 'Data retention',
    body: [
      'Requests, invoices and payment records are kept for tax, accounting and dispute-resolution purposes as required by Indian law. Location trails are deleted when a request closes.',
      'Account data is kept until you close your account. You can request deletion of your account and associated personal data from profile settings or by contacting support.',
    ],
  },
  {
    title: 'Your rights under the DPDP Act 2023',
    body: [
      `Under the Digital Personal Data Protection Act, 2023 you have the right to:`,
    ],
    bullets: [
      'Access the personal data we hold about you.',
      'Correct inaccurate or incomplete data.',
      'Erase your data and withdraw consent, subject to legal retention requirements.',
      'Grievance redressal — raise a complaint with our grievance officer.',
      'Nominate another person to exercise your rights in case of death or incapacity.',
    ],
  },
  {
    title: 'Security measures',
    body: [
      'Data is encrypted in transit with TLS and at rest in access-controlled storage. Access to personal data is limited to staff and providers who need it for a specific job, and every access is logged.',
      'We run role-based access controls, monitor for unusual activity and back up data regularly. If a breach that affects you is reportable, we will notify you and the relevant authority as required by law.',
    ],
  },
  {
    title: 'Cookies and local storage',
    body: [
      'We use a session cookie to keep you signed in and local storage for preferences such as language, notification choices and cached app state.',
      'We do not use third-party advertising trackers or sell your browsing activity.',
    ],
  },
  {
    title: 'Children',
    body: [
      'The platform is intended for adults. We do not knowingly collect personal data from anyone under 18. If you believe a child has provided us with data, contact us and we will delete it.',
    ],
  },
  {
    title: 'Changes to this policy',
    body: [
      'We may update this policy as the service or the law changes. The revised policy will be posted on this page with a new effective date, and for material changes we will notify you in the app or by SMS.',
      'Continued use of the platform after an update takes effect means you accept the revised policy.',
    ],
  },
  {
    title: 'Contact',
    body: [
      `Grievance Officer, ${BRAND.legalName}, registered office at New Delhi, India. Write to us at ${BRAND.supportEmail} or call ${BRAND.supportPhone} — we respond within 30 days.`,
      `Questions about how we handle your data: ${BRAND.supportEmail}.`,
    ],
  },
];

export default function PrivacyPage() {
  return (
    <AppShell allowAnonymous>
      <div className="mx-auto max-w-3xl space-y-6">
        <div className="animate-fade-up">
          <span className="section-eyebrow">Legal</span>
          <h1 className="page-title mt-3">Privacy policy</h1>
          <p className="page-subtitle">
            Effective October 2026 · How {BRAND.name} collects, uses and protects your information.
          </p>
        </div>

        {SECTIONS.map((section) => (
          <section key={section.title} className="card-bright animate-fade-up p-5">
            <h2 className="text-base font-semibold text-ink">{section.title}</h2>
            <div className="mt-2 space-y-2">
              {section.body.map((paragraph) => (
                <p key={paragraph} className="text-sm leading-relaxed text-slate-600">
                  {paragraph}
                </p>
              ))}
              {section.bullets ? (
                <ul className="list-disc space-y-1.5 pl-5 text-sm leading-relaxed text-slate-600">
                  {section.bullets.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
              ) : null}
            </div>
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
