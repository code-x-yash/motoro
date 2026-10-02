'use client';

import Link from 'next/link';
import { BRAND, ISSUE_TYPES, type IssueType } from '@rr/config';
import {
  ArrowRight,
  Battery,
  CheckCircle2,
  ChevronDown,
  CircleDot,
  Clock,
  FileText,
  Fuel,
  Gauge,
  HelpCircle,
  KeyRound,
  MapPin,
  Receipt,
  ShieldCheck,
  Siren,
  Star,
  Thermometer,
  Truck,
  Wrench,
  Zap,
  type LucideIcon,
} from 'lucide-react';
import { LandingNav } from '@/components/landing-nav';
import type { TranslationKey } from '@/lib/dictionaries/en';
import { useI18n } from '@/lib/i18n';

const ISSUE_ICONS: Record<IssueType, LucideIcon> = {
  BATTERY: Battery,
  FLAT_TYRE: CircleDot,
  OUT_OF_FUEL: Fuel,
  ENGINE_PROBLEM: Gauge,
  ELECTRICAL_PROBLEM: Zap,
  OVERHEATING: Thermometer,
  LOCKOUT: KeyRound,
  ACCIDENT: Siren,
  GENERAL_BREAKDOWN: Wrench,
  DONT_KNOW: HelpCircle,
};

const STEPS: { title: TranslationKey; body: TranslationKey }[] = [
  { title: 'landing.step1', body: 'landing.step1d' },
  { title: 'landing.step2', body: 'landing.step2d' },
  { title: 'landing.step3', body: 'landing.step3d' },
];

const SERVICES: { icon: LucideIcon; title: TranslationKey; body: TranslationKey }[] = [
  { icon: Wrench, title: 'landing.s1', body: 'landing.s1d' },
  { icon: Fuel, title: 'landing.s2', body: 'landing.s2d' },
  { icon: Gauge, title: 'landing.s3', body: 'landing.s3d' },
  { icon: Truck, title: 'landing.s4', body: 'landing.s4d' },
];

const STATS: { value: TranslationKey; label: TranslationKey }[] = [
  { value: 'landing.statEta', label: 'landing.statEtaLabel' },
  { value: 'landing.statHours', label: 'landing.statHoursLabel' },
  { value: 'landing.statVerified', label: 'landing.statVerifiedLabel' },
  { value: 'landing.statQuote', label: 'landing.statQuoteLabel' },
];

const BULLETS: { icon: LucideIcon; label: TranslationKey }[] = [
  { icon: Receipt, label: 'landing.bulletQuote' },
  { icon: ShieldCheck, label: 'landing.bulletOtp' },
  { icon: FileText, label: 'landing.bulletGst' },
];

const FAQS: { q: TranslationKey; a: TranslationKey }[] = [
  { q: 'faq.q1', a: 'faq.a1' },
  { q: 'faq.q2', a: 'faq.a2' },
  { q: 'faq.q3', a: 'faq.a3' },
  { q: 'faq.q4', a: 'faq.a4' },
  { q: 'faq.q5', a: 'faq.a5' },
];

