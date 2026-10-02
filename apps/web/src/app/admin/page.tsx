'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import type { AuditLogDto, Paginated } from '@rr/types';
import { Alert, Badge, Button, Card, CardContent, CardHeader, CardTitle, EmptyState, LoadingState, Stat, Table, Tbody, Td, Th, Thead, Tr } from '@rr/ui';
import { ShieldCheck, Users } from 'lucide-react';
import { AppShell } from '@/components/app-shell';
import { apiGet, apiPost, errorMessage } from '@/lib/api';
import { formatDateTime, formatINR, timeAgo, titleCase } from '@/lib/format';

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

const AUDIT_ACTOR_FALLBACK: Record<string, string> = {
  DRIVER: 'A driver',
  MECHANIC: 'A mechanic',
  WORKSHOP: 'A workshop',
  TOWING_PARTNER: 'A towing partner',
  OPERATIONS: 'Operations',
  ADMIN: 'Admin',
  SYSTEM: 'System',
};

const AUDIT_ACTION_LABELS: Record<string, string> = {
  LOGIN_SUCCESS: 'signed in',
  LOGIN_FAILED: 'sign-in failed',
  USER_REGISTERED: 'created an account',
  PASSWORD_RESET: 'reset a password',
  PROFILE_UPDATED: 'updated their profile',
  VEHICLE_CREATED: 'added a vehicle',
  NOTIFICATION_PREFERENCES_UPDATED: 'updated notification preferences',
  VERIFICATION_SUBMITTED: 'submitted verification documents',
  EMERGENCY_CREATED: 'raised a request',
  EMERGENCY_CANCELLED: 'cancelled a request',
  EMERGENCY_ESCALATED: 'escalated a request',
  OPS_ASSIGN: 'assigned a request',
  OPS_REASSIGN: 'reassigned a request',
  OPS_CANCEL: 'cancelled an assignment',
  OPS_ESCALATE: 'escalated a request',
  OPS_NOTE: 'added an operations note',
  DISPATCH_ACCEPTED: 'accepted a dispatch',
  DISPATCH_DECLINED: 'declined a dispatch',
  JOB_ARRIVED: 'arrived at a job',
  JOB_COMPLETED: 'completed a job',
  JOB_OTP_VERIFIED: 'verified arrival with OTP',
  JOB_CANCELLED_REASSIGNED: 'cancelled a job for reassignment',
  QUOTE_APPROVED: 'approved a quote',
  PAYMENT_SETTLED: 'settled a payment',
  PAYMENT_REFUNDED: 'issued a refund',
  PAYOUT_REQUESTED: 'requested a payout',
  PAYOUT_ACCOUNT_SAVED: 'saved a payout account',
  DISPUTE_RAISED: 'raised a dispute',
  DISPUTE_RESOLVED: 'resolved a dispute',
  REVIEW_CREATED: 'left a review',
  MECHANIC_STATUS_CHANGED: 'changed availability',
  MECHANIC_VERIFICATION_DECISION: 'decided a verification',
  WORKSHOP_VERIFICATION_DECISION: 'decided a verification',
  TOWING_VERIFICATION_DECISION: 'decided a verification',
  CONFIG_UPDATED: 'updated platform configuration',
  PRICING_RULE_CREATED: 'added a pricing rule',
  PRICING_RULE_UPDATED: 'updated a pricing rule',
  PRICING_RULE_DELETED: 'deleted a pricing rule',
  COUPON_CREATED: 'created a coupon',
  COUPON_TOGGLED: 'toggled a coupon',
  created: 'created a record',
  decided: 'made a decision',
};

function auditEntryText(entry: AuditLogDto): { actor: string; action: string } {
  const actor = entry.actorName ?? (entry.actorRole ? AUDIT_ACTOR_FALLBACK[entry.actorRole] ?? titleCase(entry.actorRole) : 'System');
  const action = AUDIT_ACTION_LABELS[entry.action] ?? titleCase(entry.action).toLowerCase();
  return { actor, action };
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
        <Stat label="Revenue" value={formatINR(stats?.revenueCents ?? 0)} tone="emerald" />
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
                        <Button size="sm" variant="secondary" loading={busy} onClick={() => void decide(mechanic.userId, 'REJECTED')}>
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
            <EmptyState title="No audit activity yet" description="Administrative actions are recorded here as they happen." />
          ) : (
            audit.map((entry) => {
              const { actor, action } = auditEntryText(entry);
              const label = (
                <span className="truncate text-slate-700">
                  <strong className="font-semibold">{actor}</strong> {action}
                  {entry.entityReference ? <span className="text-slate-400"> · {entry.entityReference}</span> : null}
                </span>
              );
              return (
                <div key={entry.id} className="flex items-center justify-between gap-3 text-sm">
                  {entry.entityType === 'emergency_request' && entry.entityId ? (
                    <Link
                      href={`/requests/detail?id=${entry.entityId}`}
                      className="min-w-0 flex-1 truncate transition hover:text-brand-700"
                    >
                      {label}
                    </Link>
                  ) : (
                    <span className="min-w-0 flex-1 truncate">{label}</span>
                  )}
                  <span className="shrink-0 text-xs text-slate-400" title={formatDateTime(entry.createdAt)}>
                    {timeAgo(entry.createdAt)}
                  </span>
                </div>
              );
            })
          )}
        </CardContent>
      </Card>
    </div>
  );
}
