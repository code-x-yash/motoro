'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';
import { BRAND } from '@rr/config';
import { Bell, HelpCircle, LogOut, Menu, Siren, X } from 'lucide-react';
import { useAuth, useRequireRole, type Profile } from '@/lib/auth';
import { useI18n } from '@/lib/i18n';
import type { TranslationKey } from '@/lib/dictionaries/en';
import { apiGet } from '@/lib/api';
import { Avatar, cn } from '@rr/ui';
import { NAV_BY_ROLE } from './nav-items';
import type { Role } from '@rr/types';

function LanguageToggle() {
  const { lang, setLang } = useI18n();
  return (
    <div className="flex items-center rounded-lg border border-slate-200 bg-white p-0.5 text-xs font-medium">
      {(['en', 'hi'] as const).map((code) => (
        <button
          key={code}
          type="button"
          onClick={() => setLang(code)}
          className={cn(
            'rounded-md px-2 py-1 transition-colors',
            lang === code ? 'bg-brand-600 text-white' : 'text-slate-500 hover:text-slate-800',
          )}
        >
          {code === 'en' ? 'EN' : 'हि'}
        </button>
      ))}
    </div>
  );
}

function UnreadBadge() {
  const [count, setCount] = useState(0);
  useEffect(() => {
    let alive = true;
    const load = () => {
      void apiGet<{ unreadCount?: number; count?: number }>('/api/notifications/unread-count')
        .then((data) => {
          if (alive) setCount(data.unreadCount ?? data.count ?? 0);
        })
        .catch(() => undefined);
    };
    load();
    const timer = setInterval(load, 30_000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, []);
  if (count <= 0) return null;
  return (
    <span className="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-rose-500 px-1 text-[10px] font-semibold text-white">
      {count > 99 ? '99+' : count}
    </span>
  );
}

export function AppShell({
  children,
  roles = null,
}: {
  children: ReactNode;
  roles?: Role[] | null;
}) {
  const { user, profile, loading, logout, homePath } = useAuth();
  const { allowed } = useRequireRole(roles);
  const { t } = useI18n();
  const pathname = usePathname();
  const router = useRouter();
  const [mobileOpen, setMobileOpen] = useState(false);

  useEffect(() => {
    setMobileOpen(false);
  }, [pathname]);

  if (loading || !allowed) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-canvas">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-brand-600 border-t-transparent" />
      </div>
    );
  }

  if (!user) return null;

  const items = NAV_BY_ROLE[user.role];

  const sidebar = (
    <nav className="flex h-full flex-col gap-1 p-3">
      <Link href={homePath} className="mb-4 flex items-center gap-2 px-2 py-1">
        <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-sun-400 text-sm font-bold text-ink">
          {BRAND.name.slice(0, 1)}
        </span>
        <span className="text-sm font-semibold tracking-tight text-ink">{BRAND.name}</span>
      </Link>
      {items.map((item) => {
        const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
        const Icon = item.icon;
        return (
          <Link
            key={item.href}
            href={item.href}
            className={cn(
              'flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors',
              active
                ? 'bg-brand-600 text-white shadow-sm'
                : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900',
            )}
          >
            <Icon className="h-4 w-4 shrink-0" />
            {t(item.labelKey as TranslationKey)}
          </Link>
        );
      })}
      <div className="mt-auto space-y-1 border-t border-slate-200 pt-3">
        <Link
          href="/help"
          className="flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium text-slate-500 hover:bg-sun-100 hover:text-ink"
        >
          <HelpCircle className="h-4 w-4 shrink-0" />
          {t('nav.help')}
        </Link>
        <button
          type="button"
          onClick={() => {
            void logout().then(() => router.replace('/login'));
          }}
          className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium text-slate-500 hover:bg-slate-100 hover:text-rose-600"
        >
          <LogOut className="h-4 w-4" />
          {t('nav.logout')}
        </button>
      </div>
    </nav>
  );

  return (
    <div className="min-h-screen bg-canvas">
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-60 border-r border-slate-200 bg-white lg:block">
        {sidebar}
      </aside>

      {mobileOpen ? (
        <div className="fixed inset-0 z-40 lg:hidden">
          <div className="absolute inset-0 bg-slate-900/40" onClick={() => setMobileOpen(false)} aria-hidden />
          <aside className="absolute inset-y-0 left-0 w-64 bg-white shadow-xl">{sidebar}</aside>
        </div>
      ) : null}

      <div className="lg:pl-60">
        <header className="sticky top-0 z-20 border-b border-slate-200 bg-white/90 backdrop-blur">
          <div className="flex h-14 items-center gap-3 px-4 sm:px-6">
            <button
              type="button"
              className="rounded-md p-2 text-slate-500 hover:bg-slate-100 lg:hidden"
              onClick={() => setMobileOpen((open) => !open)}
              aria-label="Toggle navigation"
            >
              {mobileOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
            </button>

            <div className="hidden min-w-0 sm:block">
              <p className="truncate text-sm font-semibold text-slate-900">{user.fullName}</p>
              <p className="truncate text-xs text-slate-500">
                {user.role}
                {profile && 'ratingAverage' in profile && typeof profile.ratingAverage === 'number'
                  ? ` · ★ ${profile.ratingAverage.toFixed(1)}`
                  : ''}
              </p>
            </div>

            <div className="ml-auto flex items-center gap-2">
              {user.role === 'DRIVER' ? (
                <Link
                  href="/requests/new"
                  className="hidden h-9 items-center gap-1.5 rounded-lg bg-sun-400 px-3 text-xs font-semibold text-ink shadow-sm transition hover:bg-sun-300 sm:inline-flex"
                >
                  <Siren className="h-3.5 w-3.5" />
                  {t('nav.newRequest')}
                </Link>
              ) : null}
              <LanguageToggle />
              <Link
                href="/notifications"
                className="relative rounded-lg p-2 text-slate-500 hover:bg-slate-100"
                aria-label={t('nav.notifications')}
              >
                <Bell className="h-5 w-5" />
                <UnreadBadge />
              </Link>
              <Link href="/profile" className="hidden sm:block">
                <Avatar name={user.fullName} />
              </Link>
            </div>
          </div>
        </header>

        <main className="px-4 py-6 sm:px-6 lg:px-8">{children}</main>
      </div>
    </div>
  );
}

export type { Profile };
