'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import type { AuditLogDto, Paginated } from '@rr/types';
import { Alert, Badge, Button, Card, CardContent, CardHeader, CardTitle, EmptyState, LoadingState, Stat, Table, Tbody, Td, Th, Thead, Tr, cn } from '@rr/ui';
import { ShieldCheck, Users } from 'lucide-react';
import { AppShell } from '@/components/app-shell';
import { apiGet, apiPost, errorMessage } from '@/lib/api';
import { formatDateTime } from '@/lib/format';

interface AdminStats {
  users: { total: number; drivers: number; mechanics: number; workshops: number; towing: number };
  requests: { total: number; paid: number; escalated: number; cancelled: number; today: number };
  jobs: { total: number; completed: number };
  revenueCents: number;
  pendingVerifications: number;
  openDisputes?: number;
}

interface MechanicRow {
  userId: string;
  fullName: string;
  email: string;
  verificationStatus: string;
  experienceYears?: number;
  serviceRadiusKm?: number;
  documentUrl?: string | null;
}

export default function AdminHomePage() {
  return (
    <AppShell roles={['ADMIN']}>
      <AdminHome />
    </AppShell>
  );
}

function AdminHome() {
  const [stats, setStats] = useState<AdminStats | null>(null);
  const [pending, setPending] = useState<MechanicRow[]>([]);
  const [audit, setAudit] = useState<AuditLogDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = async () => {
    try {
      const [statsData, pendingData, reviewData, auditData] = await Promise.all([
        apiGet<AdminStats>('/api/admin/stats'),
        apiGet<{ items: MechanicRow[] }>('/api/admin/mechanics', { query: { verificationStatus: 'PENDING', limit: 20 } }).catch(
          () => ({ items: [] }),
        ),
        apiGet<{ items: MechanicRow[] }>('/api/admin/mechanics', { query: { verificationStatus: 'UNDER_REVIEW', limit: 20 } }).catch(
          () => ({ items: [] }),
        ),
        apiGet<Paginated<AuditLogDto>>('/api/admin/audit-logs', { query: { limit: 8 } }).catch(() => ({
          items: [],
          total: 0,
          limit: 8,
          offset: 0,
        })),
      ]);
      setStats(statsData);
      setPending([...(pendingData.items ?? []), ...(reviewData.items ?? [])]);
      setAudit(auditData.items ?? []);
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const decide = async (userId: string, decision: 'VERIFIED' | 'REJECTED') => {
    setBusy(true);
    try {
      await apiPost(`/api/admin/mechanics/${userId}/verify`, { decision, reason: decision === 'VERIFIED' ? 'Approved by admin' : 'Documents incomplete' });
      await load();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  if (loading && !stats) return <LoadingState label="Loading administration…" />;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="page-title">Platform administration</h1>
          <p className="page-subtitle">Users, verifications, pricing and audit trail.</p>
        </div>
        <div className="flex gap-2">
          <Link href="/admin/users">
            <Button variant="secondary" size="sm">
              <Users className="h-4 w-4" /> Users
            </Button>
          </Link>
          <Link href="/admin/pricing">
            <Button variant="secondary" size="sm">
              Pricing & config
            </Button>
          </Link>
          <Link href="/admin/disputes">
            <Button variant="secondary" size="sm">
              Disputes{stats?.openDisputes ? ` (${stats.openDisputes})` : ''}
            </Button>
          </Link>
        </div>
      </div>

      {error ? <Alert tone="danger">{error}</Alert> : null}

      <div className="grid-stat">
        <Stat label="Users" value={stats?.users.total ?? 0} hint={`${stats?.users.drivers ?? 0} drivers · ${stats?.users.mechanics ?? 0} mechanics`} />
        <Stat label="Requests" value={stats?.requests.total ?? 0} hint={`${stats?.requests.today ?? 0} today`} tone="blue" />
        <Stat label="Jobs completed" value={stats?.jobs.completed ?? 0} tone="emerald" />
        <Stat label="Revenue" value={`₹${Math.round((stats?.revenueCents ?? 0) / 100).toLocaleString('en-IN')}`} tone="emerald" />
        <Stat label="Pending verifications" value={stats?.pendingVerifications ?? 0} tone="amber" />
        <Stat label="Open disputes" value={stats?.openDisputes ?? 0} tone="rose" />
        <Stat label="Escalated" value={stats?.requests.escalated ?? 0} tone="rose" />
        <Stat label="Cancelled" value={stats?.requests.cancelled ?? 0} />
        <Stat label="Workshops / towing" value={`${stats?.users.workshops ?? 0} / ${stats?.users.towing ?? 0}`} />
      </div>

      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <ShieldCheck className="h-4 w-4 text-brand-600" />
            <CardTitle>Verification queue</CardTitle>
          </div>
          <Badge tone={pending.length ? 'amber' : 'emerald'}>{pending.length} waiting</Badge>
        </CardHeader>
        <CardContent className="p-0">
          {pending.length === 0 ? (
            <EmptyState title="Nothing to review" description="All mechanic submissions are up to date." />
          ) : (
            <Table>
              <Thead>
                <Tr>
                  <Th>Mechanic</Th>
                  <Th>Status</Th>
                  <Th className="text-right">Decision</Th>
                </Tr>
              </Thead>
              <Tbody>
                {pending.map((mechanic) => (
                  <Tr key={mechanic.userId}>
                    <Td>
                      <p className="font-medium text-slate-900">{mechanic.fullName}</p>
                      <p className="text-xs text-slate-400">{mechanic.email}</p>
                    </Td>
                    <Td>
                      <Badge tone="amber">{mechanic.verificationStatus}</Badge>
                      {mechanic.documentUrl ? (
                        <a
                          href={mechanic.documentUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="mt-0.5 block text-xs font-medium text-brand-700 hover:underline"
                        >
                          View document
                        </a>
                      ) : null}
                    </Td>
                    <Td className="text-right">
                      <div className="flex justify-end gap-2">
                        <Button size="sm" loading={busy} onClick={() => void decide(mechanic.userId, 'VERIFIED')}>
                          Verify
                        </Button>
                        <Button size="sm" variant="secondary" onClick={() => void decide(mechanic.userId, 'REJECTED')}>
                          Reject
                        </Button>
                      </div>
                    </Td>
                  </Tr>
                ))}
              </Tbody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Recent audit activity</CardTitle>
          <Link href="/admin/users" className="text-xs font-medium text-brand-700 hover:underline">
            Manage users
          </Link>
        </CardHeader>
        <CardContent className="space-y-2">
          {audit.length === 0 ? (
            <p className="text-sm text-slate-500">No audit entries yet.</p>
          ) : (
            audit.map((entry) => (
              <div key={entry.id} className="flex items-center justify-between gap-3 text-sm">
                <span className={cn('truncate', 'text-slate-700')}>
                  <strong>{entry.action}</strong>
                  {entry.entityType ? ` · ${entry.entityType}` : ''}
                  {entry.actorName ? ` · ${entry.actorName}` : ''}
                </span>
                <span className="shrink-0 text-xs text-slate-400">{formatDateTime(entry.createdAt)}</span>
              </div>
            ))
          )}
        </CardContent>
      </Card>
    </div>
  );
}
