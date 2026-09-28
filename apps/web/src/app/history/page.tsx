'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import type { EmergencyRequestDto, Paginated } from '@rr/types';
import { Card, CardContent, EmptyState, Input, LoadingState, StatusBadge, UrgencyBadge, cn } from '@rr/ui';
import { History } from 'lucide-react';
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

  useEffect(() => {
    void apiGet<Paginated<EmergencyRequestDto>>('/api/emergencies', { query: { limit: 50 } })
      .then((data) => setItems(data.items))
      .catch((err) => setError(err instanceof Error ? err.message : 'Could not load history.'))
      .finally(() => setLoading(false));
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
      {error ? <p className="text-sm text-rose-600">{error}</p> : null}

      {!loading && !error && filtered.length === 0 ? (
        <Card>
          <EmptyState
            title="No requests match"
            description="Try another search, or start a new assistance request."
            icon={<History className="h-10 w-10" />}
          />
        </Card>
      ) : null}

      <div className="space-y-3">
        {filtered.map((item) => (
          <Link key={item.id} href={`/requests/${item.id}`}>
            <Card className="mb-3 transition-colors hover:border-brand-300">
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
