'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  EmptyState,
  Field,
  LoadingState,
  Modal,
  Table,
  Tbody,
  Td,
  Th,
  Thead,
  Textarea,
  Tr,
} from '@rr/ui';
import { AppShell } from '@/components/app-shell';
import { apiGet, apiPost, errorMessage } from '@/lib/api';
import { formatDateTime } from '@/lib/format';

interface AdminDispute {
  id: string;
  requestId: string;
  reference: string;
  raisedBy: string;
  raisedByName: string;
  category: string;
  reason: string;
  status: 'OPEN' | 'IN_REVIEW' | 'RESOLVED';
  resolution: string | null;
  createdAt: string;
}

const STATUS_TONE: Record<AdminDispute['status'], 'amber' | 'blue' | 'emerald'> = {
  OPEN: 'amber',
  IN_REVIEW: 'blue',
  RESOLVED: 'emerald',
};

export default function AdminDisputesPage() {
  return (
    <AppShell roles={['ADMIN']}>
      <AdminDisputes />
    </AppShell>
  );
}

function AdminDisputes() {
  const [disputes, setDisputes] = useState<AdminDispute[]>([]);
  const [filter, setFilter] = useState<'ALL' | 'OPEN' | 'RESOLVED'>('ALL');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [resolveTarget, setResolveTarget] = useState<AdminDispute | null>(null);
  const [resolution, setResolution] = useState('');

  const load = async () => {
    try {
      const data = await apiGet<{ items: AdminDispute[] }>('/api/admin/disputes');
      setDisputes(data.items ?? []);
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

  const visible = useMemo(() => {
    if (filter === 'ALL') return disputes;
    if (filter === 'OPEN') return disputes.filter((d) => d.status !== 'RESOLVED');
    return disputes.filter((d) => d.status === 'RESOLVED');
  }, [disputes, filter]);

  const openCount = disputes.filter((d) => d.status !== 'RESOLVED').length;

  const resolveDispute = async () => {
    if (!resolveTarget || !resolution.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await apiPost(`/api/admin/disputes/${resolveTarget.id}/resolve`, { resolution: resolution.trim() });
      setResolveTarget(null);
      setResolution('');
      setNotice(`Dispute on ${resolveTarget.reference} resolved — the customer has been notified.`);
      await load();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  if (loading) return <LoadingState label="Loading disputes…" />;

  return (
    <div className="space-y-5">
      <div>
        <h1 className="page-title">Disputes</h1>
        <p className="page-subtitle">Review customer and mechanic escalations, then close them with a resolution.</p>
      </div>

      {error ? <Alert tone="danger">{error}</Alert> : null}
      {notice ? <Alert tone="success">{notice}</Alert> : null}

      <Card>
        <CardHeader>
          <CardTitle>All disputes</CardTitle>
          <div className="flex items-center gap-2">
            {(['ALL', 'OPEN', 'RESOLVED'] as const).map((value) => (
              <button
                key={value}
                type="button"
                onClick={() => setFilter(value)}
                className={
                  filter === value
                    ? 'rounded-lg bg-brand-600 px-3 py-1 text-xs font-semibold text-white'
                    : 'rounded-lg border border-slate-200 px-3 py-1 text-xs font-medium text-slate-600 hover:bg-slate-100'
                }
              >
                {value === 'ALL' ? 'All' : value === 'OPEN' ? `Open (${openCount})` : 'Resolved'}
              </button>
            ))}
          </div>
        </CardHeader>
        <CardContent className="p-0">
          {visible.length === 0 ? (
            <EmptyState
              title={filter === 'RESOLVED' ? 'No resolved disputes' : 'No disputes'}
              description={
                filter === 'OPEN'
                  ? 'Nothing needs review right now.'
                  : 'Disputes raised by drivers or mechanics appear here.'
              }
            />
          ) : (
            <Table>
              <Thead>
                <Tr>
                  <Th>Request</Th>
                  <Th>Raised by</Th>
                  <Th>Category</Th>
                  <Th>Reason</Th>
                  <Th>Status</Th>
                  <Th className="text-right">Actions</Th>
                </Tr>
              </Thead>
              <Tbody>
                {visible.map((dispute) => (
                  <Tr key={dispute.id}>
                    <Td>
                      <p className="font-medium text-slate-900">{dispute.reference}</p>
                      <p className="text-xs text-slate-400">{formatDateTime(dispute.createdAt)}</p>
                    </Td>
                    <Td>
                      <p className="text-sm text-slate-700">{dispute.raisedByName}</p>
                    </Td>
                    <Td>
                      <Badge>{dispute.category.replace(/_/g, ' ')}</Badge>
                    </Td>
                    <Td className="max-w-xs">
                      <p className="truncate text-sm text-slate-600" title={dispute.reason}>
                        {dispute.reason}
                      </p>
                      {dispute.resolution ? (
                        <p className="mt-0.5 truncate text-xs text-emerald-700" title={dispute.resolution}>
                          ↳ {dispute.resolution}
                        </p>
                      ) : null}
                    </Td>
                    <Td>
                      <Badge tone={STATUS_TONE[dispute.status]}>{dispute.status}</Badge>
                    </Td>
                    <Td className="text-right">
                      {dispute.status !== 'RESOLVED' ? (
                        <Button
                          size="sm"
                          disabled={busy}
                          onClick={() => {
                            setResolveTarget(dispute);
                            setResolution('');
                          }}
                        >
                          Resolve
                        </Button>
                      ) : (
                        <span className="text-xs text-slate-400">—</span>
                      )}
                    </Td>
                  </Tr>
                ))}
              </Tbody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Modal
        open={Boolean(resolveTarget)}
        onClose={() => setResolveTarget(null)}
        title={`Resolve dispute · ${resolveTarget?.reference ?? ''}`}
        footer={
          <div className="flex justify-end gap-2">
            <Button variant="ghost" disabled={busy} onClick={() => setResolveTarget(null)}>
              Cancel
            </Button>
            <Button disabled={busy || !resolution.trim()} onClick={() => void resolveDispute()}>
              {busy ? 'Resolving…' : 'Resolve dispute'}
            </Button>
          </div>
        }
      >
        <div className="space-y-3">
          <p className="text-sm text-slate-600">
            <span className="font-medium text-slate-800">{resolveTarget?.raisedByName}</span> reported:{' '}
            {resolveTarget?.reason}
          </p>
          <Field
            label="Resolution"
            hint="The customer sees this on their request and in their notifications."
          >
            <Textarea
              value={resolution}
              onChange={(e) => setResolution(e.target.value)}
              rows={4}
              placeholder="Reviewed the service report — partial credit issued."
            />
          </Field>
        </div>
      </Modal>
    </div>
  );
}
