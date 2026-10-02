'use client';

import { Suspense, useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { BadgeCheck, MapPin, Navigation, RefreshCw, Search, Star, Wrench } from 'lucide-react';
import { Badge, Button, Card, CardContent, CardHeader, CardTitle, LoadingState, StatusBadge, UrgencyBadge } from '@rr/ui';
import { AppShell } from '@/components/app-shell';
import { apiGet, errorMessage } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { formatDateTime, titleCase } from '@/lib/format';
import { PROGRESS_STEPS, progressStepIndex } from '@/lib/progress';

interface TrackData {
  tracking: {
    reference: string;
    status: string;
    issueType: string;
    urgency: string;
    address: string | null;
    updatedAt: string;
    mechanic: { name: string; verified: boolean; rating: number | null } | null;
  };
}

const ACTIVE_STATUSES = new Set([
  'CREATED',
  'SEARCHING',
  'DISPATCHING',
  'ASSIGNED',
  'MECHANIC_EN_ROUTE',
  'MECHANIC_NEARBY',
  'ARRIVED',
  'DIAGNOSING',
  'QUOTE_PENDING',
  'QUOTE_APPROVED',
  'REPAIRING',
  'PAYMENT_PENDING',
  'TOWING_REQUIRED',
  'ESCALATED',
]);

function ReferenceForm({ onSubmit }: { onSubmit: (reference: string) => void }) {
  const [value, setValue] = useState('');
  const { user } = useAuth();
  return (
    <Card className="animate-fade-up mx-auto max-w-md">
      <CardHeader>
        <CardTitle>Track a request</CardTitle>
        <span className="text-sm text-slate-500">
          Enter the request code from your confirmation message (for example RR-ABC123).
        </span>
      </CardHeader>
      <CardContent>
        <form
          className="flex gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            const reference = value.trim().toUpperCase();
            if (reference) onSubmit(reference);
          }}
        >
          <input
            value={value}
            onChange={(event) => setValue(event.target.value.toUpperCase())}
            placeholder="RR-ABC123"
            aria-label="Request code"
            className="h-11 flex-1 rounded-lg border border-slate-200 px-3 font-mono text-sm uppercase tracking-widest focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/20"
          />
          <Button type="submit" disabled={!value.trim()}>
            <Search className="h-4 w-4" /> Track
          </Button>
        </form>
        {!user ? (
          <p className="mt-4 text-center text-sm text-slate-500">
            Have an account?{' '}
            <Link href="/login" className="font-medium text-brand-700 hover:underline">
              Sign in
            </Link>{' '}
            to see every request you have raised.
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}

function TrackBody() {
  const router = useRouter();
  const { user } = useAuth();
  const params = useSearchParams();
  const reference = (params.get('ref') ?? params.get('reference') ?? '').trim().toUpperCase();
  const [data, setData] = useState<TrackData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(Boolean(reference));
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(async () => {
    if (!reference) return;
    try {
      const result = await apiGet<TrackData>(`/api/emergencies/track/${encodeURIComponent(reference)}`);
      setData(result);
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [reference]);

  useEffect(() => {
    setData(null);
    setError(null);
    setLoading(Boolean(reference));
    void load();
  }, [reference, load]);

  useEffect(() => {
    if (!data || !ACTIVE_STATUSES.has(data.tracking.status)) return;
    timerRef.current = setTimeout(() => void load(), 10_000);
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [data, load]);

  if (!reference) return <ReferenceForm onSubmit={(code) => router.push(`/track?ref=${encodeURIComponent(code)}`)} />;
  if (loading) return <LoadingState label="Finding your request…" />;
  if (error || !data) {
    return (
      <Card className="animate-fade-up mx-auto max-w-md">
        <CardHeader>
          <CardTitle>We could not find that request</CardTitle>
          <span className="text-sm text-slate-500">{error ?? 'Check the code and try again.'}</span>
        </CardHeader>
        <CardContent className="flex flex-wrap items-center gap-3">
          <Link
            href="/track"
            className="inline-flex h-10 items-center justify-center gap-2 rounded-lg border border-slate-300 bg-white px-4 text-sm font-medium text-slate-800 transition hover:bg-slate-50"
          >
            Try another code
          </Link>
          <Link
            href="/"
            className="inline-flex h-10 items-center justify-center gap-2 rounded-lg px-4 text-sm font-medium text-slate-700 transition hover:bg-slate-100"
          >
            Go home
          </Link>
        </CardContent>
      </Card>
    );
  }

  const { tracking } = data;
  const stepIndex = progressStepIndex(tracking.status);
  const isDone = tracking.status === 'PAID' || tracking.status === 'COMPLETED';
  const isTerminal = tracking.status === 'CANCELLED' || tracking.status === 'FAILED';

  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <Card className="animate-fade-up">
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <Badge tone="blue">{tracking.reference}</Badge>
              <StatusBadge status={tracking.status} />
              <UrgencyBadge urgency={tracking.urgency} />
            </div>
            <button
              type="button"
              onClick={() => {
                setLoading(true);
                void load();
              }}
              className="flex items-center gap-1.5 text-xs font-medium text-slate-500 hover:text-ink"
            >
              <RefreshCw className="h-3.5 w-3.5" /> Refresh
            </button>
          </div>
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="flex items-start gap-3 text-sm text-slate-600">
            <MapPin className="mt-0.5 h-4 w-4 shrink-0 text-brand-700" />
            <span>
              {titleCase(tracking.issueType)}
              {tracking.address ? ` · ${tracking.address}` : ''}
            </span>
          </div>

          {!isTerminal ? (
            <ol className="grid grid-cols-4 gap-2 sm:grid-cols-7">
              {PROGRESS_STEPS.map((step, index) => {
                const active = stepIndex >= 0 && index <= stepIndex;
                const current = stepIndex === index;
                return (
                  <li key={step} className="text-center">
                    <div
                      className={`mx-auto h-1.5 rounded-full transition ${
                        active ? (current ? 'bg-brand-600' : 'bg-brand-500/70') : 'bg-slate-200'
                      } ${current ? 'ring-4 ring-brand-500/15' : ''}`}
                    />
                    <span className={`mt-1.5 block text-[10px] ${active ? 'font-semibold text-ink' : 'text-slate-400'}`}>
                      {step}
                    </span>
                  </li>
                );
              })}
            </ol>
          ) : (
            <p className="text-sm font-medium text-ink">
              {isDone ? 'This request is complete — thank you!' : titleCase(tracking.status)}
            </p>
          )}

          {tracking.mechanic ? (
            <div className="flex items-center gap-3 rounded-xl border border-slate-100 bg-slate-50 p-3">
              <span className="flex h-10 w-10 items-center justify-center rounded-full bg-brand-600 text-white">
                <Wrench className="h-5 w-5" />
              </span>
              <div className="min-w-0 flex-1">
                <p className="flex items-center gap-1.5 text-sm font-semibold text-ink">
                  {tracking.mechanic.name}
                  {tracking.mechanic.verified ? <BadgeCheck className="h-4 w-4 text-brand-700" /> : null}
                </p>
                <p className="text-xs text-slate-500">Your mechanic</p>
              </div>
              {tracking.mechanic.rating !== null ? (
                <span className="flex items-center gap-1 text-sm font-semibold text-ink">
                  <Star className="h-4 w-4 fill-sun-400 text-sun-400" /> {tracking.mechanic.rating}
                </span>
              ) : null}
            </div>
          ) : (
            <div className="flex items-center gap-3 rounded-xl border border-dashed border-slate-200 p-3 text-sm text-slate-500">
              <Navigation className="h-4 w-4 text-slate-400" />
              Searching for a nearby mechanic…
            </div>
          )}

          <p className="text-xs text-slate-400">Last updated {formatDateTime(tracking.updatedAt)} · auto-refreshes every 10 seconds</p>
        </CardContent>
      </Card>

      {!user ? (
        <div className="flex flex-wrap items-center justify-center gap-x-2 gap-y-1 text-center text-sm text-slate-500">
          <span>Have an account?</span>
          <Link href="/login" className="font-medium text-brand-700 hover:underline">
            Sign in
          </Link>
          <span>to see every request you have raised.</span>
        </div>
      ) : null}
    </div>
  );
}

export default function TrackPage() {
  return (
    <AppShell allowAnonymous>
      <div className="mx-auto max-w-4xl space-y-6">
        <div className="animate-fade-up text-center">
          <span className="section-eyebrow">Live tracking</span>
          <h1 className="page-title mt-3">Where is my mechanic?</h1>
          <p className="page-subtitle">Follow your roadside request in real time — no login needed.</p>
        </div>
        <Suspense fallback={<LoadingState label="Opening tracker…" />}>
          <TrackBody />
        </Suspense>
      </div>
    </AppShell>
  );
}
