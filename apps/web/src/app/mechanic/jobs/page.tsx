'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import type { EmergencyRequestDto, JobDto, Paginated } from '@rr/types';
import { Badge, Card, CardContent, EmptyState, JOB_STATUS_TONE, LoadingState, StatusBadge, Tabs, cn } from '@rr/ui';
import { ArrowRight, Wrench } from 'lucide-react';
import { AppShell } from '@/components/app-shell';
import { apiGet } from '@/lib/api';
import { formatDateTime, titleCase } from '@/lib/format';

const FILTERS = [
  { id: 'active', label: 'Active' },
  { id: 'completed', label: 'Completed' },
  { id: 'all', label: 'All' },
];

const ACTIVE_STATUSES = [
  'ACCEPTED',
  'EN_ROUTE',
  'ARRIVED',
  'VERIFIED',
  'DIAGNOSING',
  'QUOTE_PENDING',
  'QUOTE_APPROVED',
  'REPAIRING',
];

export default function MechanicJobsPage() {
  return (
    <AppShell roles={['MECHANIC', 'WORKSHOP', 'TOWING_PARTNER']}>
      <MechanicJobs />
    </AppShell>
  );
}

function MechanicJobs() {
  const [jobs, setJobs] = useState<JobDto[]>([]);
  const [requests, setRequests] = useState<EmergencyRequestDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState('active');

  useEffect(() => {
    void Promise.all([
      apiGet<Paginated<JobDto>>('/api/jobs', { query: { limit: 50 } }),
      apiGet<Paginated<EmergencyRequestDto>>('/api/emergencies', { query: { limit: 50 } }).catch(
        () => ({ items: [] as EmergencyRequestDto[], total: 0, limit: 50, offset: 0 }),
      ),
    ])
      .then(([jobData, requestData]) => {
        setJobs(jobData.items);
        setRequests(requestData.items);
      })
      .finally(() => setLoading(false));
  }, []);

  const requestById = useMemo(
    () => new Map(requests.map((request) => [request.id, request])),
    [requests],
  );

  const filtered = jobs.filter((job) => {
    if (filter === 'all') return true;
    if (filter === 'active') return ACTIVE_STATUSES.includes(job.status);
    return job.status === 'COMPLETED' || job.status === 'CANCELLED';
  });

  if (loading) return <LoadingState label="Loading jobs…" />;

  return (
    <div className="space-y-5">
      <div>
        <h1 className="page-title">Jobs</h1>
        <p className="page-subtitle">Every assignment, from accepted to invoiced.</p>
      </div>

      <Tabs tabs={FILTERS} active={filter} onChange={setFilter} />

      {filtered.length === 0 ? (
        <Card>
          <EmptyState
            title="No jobs in this view"
            description="Accept an offer from the dispatch board to start working."
            icon={<Wrench className="h-10 w-10" />}
          />
        </Card>
      ) : (
        <div className="space-y-3">
          {filtered.map((job) => {
            const request = requestById.get(job.requestId);
            return (
              <Link key={job.id} href={`/mechanic/jobs/detail?id=${job.id}`}>
                <Card className="mb-3 transition-colors hover:border-brand-300">
                  <CardContent className="flex flex-wrap items-center gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-sm font-semibold text-slate-900">
                          {request?.reference ?? job.requestId.slice(0, 8)}
                        </span>
                        <StatusBadge status={job.status} map={JOB_STATUS_TONE} />
                        {request ? <Badge>{titleCase(request.issueType)}</Badge> : null}
                      </div>
                      <p className="mt-1 text-xs text-slate-500">
                        {request?.vehicleLabel ?? 'Vehicle —'} · {request?.address ?? 'Location on map'} ·{' '}
                        {formatDateTime(job.acceptedAt ?? job.completedAt)}
                      </p>
                    </div>
                    <div className="flex items-center gap-3">
                      {job.earningsCents ? (
                        <span className="text-sm font-semibold tabular-nums text-emerald-700">
                          ₹{Math.round(job.earningsCents / 100).toLocaleString('en-IN')}
                        </span>
                      ) : null}
                      <span className={cn('text-slate-300')}>
                        <ArrowRight className="h-4 w-4" />
                      </span>
                    </div>
                  </CardContent>
                </Card>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}
