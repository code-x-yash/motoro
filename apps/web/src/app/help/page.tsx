'use client';

import Link from 'next/link';
import { BRAND } from '@rr/config';
import {
  ArrowRight,
  BadgeCheck,
  ChevronDown,
  Clock3,
  CreditCard,
  Mail,
  Navigation,
  Phone,
  Radio,
  ShieldCheck,
  Siren,
  Star,
  Wrench,
} from 'lucide-react';
import { AppShell } from '@/components/app-shell';
import { useAuth } from '@/lib/auth';

interface FaqItem {
  q: string;
  a: string;
}

interface FaqGroup {
  title: string;
  blurb: string;
  icon: typeof Siren;
  items: FaqItem[];
}

const FAQ_GROUPS: FaqGroup[] = [
  {
    title: 'Roadside help',
    blurb: 'Getting help started, what we cover, and what to do first.',
    icon: Siren,
    items: [
      {
        q: 'How fast can someone reach me?',
        a: 'Requests are broadcast to nearby verified mechanics the moment you send them — most jobs are accepted in under a few minutes, with a live ETA on your screen. Our operations team watches every open request 24×7, day or night.',
      },
      {
        q: 'What problems do you cover?',
        a: 'Battery jump-start, flat tyre, running out of fuel, key lockout, on-site diagnostics and repair for engine, electrical or overheating issues, plus accident towing to a workshop you choose.',
      },
      {
        q: 'What should I do while I wait?',
        a: 'Get yourself and your passengers to a safe spot, switch on your hazard lights, and share your exact location with a couple of photos in the request. Stay where it is safe — your mechanic comes to you.',
      },
    ],
  },
  {
    title: 'Tracking & your mechanic',
    blurb: 'Live ETA, verified arrival, and what happens if plans change.',
    icon: Navigation,
    items: [
      {
        q: 'How do I track my mechanic?',
        a: 'Open your request to see a live map, the mechanic’s profile and vehicle, and an ETA that updates at every step — assigned, en route, arrived and diagnosing.',
      },
      {
        q: 'How do I know it is the right person?',
        a: 'Every arrival is OTP-verified. Your mechanic shares the OTP at your vehicle and the job only begins once you confirm it, so a stranger can never start work on your car.',
      },
      {
        q: 'What if my mechanic cannot make it?',
        a: 'If an assigned mechanic stalls, stops responding or cannot arrive, dispatch automatically re-offers the job to more mechanics, widens the search radius and escalates to the command centre. You are never left stranded.',
      },
    ],
  },
  {
    title: 'Quotes & payment',
    blurb: 'Approve the price first, then pay cashless with a proper invoice.',
    icon: CreditCard,
    items: [
      {
        q: 'Do I approve the price before work starts?',
        a: 'Always. After the diagnosis you receive a digital quote with parts and labour on your phone. Nothing is touched on your vehicle until you tap Approve — no approval, no work.',
      },
      {
        q: 'How do I pay, and do I get a receipt?',
        a: 'Pay cashless by card or UPI, or in cash if you prefer. A GST-ready invoice is generated the moment payment is done and lives forever in your request history.',
      },
      {
        q: 'Can I cancel a request?',
        a: 'Yes — the first 60 seconds are free. After that a small cancellation fee applies, because a mechanic may already be on the way to you.',
      },
    ],
  },
  {
    title: 'Account & safety',
    blurb: 'Who shows up at your door, and how your data is handled.',
    icon: ShieldCheck,
    items: [
      {
        q: 'Who are these mechanics?',
        a: 'Every mechanic is ID-verified and skills-checked before going live, and is rated by customers after each job. Ratings travel with them on every request you open.',
      },
      {
        q: 'Is my location and data safe?',
        a: 'Your live location is shared only with the mechanic assigned to your active request and stops being tracked once the job is closed. We never sell your personal data.',
      },
      {
        q: 'Can I control notifications?',
        a: 'Yes. Profile settings let you choose which alerts you get — dispatch updates, ETA changes, quote approvals and offers — so your phone only buzzes for things that matter.',
      },
    ],
  },
];

function ctaFor(role: string | undefined): { label: string; href: string } {
  switch (role) {
    case 'DRIVER':
      return { label: 'Request help now', href: '/requests/new' };
    case 'MECHANIC':
      return { label: 'Open my jobs', href: '/mechanic/jobs' };
    case 'ADMIN':
      return { label: 'Open admin', href: '/admin' };
    case 'OPERATIONS':
      return { label: 'Command centre', href: '/operations' };
    default:
      return { label: 'Log in', href: '/login' };
  }
}

