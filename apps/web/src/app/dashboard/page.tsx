'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import type { EmergencyRequestDto, Paginated, VehicleDto } from '@rr/types';
import { Alert, Badge, Button, EmptyState, LoadingState, StatusBadge, Stepper, UrgencyBadge, cn } from '@rr/ui';
import {
  ArrowRight,
  Bell,
  Car,
  History,
  LifeBuoy,
  PlusCircle,
  Radio,
  Siren,
  User,
  Wallet,
  Wrench,
} from 'lucide-react';
import { AppShell } from '@/components/app-shell';
import { apiGet } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { formatDateTime, formatEta, titleCase } from '@/lib/format';
import { PROGRESS_STEPS, progressStepIndex } from '@/lib/progress';

type TileTone = 'brand' | 'sun' | 'white' | 'ink';

interface QuickAction {
  label: string;
  hint: string;
  href: string;
  icon: typeof Siren;
  tone: TileTone;
}

const TONE_CLASS: Record<TileTone, string> = {
  brand: 'bg-brand-600 text-white group-hover:bg-brand-700',
  sun: 'bg-sun-400 text-ink group-hover:bg-sun-300',
  white: 'bg-white text-ink border border-slate-200 group-hover:border-brand-300',
  ink: 'bg-ink text-white group-hover:bg-slate-800',
};

const QUICK_ACTIONS: QuickAction[] = [
  { label: 'Request help', hint: 'Battery, tyre, fuel, tow', href: '/requests/new', icon: PlusCircle, tone: 'sun' },
  { label: 'History', hint: 'Past requests & invoices', href: '/history', icon: History, tone: 'white' },
  { label: 'Vehicles', hint: 'Your saved garage', href: '/vehicles', icon: Car, tone: 'brand' },
  { label: 'Notifications', hint: 'Updates and offers', href: '/notifications', icon: Bell, tone: 'white' },
  { label: 'Profile', hint: 'Account & preferences', href: '/profile', icon: User, tone: 'ink' },
  { label: 'Help Center', hint: 'FAQ, call or email', href: '/help', icon: LifeBuoy, tone: 'white' },
];

const MECHANIC_ACTIONS: QuickAction[] = [
  { label: 'Find jobs', hint: 'Offers near you now', href: '/mechanic/jobs', icon: Wrench, tone: 'brand' },
  { label: 'Earnings', hint: 'Payouts & invoices', href: '/mechanic/earnings', icon: Wallet, tone: 'sun' },
];

function ctaFor(role: string | undefined): { label: string; href: string; className: string } {
  switch (role) {
    case 'MECHANIC':
      return { label: 'Find jobs', href: '/mechanic/jobs', className: 'bg-brand-600 text-white hover:bg-brand-700' };
    case 'ADMIN':
      return { label: 'Open admin', href: '/admin', className: 'bg-ink text-white hover:bg-slate-800' };
    case 'OPERATIONS':
      return { label: 'Command centre', href: '/operations', className: 'bg-brand-600 text-white hover:bg-brand-700' };
    case 'DRIVER':
    default:
      return { label: 'Request help now', href: '/requests/new', className: 'bg-sun-400 text-ink hover:bg-sun-300' };
  }
}

export default function DriverDashboardPage() {
  return (
    <AppShell roles={['DRIVER']}>
      <DriverDashboard />
    </AppShell>
  );
}

