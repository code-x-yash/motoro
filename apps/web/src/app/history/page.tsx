'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import type { EmergencyRequestDto, Paginated } from '@rr/types';
import { Alert, Button, Card, CardContent, EmptyState, Input, LoadingState, StatusBadge, UrgencyBadge, cn } from '@rr/ui';
import { History, PlusCircle } from 'lucide-react';
import { AppShell } from '@/components/app-shell';
import { apiGet } from '@/lib/api';
import { formatDateTime, formatINR, titleCase } from '@/lib/format';

export default function HistoryPage() {
  return (
    <AppShell>
      <HistoryContent />
    </AppShell>
  );
}

function HistoryContent() {
  const [items, setItems] = useState<EmergencyRequestDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');

  const load = () => {
    setLoading(true);
    setError(null);
    void apiGet<Paginated<EmergencyRequestDto>>('/api/emergencies', { query: { limit: 50 } })
      .then((data) => setItems(data.items))
      .catch((err) => setError(err instanceof Error ? err.message : 'Could not load history.'))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    load();
  }, []);

  const filtered = items.filter((item) => {
    if (!query.trim()) return true;
    const needle = query.toLowerCase();
    return (
      item.reference.toLowerCase().includes(needle) ||
      item.issueType.toLowerCase().includes(needle) ||
      (item.vehicleLabel ?? '').toLowerCase().includes(needle)
    );
  });

  return (
    <div className="space-y-5">
      <div>
        <h1 className="page-title">History</h1>
        <p className="page-subtitle">Every assistance request, invoice and outcome.</p>
      </div>

      <Input
        placeholder="Search by reference, issue or vehicle…"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        className="max-w-md"
      />

      {loading ? <LoadingState /> : null}

      {error ? (
        <Alert
          tone="danger"
          action={
            <Button size="sm" variant="secondary" onClick={load}>
              Retry
            </Button>
          }
        >
          {error}
        </Alert>
      ) : null}

      {!loading && !error && filtered.length === 0 ? (
        <Card>
          <EmptyState
            title={query.trim() ? 'No requests match' : 'No requests yet'}
            description={
              query.trim()
                ? 'Try another search, or start a new assistance request.'
                : 'Battery, flat tyre, fuel, accident — one tap starts a timed dispatch to nearby mechanics.'
            }
            icon={<History className="h-10 w-10" />}
            action={
              <Link
                href="/requests/new"
                className="inline-flex h-10 items-center gap-2 rounded-lg bg-sun-400 px-4 text-sm font-semibold text-ink shadow-sm transition hover:-translate-y-0.5 hover:bg-sun-300"
              >
                <PlusCircle className="h-4 w-4" /> Request help
              </Link>
            }
          />
        </Card>
      ) : null}

      <div className="space-y-3">
        {filtered.map((item) => (
          <Link key={item.id} href={`/requests/detail?id=${item.id}`}>
            <Card className="transition-colors hover:border-brand-300">
              <CardContent className="flex flex-wrap items-center gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-semibold text-slate-900">{item.reference}</span>
                    <StatusBadge status={item.status} />
                    <UrgencyBadge urgency={item.urgency} />
                  </div>
                  <p className="mt-1 text-xs text-slate-500">
                    {titleCase(item.issueType)} · {item.vehicleLabel ?? 'No vehicle'} ·{' '}
                    {formatDateTime(item.createdAt)}
                  </p>
                </div>
                <div className="text-right">
                  <p className="text-sm font-semibold tabular-nums text-slate-900">
                    {item.totalAmountCents ? formatINR(item.totalAmountCents) : '—'}
                  </p>
                  <p className={cn('text-xs', item.rating ? 'text-amber-500' : 'text-slate-400')}>
                    {item.rating ? `★ ${item.rating}` : 'Not rated'}
                  </p>
                </div>
              </CardContent>
            </Card>
          </Link>
        ))}
      </div>
    </div>
  );
}
