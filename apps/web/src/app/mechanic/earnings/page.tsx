'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Alert, Badge, Card, CardContent, EmptyState, LoadingState, Stat, Table, Tbody, Td, Th, Thead, Tr } from '@rr/ui';
import { Wallet } from 'lucide-react';
import { AppShell } from '@/components/app-shell';
import { apiGet, errorMessage } from '@/lib/api';
import { formatDateTime, formatINR } from '@/lib/format';

interface EarningsRow {
  jobId: string;
  requestId: string;
  reference: string;
  issueType: string;
  earningsCents: number;
  completedAt: string | null;
}

interface EarningsResponse {
  items: EarningsRow[];
  totalCents?: number;
}

export default function EarningsPage() {
  return (
    <AppShell roles={['MECHANIC', 'WORKSHOP', 'TOWING_PARTNER']}>
      <Earnings />
    </AppShell>
  );
}

function Earnings() {
  const [rows, setRows] = useState<EarningsRow[]>([]);
  const [totalCents, setTotalCents] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void apiGet<EarningsResponse>('/api/mechanics/me/earnings')
      .then((data) => {
        setRows(data.items ?? []);
        setTotalCents(data.totalCents ?? (data.items ?? []).reduce((sum, row) => sum + row.earningsCents, 0));
      })
      .catch((err) => setError(errorMessage(err)))
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <LoadingState label="Loading earnings…" />;

  const thisMonth = rows
    .filter((row) => row.completedAt && new Date(row.completedAt).getMonth() === new Date().getMonth())
    .reduce((sum, row) => sum + row.earningsCents, 0);

  return (
    <div className="space-y-5">
      <div>
        <h1 className="page-title">Earnings</h1>
        <p className="page-subtitle">Credited to your account when the customer's payment settles.</p>
      </div>

      {error ? <Alert tone="danger">{error}</Alert> : null}

      <div className="grid-stat">
        <Stat label="Lifetime" value={formatINR(totalCents)} tone="emerald" />
        <Stat label="This month" value={formatINR(thisMonth)} tone="blue" />
        <Stat label="Paid jobs" value={String(rows.length)} />
        <Stat label="Avg per job" value={formatINR(rows.length ? Math.round(totalCents / rows.length) : 0)} />
      </div>

      <Card>
        <CardContent className="p-0">
          {rows.length === 0 ? (
            <EmptyState
              title="No earnings yet"
              description="Complete a paid job and your payout lands here."
              icon={<Wallet className="h-10 w-10" />}
            />
          ) : (
            <Table>
              <Thead>
                <Tr>
                  <Th>Reference</Th>
                  <Th>Issue</Th>
                  <Th>Completed</Th>
                  <Th className="text-right">Earning</Th>
                </Tr>
              </Thead>
              <Tbody>
                {rows.map((row) => (
                  <Tr key={row.jobId}>
                    <Td>
                      <Link href={`/mechanic/jobs/${row.jobId}`} className="font-medium text-brand-700 hover:underline">
                        {row.reference}
                      </Link>
                    </Td>
                    <Td>
                      <Badge>{row.issueType}</Badge>
                    </Td>
                    <Td>{row.completedAt ? formatDateTime(row.completedAt) : '—'}</Td>
                    <Td className="text-right font-semibold tabular-nums text-emerald-700">
                      {formatINR(row.earningsCents)}
                    </Td>
                  </Tr>
                ))}
              </Tbody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
