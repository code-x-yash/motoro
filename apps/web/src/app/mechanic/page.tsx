'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { JobDto, Paginated, RealtimeServerMessage } from '@rr/types';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardContent,
  EmptyState,
  JOB_STATUS_TONE,
  LoadingState,
  StatusBadge,
  Stat,
  UrgencyBadge,
  cn,
} from '@rr/ui';
import { ArrowRight, Radio, Wrench } from 'lucide-react';
import { AppShell } from '@/components/app-shell';
import { apiGet, apiPost, errorMessage } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useRealtime } from '@/lib/realtime';
import { formatDistance, formatEta, formatINR, titleCase } from '@/lib/format';

interface Offer {
  attemptId: string;
  requestId: string;
  reference: string;
  issueType: string;
  urgency: string;
  distanceKm: number | null;
  etaMinutes: number | null;
  timeoutAt: string | null;
  secondsLeft: number | null;
  latitude: number;
  longitude: number;
  address: string | null;
  requiredSkills: string[];
}

interface Stats {
  status: string;
  verificationStatus: string;
  todayJobs: number;
  activeJobs: number;
  pendingOffers: number;
  earningsCents: number;
  ratingAverage: number;
  ratingCount: number;
  acceptanceRate: number;
  jobsCompleted: number;
  reliabilityScore: number;
}

const ACTIVE_JOB_STATUSES = [
  'ACCEPTED',
  'EN_ROUTE',
  'ARRIVED',
  'VERIFIED',
  'DIAGNOSING',
  'QUOTE_PENDING',
  'QUOTE_APPROVED',
  'REPAIRING',
];

export default function MechanicBoardPage() {
  return (
    <AppShell roles={['MECHANIC', 'WORKSHOP', 'TOWING_PARTNER']}>
      <MechanicBoard />
    </AppShell>
  );
}

