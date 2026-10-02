'use client';

import Link from 'next/link';
import { BRAND, DEFAULT_CONFIG, formatMoney } from '@rr/config';
import { AppShell } from '@/components/app-shell';

const SECTIONS: Array<{ title: string; body: string[]; bullets?: string[] }> = [
  {
    title: 'Acceptance of these terms',
    body: [
      `These Terms of Service are an agreement between you and ${BRAND.legalName} ("${BRAND.name}", "we", "us" or "our") and govern your use of the ${BRAND.name} website, apps and dispatch platform.`,
      'By creating an account, raising a request or otherwise using the platform, you accept these Terms and our Privacy Policy. If you do not accept them, do not use the service.',
      'These Terms are effective from October 2026 and apply to every request you raise until that request is closed.',
    ],
  },
  {
    title: 'Eligibility and your account',
    body: [
      'You must be at least 18 years old and competent to enter a binding contract under Indian law to use the platform.',
      'Accounts are linked to a mobile number that is verified with a one-time password (OTP) sent by SMS. You are responsible for keeping your password and OTP confidential, and for all activity that happens under your account.',
      'You agree to give accurate registration details and to keep your phone number, vehicles and location permissions up to date so dispatch can reach you.',
    ],
  },
  {
    title: 'The service',
    body: [
      `${BRAND.name} connects drivers with independent, verified mechanics, workshops and towing partners for roadside assistance: battery jump-starts, flat tyres, fuel delivery, lockouts, on-site diagnostics and repair, and towing.`,
      'When you raise a request we dispatch it to nearby providers, show live tracking while a provider is on the way, and process payment. The repair or towing contract is between you and the attending provider; we provide dispatch, tracking and payment infrastructure.',
    ],
  },
  {
    title: 'Quotes, approval and payment',
    body: [
      'After diagnosis you receive an itemised quote on your phone covering parts and labour. No work begins until you approve it. If you reject the quote, towing to a workshop can be arranged at the towing rate shown on the quote.',
      'You can pay online by UPI, card, netbanking or wallet, or in cash directly to the mechanic. GST is charged where applicable and shown on your invoice.',
      'Job start and completion are OTP-verified, so only you can authorise work on your vehicle.',
    ],
  },
  {
    title: 'Pricing, quotes and cancellation',
    body: [
      `Unless a custom quote is shown to you, a request is priced with a base fee of ${formatMoney(DEFAULT_CONFIG.pricing.baseFeeCents)}, a distance fee of ${formatMoney(DEFAULT_CONFIG.pricing.distanceFeePerKmCents)} per kilometre, and any night or emergency surcharge disclosed before you confirm. Final pricing always appears on the quote before any work starts.`,
      `The first ${DEFAULT_CONFIG.cancellation.freeWindowSeconds} seconds after creating a request are free to cancel. After that, if a mechanic has already been dispatched, a cancellation fee of ${formatMoney(DEFAULT_CONFIG.cancellation.feeCents)} applies and will appear on your request for payment.`,
      'If a provider arrives and you decline the work, any call-out or diagnosis charge shown on your quote becomes payable. All amounts are in Indian Rupees.',
    ],
  },
  {
    title: 'Your obligations',
    body: ['You agree to use the service responsibly and to:'],
    bullets: [
      'Provide accurate location, vehicle and contact details for every request.',
      'Be reachable while a request is active and meet the provider at the agreed spot.',
      'Treat providers and our staff with respect. Harassment, abuse or unsafe conduct ends the request.',
      'Use the platform only for lawful purposes and only for a vehicle you own or are authorised to act for.',
      'Avoid arranging payments outside the platform to circumvent fees or quotes.',
    ],
  },
  {
    title: 'Safety and conduct',
    body: [
      'Mechanics are ID-verified and may refuse work they consider unsafe. You agree to provide accurate location and vehicle information and to treat mechanics with respect.',
      'If a provider cannot complete the job safely, we will re-dispatch or arrange towing as described in your request.',
    ],
  },
  {
    title: 'Mechanics and partners',
    body: [
      'Providers on the platform are independent businesses or individuals, not employees or agents of ' + BRAND.legalName + '. Providers are ID-verified and skills-checked before going live, and are rated after each job.',
      'Providers must follow the platform code of conduct: arrive within the stated ETA, quote honestly, protect your vehicle and data, and accept only jobs they can fulfil. Repeated breaches remove a provider from the platform.',
    ],
  },
  {
    title: 'Warranty and disputes',
    body: [
      'Repairs carry the mechanic’s workmanship warranty as stated on the quote. If something goes wrong, open a dispute from your request history within 7 days and our operations team will review photos, the timeline and payment records.',
      'We may mediate between you and a provider and may reverse or adjust a payment where a dispute is upheld.',
    ],
  },
  {
    title: 'Intellectual property',
    body: [
      `The ${BRAND.name} name, logo, design, software, content and data are owned by or licensed to ${BRAND.legalName} and are protected by applicable intellectual property laws.`,
      'We grant you a limited, non-exclusive, non-transferable licence to use the platform for its intended purpose. You may not copy, modify, reverse engineer, scrape or resell any part of the service, or use the platform to build a competing product.',
    ],
  },
  {
    title: 'Disclaimers and limitation of liability',
    body: [
      'The platform is provided on an "as is" and "as available" basis. While we verify providers and monitor every request, we do not guarantee arrival times, repair outcomes or the availability of a provider at any moment.',
      'To the extent permitted by law, our liability is limited to the amount you paid for the affected request. We are not liable for indirect, incidental or consequential loss, loss of profit, or damage arising from delay beyond our control.',
      'Nothing in these Terms excludes or limits liability that cannot lawfully be excluded, including liability for fraud or wilful misconduct.',
    ],
  },
  {
    title: 'Indemnity',
    body: [
      'You agree to indemnify and hold harmless ' + BRAND.legalName + ', its directors, employees and partners against claims, damages and expenses arising from your misuse of the platform, your violation of these Terms, or your violation of any law or third-party right.',
    ],
  },
  {
    title: 'Governing law and jurisdiction',
    body: [
      `These Terms are governed by the laws of India. Any dispute arising out of or relating to these Terms or the platform will be subject to the exclusive jurisdiction of the courts of New Delhi, India.`,
      'Before starting proceedings, please contact us and allow 30 days to resolve the matter amicably.',
    ],
  },
  {
    title: 'Termination',
    body: [
      'You may close your account at any time from profile settings or by contacting support. Requests that are open at the time of closure must be completed or cancelled first.',
      'We may suspend or terminate your account if you breach these Terms, provide false information, abuse providers or staff, or use the platform unlawfully. Where practical we will notify you and refund any prepaid amount for a service not delivered.',
    ],
  },
  {
    title: 'Grievance officer and contact',
    body: [
      `Grievance Officer, ${BRAND.legalName}, registered office at New Delhi, India. Write to the grievance officer at ${BRAND.supportEmail} and we will acknowledge your complaint within 48 hours and resolve it within 30 days, in line with applicable Indian law.`,
      `Questions about these terms: ${BRAND.supportEmail} or ${BRAND.supportPhone}.`,
    ],
  },
  {
    title: 'Changes to these terms',
    body: [
      'We may update these Terms to reflect changes in the service, technology or law. We will post the revised Terms on this page with a new effective date and, for material changes, notify you in the app or by SMS.',
      'Continued use of the platform after an update takes effect means you accept the revised Terms. If you do not accept them, stop using the service and close your account.',
    ],
  },
];

export default function TermsPage() {
  return (
    <AppShell allowAnonymous>
      <div className="mx-auto max-w-3xl space-y-6">
        <div className="animate-fade-up">
          <span className="section-eyebrow">Legal</span>
          <h1 className="page-title mt-3">Terms of service</h1>
          <p className="page-subtitle">
            Effective October 2026 · The agreement between you and {BRAND.legalName}.
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
