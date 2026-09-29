'use client';

import { useEffect, useState } from 'react';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Field,
  Input,
  LoadingState,
  Modal,
  Table,
  Tbody,
  Td,
  Th,
  Thead,
  Tr,
} from '@rr/ui';
import { AppShell } from '@/components/app-shell';
import { apiGet, apiPost, errorMessage } from '@/lib/api';
import { formatDateTime, formatINR } from '@/lib/format';

interface AdminPayment {
  id: string;
  requestId: string;
  reference: string;
  driverName: string;
  provider: string;
  status: string;
  amountCents: number;
  method: string | null;
  couponCode: string | null;
  refundedAt: string | null;
  refundReason: string | null;
  refundedCents?: number;
  paidAt: string | null;
  createdAt: string;
}

interface AdminPayout {
  id: string;
  mechanicName: string;
  mechanicEmail: string;
  amountCents: number;
  status: 'PENDING' | 'PAID' | 'REJECTED';
  account: { accountHolder?: string; accountNumber?: string; ifsc?: string; bankName?: string } | null;
  note: string | null;
  decidedAt: string | null;
  createdAt: string;
}

const PAYMENT_TONE: Record<string, 'emerald' | 'rose' | 'amber' | 'slate'> = {
  PAID: 'emerald',
  REFUNDED: 'rose',
  PENDING: 'amber',
  AUTHORIZED: 'amber',
  FAILED: 'rose',
};

const PAYOUT_TONE: Record<AdminPayout['status'], 'amber' | 'emerald' | 'rose'> = {
  PENDING: 'amber',
  PAID: 'emerald',
  REJECTED: 'rose',
};

export default function AdminPaymentsPage() {
  return (
    <AppShell roles={['ADMIN']}>
      <AdminPayments />
    </AppShell>
  );
}