export default function HelpPage() {
  const { user } = useAuth();
  const cta = ctaFor(user?.role);
  const supportPhoneHref = `tel:${BRAND.supportPhone.replace(/\s+/g, '')}`;
  const year = new Date().getFullYear();

  return (
    <AppShell allowAnonymous>
      <div className="mx-auto max-w-4xl space-y-6">
        <div className="animate-fade-up flex flex-wrap items-end justify-between gap-4">
          <div>
            <span className="section-eyebrow">Help Center</span>
            <h1 className="page-title mt-3">How can we help?</h1>
            <p className="page-subtitle">
              Answers about roadside help, tracking, quotes and safety — plus a human you can reach any hour.
            </p>
          </div>
          <Link
            href={cta.href}
            className="inline-flex h-11 items-center gap-2 rounded-lg bg-sun-400 px-5 text-sm font-semibold text-ink shadow-sm transition hover:-translate-y-0.5 hover:bg-sun-300"
          >
            {cta.label}
            <ArrowRight className="h-4 w-4" />
          </Link>
        </div>

        <section className="animate-fade-up overflow-hidden rounded-2xl bg-brand-600 text-white shadow-pop">
          <div className="p-5 sm:p-6">
            <div className="flex items-center gap-2 text-sm font-semibold uppercase tracking-widest">
              <Phone className="h-4 w-4" />
              Talk to a human
            </div>
            <p className="mt-1 text-sm text-white/80">
              Support answers around the clock — real people, not bots.
            </p>

            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              <a
                href={supportPhoneHref}
                className="group flex items-center gap-3 rounded-xl bg-white p-4 text-ink transition hover:-translate-y-0.5 hover:shadow-pop"
              >
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-sun-400 text-ink">
                  <Phone className="h-5 w-5" />
                </span>
                <span className="min-w-0">
                  <span className="block text-xs font-semibold uppercase tracking-wide text-slate-500">Call us</span>
                  <span className="block truncate text-base font-semibold">{BRAND.supportPhone}</span>
                </span>
              </a>

              <a
                href={`mailto:${BRAND.supportEmail}`}
                className="group flex items-center gap-3 rounded-xl bg-white p-4 text-ink transition hover:-translate-y-0.5 hover:shadow-pop"
              >
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-sun-400 text-ink">
                  <Mail className="h-5 w-5" />
                </span>
                <span className="min-w-0">
                  <span className="block text-xs font-semibold uppercase tracking-wide text-slate-500">Email us</span>
                  <span className="block truncate text-base font-semibold">{BRAND.supportEmail}</span>
                </span>
              </a>
            </div>

            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              <div className="flex items-center gap-3 rounded-xl bg-white/15 px-4 py-3 ring-1 ring-inset ring-white/20">
                <Clock3 className="h-5 w-5 shrink-0 text-sun-300" />
                <div>
                  <p className="text-sm font-semibold">Typical reply &lt; 15 minutes</p>
                  <p className="text-xs text-white/70">Chat and email, day or night</p>
                </div>
              </div>
              <div className="flex items-center gap-3 rounded-xl bg-white/15 px-4 py-3 ring-1 ring-inset ring-white/20">
                <Radio className="h-5 w-5 shrink-0 text-sun-300" />
                <div>
                  <p className="text-sm font-semibold">Available 24×7</p>
                  <p className="text-xs text-white/70">Dispatch never sleeps</p>
                </div>
              </div>
            </div>
          </div>
        </section>

        <section className="space-y-4">
          <div>
            <h2 className="section-title text-xl sm:text-2xl">Frequently asked questions</h2>
            <p className="page-subtitle">Tap a question to see the answer.</p>
          </div>

          {FAQ_GROUPS.map((group) => {
            const Icon = group.icon;
            return (
              <div key={group.title} className="card-bright animate-fade-up overflow-hidden">
                <div className="flex items-center gap-3 border-b border-slate-100 bg-sun-50 px-5 py-4">
                  <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-brand-600 text-white">
                    <Icon className="h-5 w-5" />
                  </span>
                  <div className="min-w-0">
                    <h3 className="text-sm font-semibold text-ink">{group.title}</h3>
                    <p className="truncate text-xs text-slate-500">{group.blurb}</p>
                  </div>
                </div>
                <div className="space-y-2 p-3">
                  {group.items.map((item) => (
                    <details key={item.q} className="group rounded-xl border border-slate-100 bg-slate-50/60 open:bg-white">
                      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-3 text-sm font-semibold text-ink [&::-webkit-details-marker]:hidden">
                        {item.q}
                        <ChevronDown className="h-4 w-4 shrink-0 text-slate-400 transition-transform group-open:rotate-180" />
                      </summary>
                      <p className="px-4 pb-4 text-sm leading-relaxed text-slate-600">{item.a}</p>
                    </details>
                  ))}
                </div>
              </div>
            );
          })}
        </section>

        <section className="grid gap-4 sm:grid-cols-3">
          <div className="card-bright animate-fade-up p-5">
            <BadgeCheck className="h-5 w-5 text-brand-700" />
            <p className="mt-3 text-sm font-semibold text-ink">Verified mechanics</p>
            <p className="mt-1 text-xs text-slate-500">ID and skill checked, rated after every job.</p>
          </div>
          <div className="card-bright animate-fade-up p-5">
            <Star className="h-5 w-5 text-brand-700" />
            <p className="mt-3 text-sm font-semibold text-ink">Quote before the wrench</p>
            <p className="mt-1 text-xs text-slate-500">Approve the price on your phone — or no work happens.</p>
          </div>
          <div className="card-bright animate-fade-up p-5">
            <Wrench className="h-5 w-5 text-brand-700" />
            <p className="mt-3 text-sm font-semibold text-ink">Never stranded</p>
            <p className="mt-1 text-xs text-slate-500">Auto re-dispatch and escalation until someone arrives.</p>
          </div>
        </section>

        <footer className="border-t border-slate-200 pt-4 text-center text-xs text-slate-400">
          © {year} {BRAND.name} ·{' '}
          <Link href="/privacy" className="hover:underline">
            Privacy
          </Link>{' '}
          ·{' '}
          <Link href="/terms" className="hover:underline">
            Terms
          </Link>
        </footer>
      </div>
    </AppShell>
  );
}