function DriverDashboard() {
  const [active, setActive] = useState<EmergencyRequestDto | null>(null);
  const [recent, setRecent] = useState<EmergencyRequestDto[]>([]);
  const [vehicles, setVehicles] = useState<VehicleDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [retrying, setRetrying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { user } = useAuth();

  const load = async () => {
    try {
      const [list, vehicleList] = await Promise.all([
        apiGet<Paginated<EmergencyRequestDto>>('/api/emergencies', { query: { limit: 8 } }),
        apiGet<Paginated<VehicleDto>>('/api/vehicles', { query: { limit: 5 } }).catch(
          () => ({ items: [] as VehicleDto[], total: 0, limit: 5, offset: 0 }),
        ),
      ]);
      const current =
        list.items.find((item) => !['PAID', 'CANCELLED', 'FAILED'].includes(item.status)) ?? null;
      setActive(current);
      setRecent(list.items.filter((item) => item.id !== current?.id).slice(0, 5));
      setVehicles(vehicleList.items);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load your dashboard.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 15_000);
    return () => clearInterval(timer);
  }, []);

  const retry = async () => {
    setRetrying(true);
    await load();
    setRetrying(false);
  };

  if (loading) return <LoadingState label="Loading your dashboard…" />;

  const firstName = user?.fullName?.trim().split(/\s+/)[0] ?? 'there';
  const hour = new Date().getHours();
  const greeting = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
  const today = new Intl.DateTimeFormat('en-IN', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  }).format(new Date());
  const cta = ctaFor(user?.role);
  const actions =
    user?.role === 'MECHANIC' ? [...QUICK_ACTIONS, ...MECHANIC_ACTIONS] : QUICK_ACTIONS;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0">
          <span className="section-eyebrow">{today}</span>
          <h1 className="page-title mt-3">
            {greeting}, {firstName}
          </h1>
          <p className="page-subtitle">
            Your roadside, under control: live status, vehicles and recent help requests.
          </p>
        </div>
        <Link
          href={cta.href}
          className={cn(
            'inline-flex h-11 shrink-0 items-center gap-2 rounded-lg px-5 text-sm font-semibold shadow-sm transition hover:-translate-y-0.5',
            cta.className,
          )}
        >
          <Siren className="h-4 w-4" />
          {cta.label}
        </Link>
      </div>

      {error ? (
        <Alert
          tone="danger"
          action={
            <Button size="sm" variant="secondary" loading={retrying} onClick={() => void retry()}>
              Retry
            </Button>
          }
        >
          {error}
        </Alert>
      ) : null}

      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-ink">Quick actions</h2>
          <span className="text-xs text-slate-400">One tap to everywhere you go</span>
        </div>
        <div
          className={cn(
            'grid grid-cols-2 gap-3 sm:grid-cols-3',
            actions.length > 6 ? 'lg:grid-cols-4' : 'lg:grid-cols-6',
          )}
        >
          {actions.map((action) => {
            const Icon = action.icon;
            return (
              <Link
                key={action.href}
                href={action.href}
                className={cn(
                  'group animate-pop-in flex flex-col gap-2 rounded-2xl p-4 shadow-card transition hover:-translate-y-0.5 hover:shadow-pop',
                  TONE_CLASS[action.tone],
                )}
              >
                <Icon className="h-5 w-5" />
                <span className="text-sm font-semibold">{action.label}</span>
                <span
                  className={cn(
                    'text-xs',
                    action.tone === 'white' ? 'text-slate-500' : 'opacity-80',
                  )}
                >
                  {action.hint}
                </span>
              </Link>
            );
          })}
        </div>
      </section>

      <div className="grid gap-4 lg:grid-cols-3">
        <section className="animate-fade-up overflow-hidden rounded-2xl border-2 border-brand-200 bg-white shadow-card lg:col-span-2">
          <div className="flex items-center justify-between gap-3 border-b border-brand-100 bg-brand-50 px-5 py-4">
            <div className="flex items-center gap-2">
              <Radio className={cn('h-4 w-4', active ? 'text-brand-600' : 'text-slate-300')} />
              <h2 className="text-sm font-semibold text-ink">Active request</h2>
              {active ? (
                <span className="inline-flex items-center gap-1.5 rounded-full bg-white px-2.5 py-0.5 text-[11px] font-bold text-brand-700 ring-1 ring-inset ring-brand-200">
                  <span className="relative flex h-1.5 w-1.5">
                    <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-brand-500 opacity-75" />
                    <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-brand-600" />
                  </span>
                  LIVE
                </span>
              ) : null}
            </div>
            {active ? <StatusBadge status={active.status} /> : null}
          </div>

          <div className="p-5">
            {!active ? (
              <EmptyState
                title="No active request. Need help?"
                description="Battery, flat tyre, fuel, accident: one tap starts a timed dispatch to nearby verified mechanics."
                action={
                  <Link
                    href="/requests/new"
                    className="inline-flex h-10 items-center gap-2 rounded-lg bg-sun-400 px-4 text-sm font-semibold text-ink shadow-sm transition hover:-translate-y-0.5 hover:bg-sun-300"
                  >
                    <PlusCircle className="h-4 w-4" /> Request help
                  </Link>
                }
              />
            ) : (
              <div className="space-y-4">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone="blue">{active.reference}</Badge>
                  <UrgencyBadge urgency={active.urgency} />
                  <Badge>{titleCase(active.issueType)}</Badge>
                  {active.assignedMechanic ? (
                    <Badge tone="emerald">★ {active.assignedMechanic.ratingAverage.toFixed(1)} · {active.assignedMechanic.fullName}</Badge>
                  ) : null}
                </div>

                <div>
                  <div className="mb-1.5 flex items-center justify-between text-xs text-slate-500">
                    <span>{active.vehicleLabel ?? 'Vehicle not set'}</span>
                    <span>{formatEta(active.assignedMechanic?.etaMinutes)}</span>
                  </div>
                  <Stepper steps={[...PROGRESS_STEPS]} current={progressStepIndex(active.status)} className="mt-3" />
                  <p className="mt-2 text-xs text-slate-500">
                    {titleCase(active.status)} · created {formatDateTime(active.createdAt)}
                  </p>
                </div>

                <div className="flex flex-wrap gap-2">
                  <Link
                    href={`/requests/detail?id=${active.id}`}
                    className="inline-flex h-10 items-center gap-1.5 rounded-lg bg-sun-400 px-4 text-sm font-semibold text-ink shadow-sm transition hover:-translate-y-0.5 hover:bg-sun-300"
                  >
                    Track <ArrowRight className="h-4 w-4" />
                  </Link>
                  <Link
                    href="/history"
                    className="inline-flex h-10 items-center rounded-lg border border-slate-300 px-4 text-sm font-semibold text-slate-700 hover:bg-slate-50"
                  >
                    All requests
                  </Link>
                </div>
              </div>
            )}
          </div>
        </section>

        <div className="space-y-4">
          <section className="card-bright animate-fade-up overflow-hidden">
            <div className="flex items-center justify-between gap-3 border-b border-slate-100 px-5 py-4">
              <h2 className="text-sm font-semibold text-ink">Your garage</h2>
              <Link href="/vehicles" className="text-xs font-medium text-brand-700 hover:underline">
                Manage
              </Link>
            </div>
            <div className="space-y-2 p-5">
              {vehicles.length === 0 ? (
                <div>
                  <p className="text-sm text-slate-500">
                    No vehicles yet. Add one to speed up requests.
                  </p>
                  <Link
                    href="/vehicles"
                    className="mt-3 inline-flex h-9 items-center gap-1.5 rounded-lg bg-brand-600 px-3.5 text-xs font-semibold text-white hover:bg-brand-700"
                  >
                    Add a vehicle <ArrowRight className="h-3.5 w-3.5" />
                  </Link>
                </div>
              ) : (
                vehicles.map((vehicle) => (
                  <div key={vehicle.id} className="flex items-center justify-between gap-2 rounded-lg border border-slate-100 bg-slate-50 px-3 py-2">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-slate-800">
                        {vehicle.make} {vehicle.model}
                      </p>
                      <p className="truncate text-xs text-slate-500">{vehicle.registrationNumber}</p>
                    </div>
                    <Car className="h-4 w-4 shrink-0 text-slate-300" />
                  </div>
                ))
              )}
            </div>
          </section>

          <section className="card-bright animate-fade-up overflow-hidden">
            <div className="flex items-center justify-between gap-3 border-b border-slate-100 px-5 py-4">
              <h2 className="text-sm font-semibold text-ink">Recent activity</h2>
              {recent.length > 0 ? (
                <Link href="/history" className="text-xs font-medium text-brand-700 hover:underline">
                  View all
                </Link>
              ) : null}
            </div>
            <div className="space-y-2 p-5">
              {recent.length === 0 ? (
                <div>
                  <p className="text-sm text-slate-500">Nothing here yet.</p>
                  <Link
                    href="/requests/new"
                    className="mt-3 inline-flex h-9 items-center gap-1.5 rounded-lg bg-sun-400 px-3.5 text-xs font-semibold text-ink hover:bg-sun-300"
                  >
                    Request help <ArrowRight className="h-3.5 w-3.5" />
                  </Link>
                </div>
              ) : (
                recent.map((item) => (
                  <Link
                    key={item.id}
                    href={`/requests/detail?id=${item.id}`}
                    className="flex items-center justify-between gap-2 rounded-lg border border-slate-100 px-3 py-2 transition hover:-translate-y-0.5 hover:border-brand-200 hover:shadow-card"
                  >
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-slate-800">{item.reference}</p>
                      <p className="truncate text-xs text-slate-500">
                        {titleCase(item.issueType)} · {formatDateTime(item.createdAt)}
                      </p>
                    </div>
                    <StatusBadge status={item.status} />
                  </Link>
                ))
              )}
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
