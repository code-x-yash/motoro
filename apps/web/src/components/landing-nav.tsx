'use client';

import Link from 'next/link';
import { useState } from 'react';
import { BRAND } from '@rr/config';
import { Menu, X } from 'lucide-react';
import { useI18n } from '@/lib/i18n';

export function LandingNav() {
  const [open, setOpen] = useState(false);
  const { t, lang, setLang } = useI18n();

  return (
    <header className="sticky top-0 z-40 border-b border-slate-900/5 bg-white/85 backdrop-blur">
      <div className="page-container flex h-16 items-center justify-between gap-3">
        <Link href="/" className="flex shrink-0 items-center gap-2.5">
          <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-sun-400 text-sm font-black text-ink">
            {BRAND.name.slice(0, 1)}
          </span>
          <span className="text-base font-extrabold tracking-tight text-ink">{BRAND.name}</span>
        </Link>

        <nav className="hidden items-center gap-7 text-sm font-medium text-slate-600 sm:flex">
          <Link href="/#how" className="transition hover:text-ink">
            {t('nav.how')}
          </Link>
          <Link href="/#services" className="transition hover:text-ink">
            {t('nav.services')}
          </Link>
          <Link href="/track" className="transition hover:text-ink">
            {t('nav.track')}
          </Link>
          <Link href="/help" className="transition hover:text-ink">
            {t('nav.help')}
          </Link>
        </nav>

        <div className="flex items-center gap-2">
          <div className="flex items-center rounded-full bg-slate-100 p-0.5 text-xs font-bold">
            {(['en', 'hi'] as const).map((code) => (
              <button
                key={code}
                type="button"
                onClick={() => setLang(code)}
                aria-pressed={lang === code}
                className={`rounded-full px-2.5 py-1 transition ${
                  lang === code ? 'bg-ink text-white' : 'text-slate-500 hover:text-ink'
                }`}
              >
                {code === 'en' ? 'EN' : 'हि'}
              </button>
            ))}
          </div>
          <Link
            href="/login"
            className="hidden rounded-lg px-3 py-2 text-sm font-semibold text-slate-700 transition hover:bg-slate-100 sm:block"
          >
            {t('nav.login')}
          </Link>
          <Link
            href="/register"
            className="hidden rounded-xl bg-sun-400 px-4 py-2.5 text-sm font-bold text-ink shadow-card transition hover:bg-sun-300 sm:block"
          >
            {t('nav.signup')}
          </Link>
          <button
            type="button"
            className="rounded-lg p-2 text-slate-600 transition hover:bg-slate-100 sm:hidden"
            onClick={() => setOpen((value) => !value)}
            aria-label="Toggle menu"
            aria-expanded={open}
          >
            {open ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
          </button>
        </div>
      </div>

      {open ? (
        <div className="border-t border-slate-100 bg-white px-4 py-4 sm:hidden">
          <div className="flex flex-col gap-1 text-sm">
            <Link
              href="/#how"
              className="rounded-lg px-3 py-2.5 font-medium text-slate-700 transition hover:bg-slate-50"
              onClick={() => setOpen(false)}
            >
              {t('nav.how')}
            </Link>
            <Link
              href="/#services"
              className="rounded-lg px-3 py-2.5 font-medium text-slate-700 transition hover:bg-slate-50"
              onClick={() => setOpen(false)}
            >
              {t('nav.services')}
            </Link>
            <Link
              href="/track"
              className="rounded-lg px-3 py-2.5 font-medium text-slate-700 transition hover:bg-slate-50"
              onClick={() => setOpen(false)}
            >
              {t('nav.track')}
            </Link>
            <Link
              href="/help"
              className="rounded-lg px-3 py-2.5 font-medium text-slate-700 transition hover:bg-slate-50"
              onClick={() => setOpen(false)}
            >
              {t('nav.help')}
            </Link>
            <Link
              href="/login"
              className="rounded-lg px-3 py-2.5 font-medium text-slate-700 transition hover:bg-slate-50"
              onClick={() => setOpen(false)}
            >
              {t('nav.login')}
            </Link>
            <Link
              href="/register"
              className="mt-1 rounded-xl bg-sun-400 px-3 py-3 text-center font-bold text-ink"
              onClick={() => setOpen(false)}
            >
              {t('nav.signup')}
            </Link>
          </div>
        </div>
      ) : null}
    </header>
  );
}