function MechanicBoard() {
  const { user } = useAuth();
  const [offers, setOffers] = useState<Offer[]>([]);
  const [jobs, setJobs] = useState<JobDto[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [responding, setResponding] = useState<string[]>([]);
  const [, setTick] = useState(0);

  const load = useCallback(async () => {
    try {
      const [offerData, jobData, statsData] = await Promise.all([
        apiGet<{ items: Offer[] }>('/api/dispatch/offers').catch(() => ({ items: [] as Offer[] })),
        apiGet<Paginated<JobDto>>('/api/jobs', { query: { limit: 20 } }),
        apiGet<Stats>('/api/mechanics/me/stats').catch(() => null),
      ]);
      setOffers(offerData.items);
      setJobs(jobData.items);
      setStats(statsData);
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = setInterval(() => {
      setTick((value) => value + 1);
      void load();
    }, 8000);
    return () => clearInterval(timer);
  }, [load]);

  const onMessage = useCallback(
    (message: RealtimeServerMessage) => {
      if (message.type === 'notification' || message.type === 'job.updated') void load();
      if (message.type === 'request.event') void load();
    },
    [load],
  );

  useRealtime(user ? `mechanic:${user.id}` : null, onMessage, { enabled: Boolean(user) });

  const activeJobs = useMemo(
    () => jobs.filter((job) => ACTIVE_JOB_STATUSES.includes(job.status)),
    [jobs],
  );

  const liveOffers = useMemo(
    () => offers.filter((offer) => (offer.secondsLeft ?? 0) > 0),
    [offers],
  );

  const respond = async (attemptId: string, action: 'accept' | 'decline', reason?: string) => {
    setResponding((prev) => [...prev, attemptId]);
    setError(null);
    try {
      await apiPost(`/api/dispatch/${attemptId}/${action}`, reason ? { reason } : {});
      await load();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setResponding((prev) => prev.filter((id) => id !== attemptId));
    }
  };

  const toggleOnline = async () => {
    if (!stats) return;
    setBusy(true);
    setError(null);
    try {
      await apiPost('/api/mechanics/me/status', {
        status: stats.status === 'AVAILABLE' ? 'OFFLINE' : 'AVAILABLE',
      });
      await load();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  if (loading && !stats) return <LoadingState label="Loading dispatch board…" />;

  const online = stats?.status === 'AVAILABLE';

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="page-title">Dispatch board</h1>
          <p className="page-subtitle">Incoming offers expire on a timer — respond fast to stay reliable.</p>
        </div>
        <div className="flex items-center gap-2">
          <span className={cn('h-2.5 w-2.5 rounded-full', online ? 'bg-emerald-500' : 'bg-slate-300')} />
          <span className="text-xs font-medium text-slate-600">{stats ? titleCase(stats.status) : '…'}</span>
          {stats ? (
            <Badge tone={stats.verificationStatus === 'VERIFIED' ? 'emerald' : 'amber'}>
              {titleCase(stats.verificationStatus)}
            </Badge>
          ) : null}
          <Button variant={online ? 'secondary' : 'success'} size="sm" loading={busy} onClick={toggleOnline}>
            {online ? 'Go offline' : 'Go online'}
          </Button>
        </div>
      </div>

      {error ? <Alert tone="danger">{error}</Alert> : null}
      {stats && stats.verificationStatus !== 'VERIFIED' ? (
        <Alert tone="warning" title="Profile not verified yet">
          An administrator must verify your documents before you can go online and receive offers.
        </Alert>
      ) : null}

      <div className="grid-stat">
        <Stat label="Pending offers" value={stats?.pendingOffers ?? 0} tone={liveOffers.length ? 'amber' : 'slate'} />
        <Stat label="Active jobs" value={stats?.activeJobs ?? 0} tone="blue" />
        <Stat label="Completed" value={stats?.jobsCompleted ?? 0} tone="emerald" />
        <Stat
          label="Earnings"
          value={formatINR(stats?.earningsCents ?? 0)}
          hint={`${stats?.acceptanceRate ?? 0}% acceptance`}
        />
      </div>

      <section className="space-y-3">
        <div className="flex items-center gap-2">
          <Radio className="h-4 w-4 text-brand-600" />
          <h2 className="text-sm font-semibold text-slate-900">Incoming offers</h2>
          {liveOffers.length ? <Badge tone="amber">{liveOffers.length} live</Badge> : null}
        </div>

        {liveOffers.length === 0 ? (
          <Card>
            <EmptyState
              title="No offers right now"
              description="You will be notified the moment a request matches your skills, radius and rating."
              icon={<Radio className="h-10 w-10" />}
            />
          </Card>
        ) : (
          <div className="grid gap-3 lg:grid-cols-2">
            {liveOffers.map((offer) => {
              const seconds = offer.secondsLeft ?? 0;
              const rowBusy = responding.includes(offer.attemptId);
              return (
                <Card key={offer.attemptId} className={cn(seconds < 15 && 'border-amber-300')}>
                  <CardContent className="space-y-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge tone="blue">{offer.reference}</Badge>
                      <UrgencyBadge urgency={offer.urgency} />
                      <Badge>{titleCase(offer.issueType)}</Badge>
                      <span className="ml-auto text-xs font-semibold tabular-nums text-amber-700">
                        {Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, '0')}
                      </span>
                    </div>
                    <p className="text-xs text-slate-500">
                      {formatDistance(offer.distanceKm)} · ETA {formatEta(offer.etaMinutes)} ·{' '}
                      {offer.address ?? 'Location on map'}
                    </p>
                    <div className="flex flex-wrap gap-1.5">
                      {offer.requiredSkills.slice(0, 5).map((skill) => (
                        <Badge key={skill} tone="slate">
                          {skill}
                        </Badge>
                      ))}
                    </div>
                    <div className="flex gap-2">
                      <Button size="sm" loading={rowBusy} onClick={() => void respond(offer.attemptId, 'accept')}>
                        Accept job
                      </Button>
                      <Button
                        size="sm"
                        variant="secondary"
                        loading={rowBusy}
                        onClick={() => void respond(offer.attemptId, 'decline', 'Busy')}
                      >
                        Decline
                      </Button>
                      <Link href={`/requests/detail?id=${offer.requestId}`} className="ml-auto text-xs text-brand-700 hover:underline">
                        Details
                      </Link>
                    </div>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        )}
      </section>

      <section className="space-y-3">
        <div className="flex items-center gap-2">
          <Wrench className="h-4 w-4 text-brand-600" />
          <h2 className="text-sm font-semibold text-slate-900">Active jobs</h2>
          <Link href="/mechanic/jobs" className="ml-auto text-xs font-medium text-brand-700 hover:underline">
            All jobs
          </Link>
        </div>

        {activeJobs.length === 0 ? (
          <Card>
            <EmptyState title="No active job" description="Accepted offers appear here as working jobs." />
          </Card>
        ) : (
          <div className="space-y-3">
            {activeJobs.map((job) => (
              <Card key={job.id}>
                <CardContent className="flex flex-wrap items-center gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-semibold text-slate-900">{job.mechanicName}</span>
                      <StatusBadge status={job.status} map={JOB_STATUS_TONE} />
                      {job.otpRequired && !job.otpVerifiedAt ? <Badge tone="amber">OTP pending</Badge> : null}
                    </div>
                    <p className="text-xs text-slate-500">Job {job.id.slice(0, 8)} · request {job.requestId.slice(0, 8)}</p>
                  </div>
                  <Link href={`/mechanic/jobs/detail?id=${job.id}`}>
                    <Button size="sm" variant="secondary">
                      Open workbench <ArrowRight className="h-3.5 w-3.5" />
                    </Button>
                  </Link>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