function AdminPayments() {
  const [payments, setPayments] = useState<AdminPayment[]>([]);
  const [payouts, setPayouts] = useState<AdminPayout[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [refundTarget, setRefundTarget] = useState<AdminPayment | null>(null);
  const [refundReason, setRefundReason] = useState('');
  const [refundAmount, setRefundAmount] = useState('');

  const load = async () => {
    try {
      const [pay, payout] = await Promise.all([
        apiGet<{ items: AdminPayment[] }>('/api/admin/payments'),
        apiGet<{ items: AdminPayout[] }>('/api/admin/payouts'),
      ]);
      setPayments(pay.items ?? []);
      setPayouts(payout.items ?? []);
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

  const issueRefund = async () => {
    if (!refundTarget) return;
    setBusy(true);
    setError(null);
    try {
      const body: { reason: string; amountCents?: number } = {
        reason: refundReason.trim() || 'Issued by admin',
      };
      const rupees = refundAmount.trim() ? Number(refundAmount) : NaN;
      if (refundAmount.trim()) {
        if (!Number.isInteger(rupees) || rupees <= 0) {
          throw new Error('Enter the refund amount as a whole number of rupees.');
        }
        body.amountCents = rupees * 100;
      }
      await apiPost(`/api/admin/payments/${refundTarget.id}/refund`, body);
      const partial = body.amountCents !== undefined && body.amountCents < refundTarget.amountCents;
      setRefundTarget(null);
      setRefundReason('');
      setRefundAmount('');
      setNotice(
        partial
          ? `Refund of ${formatINR(body.amountCents ?? 0)} issued for ${refundTarget.reference} (partial).`
          : `Refund of ${formatINR(refundTarget.amountCents)} issued for ${refundTarget.reference}.`,
      );
      await load();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const decidePayout = async (payout: AdminPayout, decision: 'PAID' | 'REJECTED') => {
    setBusy(true);
    setError(null);
    try {
      await apiPost(`/api/admin/payouts/${payout.id}/decide`, { decision });
      setNotice(
        decision === 'PAID'
          ? `Marked ${formatINR(payout.amountCents)} as paid to ${payout.mechanicName}.`
          : `Rejected ${payout.mechanicName}'s payout.`,
      );
      await load();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  if (loading) return <LoadingState label="Loading payments…" />;

  const pendingPayouts = payouts.filter((p) => p.status === 'PENDING');

  return (
    <div className="space-y-5">
      <div>
        <h1 className="page-title">Payments & payouts</h1>
        <p className="page-subtitle">Issue refunds and settle mechanic withdrawal requests.</p>
      </div>

      {error ? <Alert tone="danger">{error}</Alert> : null}
      {notice ? <Alert tone="success">{notice}</Alert> : null}

      <Card>
        <CardHeader>
          <CardTitle>Payout requests</CardTitle>
          <span className="text-xs text-slate-500">{pendingPayouts.length} awaiting decision</span>
        </CardHeader>
        <CardContent className="p-0">
          {payouts.length === 0 ? (
            <p className="px-4 py-6 text-sm text-slate-500">No payout requests yet.</p>
          ) : (
            <Table>
              <Thead>
                <Tr>
                  <Th>Mechanic</Th>
                  <Th>Account</Th>
                  <Th>Requested</Th>
                  <Th>Amount</Th>
                  <Th>Status</Th>
                  <Th className="text-right">Actions</Th>
                </Tr>
              </Thead>
              <Tbody>
                {payouts.map((payout) => (
                  <Tr key={payout.id}>
                    <Td>
                      <div className="font-medium text-slate-800">{payout.mechanicName}</div>
                      <div className="text-xs text-slate-500">{payout.mechanicEmail}</div>
                    </Td>
                    <Td className="text-xs text-slate-600">
                      {payout.account?.accountHolder ?? '—'}
                      <br />
                      {payout.account?.accountNumber ?? ''} · {payout.account?.ifsc ?? ''}
                    </Td>
                    <Td>{formatDateTime(payout.createdAt)}</Td>
                    <Td className="font-semibold tabular-nums">{formatINR(payout.amountCents)}</Td>
                    <Td>
                      <Badge tone={PAYOUT_TONE[payout.status]}>{payout.status}</Badge>
                      {payout.decidedAt ? (
                        <div className="mt-0.5 text-xs text-slate-400">{formatDateTime(payout.decidedAt)}</div>
                      ) : null}
                    </Td>
                    <Td className="text-right">
                      {payout.status === 'PENDING' ? (
                        <div className="flex justify-end gap-2">
                          <Button size="sm" disabled={busy} onClick={() => void decidePayout(payout, 'PAID')}>
                            Mark paid
                          </Button>
                          <Button
                            size="sm"
                            variant="danger"
                            disabled={busy}
                            onClick={() => void decidePayout(payout, 'REJECTED')}
                          >
                            Reject
                          </Button>
                        </div>
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

      <Card>
        <CardHeader>
          <CardTitle>Recent payments</CardTitle>
          <span className="text-xs text-slate-500">{payments.length} newest</span>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <Thead>
              <Tr>
                <Th>Reference</Th>
                <Th>Driver</Th>
                <Th>Method</Th>
                <Th>Amount</Th>
                <Th>Status</Th>
                <Th className="text-right">Actions</Th>
              </Tr>
            </Thead>
            <Tbody>
              {payments.map((payment) => (
                <Tr key={payment.id}>
                  <Td className="font-medium text-slate-800">{payment.reference}</Td>
                  <Td>{payment.driverName}</Td>
                  <Td>
                    <Badge>{payment.provider}{payment.method ? ` · ${payment.method}` : ''}</Badge>
                    {payment.couponCode ? (
                      <div className="mt-0.5 text-xs text-slate-500">Coupon {payment.couponCode}</div>
                    ) : null}
                  </Td>
                  <Td className="font-semibold tabular-nums">{formatINR(payment.amountCents)}</Td>
                  <Td>
                    <Badge tone={PAYMENT_TONE[payment.status] ?? 'slate'}>{payment.status}</Badge>
                    {(payment.refundedCents ?? 0) > 0 ? (
                      <div className="mt-0.5 text-xs text-rose-600">
                        {formatINR(payment.refundedCents ?? 0)} refunded
                        {payment.refundedAt ? ` · ${formatDateTime(payment.refundedAt)}` : ''}
                        {payment.refundReason ? ` · ${payment.refundReason}` : ''}
                      </div>
                    ) : payment.refundedAt ? (
                      <div className="mt-0.5 text-xs text-slate-400">
                        {formatDateTime(payment.refundedAt)}
                        {payment.refundReason ? ` · ${payment.refundReason}` : ''}
                      </div>
                    ) : null}
                  </Td>
                  <Td className="text-right">
                    {payment.status === 'PAID' && (payment.refundedCents ?? 0) < payment.amountCents ? (
                      <Button
                        size="sm"
                        variant="danger"
                        disabled={busy}
                        onClick={() => {
                          setRefundTarget(payment);
                          setRefundReason('');
                          setRefundAmount('');
                        }}
                      >
                        Refund
                      </Button>
                    ) : (
                      <span className="text-xs text-slate-400">—</span>
                    )}
                  </Td>
                </Tr>
              ))}
            </Tbody>
          </Table>
        </CardContent>
      </Card>

      <Modal
        open={Boolean(refundTarget)}
        onClose={() => setRefundTarget(null)}
        title={`Refund ${refundTarget?.reference ?? ''}`}
        footer={
          <div className="flex justify-end gap-2">
            <Button variant="ghost" disabled={busy} onClick={() => setRefundTarget(null)}>
              Cancel
            </Button>
            <Button variant="danger" disabled={busy} onClick={() => void issueRefund()}>
              {busy ? 'Refunding…' : 'Issue refund'}
            </Button>
          </div>
        }
      >
        <div className="space-y-3">
          <p className="text-sm text-slate-600">
            {refundTarget
              ? `Refund up to ${formatINR(refundTarget.amountCents - (refundTarget.refundedCents ?? 0))} to ${refundTarget.driverName}.`
              : ''}
          </p>
          <Field
            label="Amount (₹, optional)"
            hint="Leave empty for a full refund; enter a whole number for a partial refund."
          >
            <Input
              type="number"
              min={1}
              max={refundTarget ? Math.floor((refundTarget.amountCents - (refundTarget.refundedCents ?? 0)) / 100) : undefined}
              value={refundAmount}
              onChange={(e) => setRefundAmount(e.target.value)}
              placeholder="Full amount"
            />
          </Field>
          <Field label="Reason (optional)" hint="Shown to the driver and in the audit log.">
            <Input
              value={refundReason}
              onChange={(e) => setRefundReason(e.target.value)}
              placeholder="Service not delivered"
            />
          </Field>
        </div>
      </Modal>
    </div>
  );
}
