'use client';

import Link from 'next/link';
import { useEffect, useState, type FormEvent } from 'react';
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
  Input,
  LoadingState,
  Stat,
  Table,
  Tbody,
  Td,
  Th,
  Thead,
  Tr,
} from '@rr/ui';
import { Wallet } from 'lucide-react';
import { AppShell } from '@/components/app-shell';
import { api, apiGet, apiPost, errorMessage } from '@/lib/api';
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

interface PayoutBalance {
  lifetimeCents: number;
  paidOutCents: number;
  pendingPayoutCents: number;
  availableCents: number;
}

interface PayoutAccount {
  accountHolder: string;
  accountNumber: string;
  ifsc: string;
  bankName?: string;
}

interface PayoutRow {
  id: string;
  amountCents: number;
  status: 'PENDING' | 'PAID' | 'REJECTED';
  note: string | null;
  decidedAt: string | null;
  createdAt: string;
}

const PAYOUT_TONE: Record<PayoutRow['status'], 'amber' | 'emerald' | 'rose'> = {
  PENDING: 'amber',
  PAID: 'emerald',
  REJECTED: 'rose',
};

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
  const [balance, setBalance] = useState<PayoutBalance | null>(null);
  const [payouts, setPayouts] = useState<PayoutRow[]>([]);
  const [account, setAccount] = useState<PayoutAccount | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [accountHolder, setAccountHolder] = useState('');
  const [accountNumber, setAccountNumber] = useState('');
  const [ifsc, setIfsc] = useState('');
  const [bankName, setBankName] = useState('');
  const [payoutRupees, setPayoutRupees] = useState('');
  const [busy, setBusy] = useState<'account' | 'payout' | null>(null);

  const refreshPayoutState = async () => {
    const [bal, list] = await Promise.all([
      apiGet<{ balance: PayoutBalance }>('/api/mechanics/me/balance').catch(() => null),
      apiGet<{ items: PayoutRow[] }>('/api/mechanics/me/payouts').catch(() => ({ items: [] as PayoutRow[] })),
    ]);
    if (bal) setBalance(bal.balance);
    setPayouts(list.items ?? []);
  };

  useEffect(() => {
    void (async () => {
      try {
        const [earnings, acct] = await Promise.all([
          apiGet<EarningsResponse>('/api/mechanics/me/earnings'),
          apiGet<{ account: PayoutAccount | null }>('/api/mechanics/me/payout-account').catch(() => ({ account: null })),
        ]);
        setRows(earnings.items ?? []);
        setTotalCents(
          earnings.totalCents ?? (earnings.items ?? []).reduce((sum, row) => sum + row.earningsCents, 0),
        );
        if (acct.account) {
          setAccount(acct.account);
          setAccountHolder(acct.account.accountHolder ?? '');
          setAccountNumber(acct.account.accountNumber ?? '');
          setIfsc(acct.account.ifsc ?? '');
          setBankName(acct.account.bankName ?? '');
        }
        await refreshPayoutState();
      } catch (err) {
        setError(errorMessage(err));
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const saveAccount = async (event: FormEvent) => {
    event.preventDefault();
    setBusy('account');
    setNotice(null);
    setError(null);
    try {
      const data = await api<{ account: PayoutAccount }>('/api/mechanics/me/payout-account', {
        method: 'PUT',
        body: { accountHolder, accountNumber, ifsc: ifsc.toUpperCase(), bankName: bankName || undefined },
      });
      setAccount(data.account);
      setNotice('Payout account saved.');
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  const requestPayout = async (event: FormEvent) => {
    event.preventDefault();
    const rupees = Number.parseFloat(payoutRupees);
    if (!Number.isFinite(rupees) || rupees <= 0) {
      setError('Enter a valid amount.');
      return;
    }
    setBusy('payout');
    setNotice(null);
    setError(null);
    try {
      await apiPost('/api/mechanics/me/payouts', { amountCents: Math.round(rupees * 100) });
      setPayoutRupees('');
      setNotice('Payout requested — operations will review it shortly.');
      await refreshPayoutState();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  if (loading) return <LoadingState label="Loading earnings…" />;

  const thisMonth = rows
    .filter((row) => row.completedAt && new Date(row.completedAt).getMonth() === new Date().getMonth())
    .reduce((sum, row) => sum + row.earningsCents, 0);
  const available = balance?.availableCents ?? 0;

  return (
    <div className="space-y-5">
      <div>
        <h1 className="page-title">Earnings</h1>
        <p className="page-subtitle">Credited to your account when the customer&apos;s payment settles.</p>
      </div>

      {error ? <Alert tone="danger">{error}</Alert> : null}
      {notice ? <Alert tone="success">{notice}</Alert> : null}

      <div className="grid-stat">
        <Stat label="Lifetime" value={formatINR(totalCents)} tone="emerald" />
        <Stat label="This month" value={formatINR(thisMonth)} tone="blue" />
        <Stat label="Paid jobs" value={String(rows.length)} />
        <Stat label="Avg per job" value={formatINR(rows.length ? Math.round(totalCents / rows.length) : 0)} />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Payouts</CardTitle>
          <span className="text-xs text-slate-500">
            Withdraw your settled earnings to your bank account. Payouts are processed weekly to your registered
            account.
          </span>
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="grid-stat">
            <Stat label="Available" value={formatINR(available)} tone="emerald" />
            <Stat label="Pending" value={formatINR(balance?.pendingPayoutCents ?? 0)} tone="blue" />
            <Stat label="Paid out" value={formatINR(balance?.paidOutCents ?? 0)} />
          </div>

          <div className="grid gap-5 lg:grid-cols-2">
            <form onSubmit={saveAccount} className="space-y-3 rounded-xl border border-slate-200 p-4">
              <p className="text-sm font-semibold text-slate-700">
                Bank account {account ? <Badge tone="emerald">Saved</Badge> : <Badge tone="amber">Required</Badge>}
              </p>
              <Field label="Account holder">
                <Input
                  value={accountHolder}
                  onChange={(e) => setAccountHolder(e.target.value)}
                  placeholder="Full name as on bank records"
                  required
                />
              </Field>
              <Field label="Account number">
                <Input
                  value={accountNumber}
                  onChange={(e) => setAccountNumber(e.target.value)}
                  placeholder="123456789012"
                  required
                />
              </Field>
              <div className="grid grid-cols-2 gap-3">
                <Field label="IFSC">
                  <Input
                    value={ifsc}
                    onChange={(e) => setIfsc(e.target.value.toUpperCase())}
                    placeholder="HDFC0001234"
                    required
                  />
                </Field>
                <Field label="Bank (optional)">
                  <Input value={bankName} onChange={(e) => setBankName(e.target.value)} placeholder="HDFC Bank" />
                </Field>
              </div>
              <Button type="submit" variant="secondary" disabled={busy === 'account'}>
                {busy === 'account' ? 'Saving…' : 'Save account'}
              </Button>
            </form>

            <form onSubmit={requestPayout} className="space-y-3 rounded-xl border border-slate-200 p-4">
              <p className="text-sm font-semibold text-slate-700">Request a payout</p>
              <Field label="Amount (₹)">
                <Input
                  type="number"
                  min={100}
                  step="1"
                  value={payoutRupees}
                  onChange={(e) => setPayoutRupees(e.target.value)}
                  placeholder={String(Math.floor(available / 100))}
                  required
                />
              </Field>
              <p className="text-xs text-slate-500">
                Minimum ₹100 · Available {formatINR(available)} · Requests are reviewed by operations.
              </p>
              <Button type="submit" disabled={busy === 'payout' || !account || available < 10_000}>
                {busy === 'payout' ? 'Submitting…' : 'Request payout'}
              </Button>
              {!account ? <p className="text-xs text-amber-600">Save your bank account first.</p> : null}
            </form>
          </div>

          {payouts.length > 0 ? (
            <Table>
              <Thead>
                <Tr>
                  <Th>Requested</Th>
                  <Th>Amount</Th>
                  <Th>Status</Th>
                  <Th>Decided</Th>
                </Tr>
              </Thead>
              <Tbody>
                {payouts.map((payout) => (
                  <Tr key={payout.id}>
                    <Td>{formatDateTime(payout.createdAt)}</Td>
                    <Td className="font-semibold tabular-nums">{formatINR(payout.amountCents)}</Td>
                    <Td>
                      <Badge tone={PAYOUT_TONE[payout.status]}>{payout.status}</Badge>
                      {payout.note ? <span className="ml-2 text-xs text-slate-500">{payout.note}</span> : null}
                    </Td>
                    <Td>{payout.decidedAt ? formatDateTime(payout.decidedAt) : '—'}</Td>
                  </Tr>
                ))}
              </Tbody>
            </Table>
          ) : (
            <EmptyState
              title="No payout requests yet"
              description="Request a payout above and it appears here once operations reviews it."
              className="py-6"
            />
          )}
        </CardContent>
      </Card>

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
                      <Link href={`/mechanic/jobs/detail?id=${row.jobId}`} className="font-medium text-brand-700 hover:underline">
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