export default function LandingPage() {
  const { t } = useI18n();

  return (
    <div className="min-h-screen bg-canvas text-ink">
      <LandingNav />

      <section className="hero-wash relative overflow-hidden">
        <div className="page-container relative grid items-center gap-12 py-16 sm:py-24 lg:grid-cols-2 lg:gap-16">
          <div className="animate-fade-up">
            <h1 className="text-[clamp(2.25rem,5vw,3.75rem)] font-bold leading-[1.05] tracking-tight text-ink">
              {t('landing.heroTitle')}
            </h1>
            <p className="mt-4 max-w-xl text-base leading-relaxed text-slate-600 sm:text-lg">
              {t('app.name')} {t('landing.heroSub')}
            </p>
            <div className="mt-8 flex flex-wrap items-center gap-3">
              <Link
                href="/register?role=DRIVER"
                className="inline-flex h-12 items-center gap-2 rounded-xl bg-brand-600 px-6 text-sm font-semibold text-white shadow-sm transition hover:bg-brand-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/40 focus-visible:ring-offset-2"
              >
                {t('landing.ctaPrimary')}
                <ArrowRight className="h-4 w-4" />
              </Link>
              <Link
                href="/register?role=MECHANIC"
                className="inline-flex h-12 items-center gap-2 rounded-xl bg-white px-6 text-sm font-semibold text-ink ring-1 ring-slate-900/10 transition hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/40 focus-visible:ring-offset-2"
              >
                {t('landing.ctaSecondary')}
              </Link>
              <Link
                href="/login"
                className="inline-flex h-12 items-center rounded-xl px-3 text-sm font-semibold text-brand-700 transition hover:text-brand-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/40 focus-visible:ring-offset-2"
              >
                {t('nav.login')}
              </Link>
              <Link
                href="/track"
                className="inline-flex h-12 items-center gap-1.5 rounded-xl px-3 text-sm font-semibold text-brand-700 transition hover:text-brand-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/40 focus-visible:ring-offset-2"
              >
                <MapPin className="h-4 w-4" />
                {t('nav.track')}
              </Link>
            </div>
            <div className="mt-8 flex flex-wrap items-center gap-x-5 gap-y-2 text-xs font-medium text-slate-500">
              <span className="inline-flex items-center gap-1.5">
                <ShieldCheck className="h-4 w-4 text-brand-600" />
                {t('landing.statVerifiedLabel')}
              </span>
              <span className="inline-flex items-center gap-1.5">
                <Clock className="h-4 w-4 text-brand-600" />
                {t('landing.statHoursLabel')}
              </span>
              <span className="inline-flex items-center gap-1.5">
                <Receipt className="h-4 w-4 text-brand-600" />
                {t('landing.statQuoteLabel')}
              </span>
            </div>
          </div>

          <div className="animate-pop-in mx-auto w-full max-w-md lg:mx-0">
            <div className="card-bright p-5 sm:p-6">
              <div className="flex items-center justify-between gap-3">
                <span className="inline-flex items-center gap-1.5 rounded-full bg-sun-100 px-2.5 py-1 text-[11px] font-bold uppercase tracking-wider text-ink">
                  <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-brand-600" />
                  {t('landing.helpCardKicker')}
                </span>
                <span className="inline-flex items-center gap-1.5 rounded-full bg-brand-600 px-2.5 py-1 text-[11px] font-bold text-white">
                  <Clock className="h-3.5 w-3.5" />
                  {t('landing.helpCardEta')}
                </span>
              </div>

              <div className="mt-4 flex items-center gap-3 rounded-xl bg-canvas p-3 ring-1 ring-slate-900/5">
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-sun-400 text-ink">
                  <CircleDot className="h-5 w-5" />
                </span>
                <p className="text-sm font-semibold text-ink">{t('landing.issue.FLAT_TYRE')}</p>
              </div>

              <div className="mt-3 flex items-center gap-3 rounded-xl border border-slate-100 p-3">
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-ink text-xs font-bold text-sun-300">
                  RS
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold text-ink">
                    {t('landing.helpCardMechanic')}
                  </p>
                  <p className="truncate text-xs text-slate-500">{t('landing.helpCardRole')}</p>
                </div>
                <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-sun-100 px-2 py-1 text-xs font-bold text-ink">
                  <Star className="h-3.5 w-3.5 fill-sun-500 text-sun-500" />
                  4.9
                </span>
              </div>

              <div className="mt-3 flex items-center justify-between gap-3 rounded-xl bg-sun-50 px-3 py-2.5 ring-1 ring-sun-200">
                <span className="inline-flex items-center gap-2 text-xs font-semibold text-ink">
                  <CheckCircle2 className="h-4 w-4 text-brand-600" />
                  {t('landing.helpCardOtp')}
                </span>
                <span className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-500">
                  <MapPin className="h-3.5 w-3.5" />
                  {t('landing.helpCardTrack')}
                </span>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="py-16 sm:py-24">
        <div className="page-container">
          <span className="section-eyebrow">{t('landing.categoriesEyebrow')}</span>
          <h2 className="section-title mt-4">{t('landing.categoriesTitle')}</h2>
          <p className="mt-3 max-w-2xl text-sm leading-relaxed text-slate-600 sm:text-base">
            {t('landing.categoriesSub')}
          </p>

          <div className="mt-8 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
            {ISSUE_TYPES.map((issue) => {
              const Icon = ISSUE_ICONS[issue];
              return (
                <Link
                  key={issue}
                  href="/register?role=DRIVER"
                  className="card-bright group flex min-h-[10rem] flex-col items-start gap-3 p-4 transition duration-200 hover:-translate-y-1 hover:shadow-md"
                >
                  <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-sun-100 text-ink transition group-hover:bg-sun-400">
                    <Icon className="h-5 w-5" />
                  </span>
                  <span className="text-sm font-semibold leading-snug text-ink">
                    {t(`landing.issue.${issue}`)}
                  </span>
                  <span className="mt-auto inline-flex items-center gap-1.5 text-xs font-bold text-brand-700">
                    {t('nav.newRequest')}
                    <ArrowRight className="h-4 w-4 transition group-hover:translate-x-0.5" />
                  </span>
                </Link>
              );
            })}
          </div>
        </div>
      </section>

      <section id="how" className="scroll-mt-24 border-t border-slate-900/5 py-16 sm:py-24">
        <div className="page-container">
          <span className="section-eyebrow">{t('landing.howEyebrow')}</span>
          <h2 className="section-title mt-4">{t('landing.howTitle')}</h2>
          <div className="mt-8 grid gap-5 md:grid-cols-3">
            {STEPS.map((step, index) => (
              <div key={step.title} className="card-bright p-6">
                <span className="flex h-10 w-10 items-center justify-center rounded-full bg-sun-400 text-sm font-black text-ink">
                  {index + 1}
                </span>
                <h3 className="mt-4 text-base font-semibold text-ink">{t(step.title)}</h3>
                <p className="mt-2 text-sm leading-relaxed text-slate-600">{t(step.body)}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section id="services" className="scroll-mt-24 border-t border-slate-900/5 py-16 sm:py-24">
        <div className="page-container">
          <span className="section-eyebrow">{t('landing.servicesEyebrow')}</span>
          <h2 className="section-title mt-4">{t('landing.servicesTitle')}</h2>
          <div className="mt-8 grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
            {SERVICES.map((service) => (
              <div key={service.title} className="card-bright flex flex-col p-6">
                <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-brand-50 text-brand-700">
                  <service.icon className="h-5 w-5" />
                </span>
                <h3 className="mt-4 text-base font-semibold text-ink">{t(service.title)}</h3>
                <p className="mt-2 text-sm leading-relaxed text-slate-600">{t(service.body)}</p>
              </div>
            ))}
          </div>
          <p className="mt-6 max-w-3xl text-sm leading-relaxed text-slate-600">
            {t('landing.servicesTrust')}
          </p>
        </div>
      </section>

      <section className="bg-sun-50 py-16 sm:py-24">
        <div className="page-container">
          <span className="section-eyebrow">{t('landing.trustEyebrow')}</span>
          <h2 className="section-title mt-4">{t('landing.trustTitle')}</h2>
          <div className="mt-8 grid grid-cols-2 gap-4 lg:grid-cols-4">
            {STATS.map((stat) => (
              <div key={stat.label} className="card-bright p-5">
                <p className="text-3xl font-extrabold tracking-tight text-brand-700">
                  {t(stat.value)}
                </p>
                <p className="mt-1.5 text-xs font-medium leading-snug text-slate-600">
                  {t(stat.label)}
                </p>
              </div>
            ))}
          </div>
          <ul className="mt-6 grid gap-3 sm:grid-cols-3">
            {BULLETS.map((bullet) => (
              <li
                key={bullet.label}
                className="flex items-start gap-2.5 rounded-xl bg-white/80 px-4 py-3 text-sm font-medium text-ink ring-1 ring-sun-200"
              >
                <bullet.icon className="mt-0.5 h-4 w-4 shrink-0 text-brand-600" />
                {t(bullet.label)}
              </li>
            ))}
          </ul>
        </div>
      </section>

      <section className="bg-ink text-white">
        <div className="page-container flex flex-col items-start gap-8 py-14 sm:flex-row sm:items-center sm:justify-between sm:py-16">
          <div className="max-w-2xl">
            <span className="section-eyebrow">{t('landing.joinEyebrow')}</span>
            <h2 className="mt-4 text-2xl font-bold tracking-tight sm:text-3xl">
              {t('landing.joinTitle')}
            </h2>
            <p className="mt-3 text-sm leading-relaxed text-slate-300 sm:text-base">
              {t('landing.joinSub')}
            </p>
          </div>
          <Link
            href="/register?role=MECHANIC"
            className="inline-flex h-12 shrink-0 items-center gap-2 rounded-xl bg-sun-400 px-6 text-sm font-bold text-ink transition hover:bg-sun-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70"
          >
            {t('landing.ctaSecondary')}
            <ArrowRight className="h-4 w-4" />
          </Link>
        </div>
      </section>

      <section className="py-16 sm:py-24">
        <div className="page-container">
          <div className="mx-auto max-w-3xl">
            <span className="section-eyebrow">{t('faq.eyebrow')}</span>
            <h2 className="section-title mt-4">{t('faq.title')}</h2>
            <div className="mt-8 space-y-3">
              {FAQS.map((item) => (
                <details key={item.q} className="card-bright group">
                  <summary className="flex cursor-pointer list-none items-center justify-between gap-4 px-5 py-4 text-sm font-semibold text-ink [&::-webkit-details-marker]:hidden">
                    {t(item.q)}
                    <ChevronDown className="h-4 w-4 shrink-0 text-slate-400 transition group-open:rotate-180" />
                  </summary>
                  <p className="px-5 pb-5 text-sm leading-relaxed text-slate-600">{t(item.a)}</p>
                </details>
              ))}
            </div>
            <div className="mt-6">
              <Link
                href="/help"
                className="inline-flex items-center gap-1.5 text-sm font-semibold text-brand-700 transition hover:text-brand-800"
              >
                {t('faq.more')}
                <ArrowRight className="h-4 w-4" />
              </Link>
            </div>
          </div>
        </div>
      </section>

      <section className="pb-16 sm:pb-24">
        <div className="page-container">
          <div className="animate-fade-up rounded-3xl bg-brand-600 px-6 py-12 text-center text-white sm:px-12 sm:py-14">
            <h2 className="text-2xl font-bold tracking-tight sm:text-3xl">
              {t('landing.finalTitle')}
            </h2>
            <p className="mx-auto mt-3 max-w-xl text-sm leading-relaxed text-white/80 sm:text-base">
              {t('landing.finalSub')}
            </p>
            <div className="mt-7 flex flex-wrap items-center justify-center gap-3">
              <Link
                href="/register?role=DRIVER"
                className="inline-flex h-12 items-center gap-2 rounded-xl bg-sun-400 px-6 text-sm font-bold text-ink transition hover:bg-sun-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70 focus-visible:ring-offset-2 focus-visible:ring-offset-brand-600"
              >
                {t('landing.ctaPrimary')}
                <ArrowRight className="h-4 w-4" />
              </Link>
              <Link
                href="/login"
                className="inline-flex h-12 items-center rounded-xl px-3 text-sm font-semibold text-white underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70"
              >
                {t('nav.login')}
              </Link>
            </div>
          </div>
        </div>
      </section>

      <footer className="border-t border-slate-900/5 bg-white">
        <div className="page-container flex flex-col gap-6 py-10">
          <div className="flex flex-col items-start justify-between gap-6 sm:flex-row sm:items-center">
            <Link href="/" className="flex items-center gap-2.5">
              <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-sun-400 text-sm font-black text-ink">
                {BRAND.name.slice(0, 1)}
              </span>
              <span className="text-base font-extrabold tracking-tight text-ink">{BRAND.name}</span>
            </Link>
            <nav className="flex flex-wrap items-center gap-x-5 gap-y-2 text-xs font-medium text-slate-500">
              <Link href="/login" className="transition hover:text-ink">
                {t('nav.login')}
              </Link>
              <Link href="/register" className="transition hover:text-ink">
                {t('nav.signup')}
              </Link>
              <Link href="/track" className="transition hover:text-ink">
                {t('nav.track')}
              </Link>
              <Link href="/help" className="transition hover:text-ink">
                {t('nav.help')}
              </Link>
              <Link href="/terms" className="transition hover:text-ink">
                Terms
              </Link>
              <Link href="/privacy" className="transition hover:text-ink">
                Privacy
              </Link>
              <a
                href={`tel:${BRAND.supportPhone.replace(/\s+/g, '')}`}
                className="transition hover:text-ink"
              >
                {BRAND.supportPhone}
              </a>
              <a href={`mailto:${BRAND.supportEmail}`} className="transition hover:text-ink">
                {BRAND.supportEmail}
              </a>
            </nav>
          </div>
          <p className="border-t border-slate-100 pt-5 text-xs text-slate-400">
            © {new Date().getFullYear()} {BRAND.name} · {t('app.tagline')}
          </p>
        </div>
      </footer>
    </div>
  );
}
