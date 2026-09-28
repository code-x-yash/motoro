'use client';

import { useEffect, useState } from 'react';
import { Alert, Badge, Button, Card, CardContent, Field, Input, LoadingState, Modal, Select, Table, Tbody, Td, Th, Thead, Tr } from '@rr/ui';
import { AppShell } from '@/components/app-shell';
import { apiGet, apiPost, errorMessage } from '@/lib/api';
import { formatDateTime } from '@/lib/format';

interface AdminUser {
  id: string;
  role: string;
  email: string;
  phone: string | null;
  fullName: string;
  status: string;
  createdAt: string;
  lastLoginAt: string | null;
}

const ROLES = ['', 'DRIVER', 'MECHANIC', 'WORKSHOP', 'TOWING_PARTNER', 'OPERATIONS', 'ADMIN'];

export default function AdminUsersPage() {
  return (
    <AppShell roles={['ADMIN']}>
      <AdminUsers />
    </AppShell>
  );
}

function AdminUsers() {
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [role, setRole] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [target, setTarget] = useState<AdminUser | null>(null);
  const [reason, setReason] = useState('');

  const load = async () => {
    setLoading(true);
    try {
      const data = await apiGet<{ items: AdminUser[] }>('/api/admin/users', {
        query: { limit: 100, ...(role ? { role } : {}) },
      });
      setUsers(data.items);
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, [role]);

  const toggleSuspend = async () => {
    if (!target) return;
    setBusy(true);
    try {
      await apiPost(`/api/admin/users/${target.id}/suspend`, {
        suspend: target.status !== 'SUSPENDED',
        reason: reason.trim() || 'Administrative action',
      });
      setTarget(null);
      setReason('');
      await load();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="page-title">Users</h1>
          <p className="page-subtitle">Suspend, reinstate and inspect every account.</p>
        </div>
        <Field label="Filter by role" className="w-52">
          <Select value={role} onChange={(event) => setRole(event.target.value)}>
            {ROLES.map((value) => (
              <option key={value} value={value}>
                {value || 'All roles'}
              </option>
            ))}
          </Select>
        </Field>
      </div>

      {error ? <Alert tone="danger">{error}</Alert> : null}

      <Card>
        <CardContent className="p-0">
          {loading ? (
            <LoadingState />
          ) : (
            <Table>
              <Thead>
                <Tr>
                  <Th>User</Th>
                  <Th>Role</Th>
                  <Th>Status</Th>
                  <Th>Created</Th>
                  <Th>Last login</Th>
                  <Th className="text-right">Actions</Th>
                </Tr>
              </Thead>
              <Tbody>
                {users.map((user) => (
                  <Tr key={user.id}>
                    <Td>
                      <p className="font-medium text-slate-900">{user.fullName}</p>
                      <p className="text-xs text-slate-400">
                        {user.email}
                        {user.phone ? ` · ${user.phone}` : ''}
                      </p>
                    </Td>
                    <Td>
                      <Badge tone="blue">{user.role}</Badge>
                    </Td>
                    <Td>
                      <Badge tone={user.status === 'ACTIVE' ? 'emerald' : 'rose'}>{user.status}</Badge>
                    </Td>
                    <Td>{formatDateTime(user.createdAt)}</Td>
                    <Td>{user.lastLoginAt ? formatDateTime(user.lastLoginAt) : 'Never'}</Td>
                    <Td className="text-right">
                      <Button size="sm" variant={user.status === 'SUSPENDED' ? 'secondary' : 'danger'} onClick={() => setTarget(user)}>
                        {user.status === 'SUSPENDED' ? 'Reinstate' : 'Suspend'}
                      </Button>
                    </Td>
                  </Tr>
                ))}
              </Tbody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Modal
        open={Boolean(target)}
        onClose={() => setTarget(null)}
        title={target?.status === 'SUSPENDED' ? 'Reinstate account' : 'Suspend account'}
        footer={
          <>
            <Button variant="secondary" onClick={() => setTarget(null)}>
              Cancel
            </Button>
            <Button variant="danger" loading={busy} onClick={() => void toggleSuspend()}>
              Confirm
            </Button>
          </>
        }
      >
        <p className="text-sm text-slate-600">
          {target ? `${target.fullName} (${target.email})` : ''}
        </p>
        <Field label="Reason" className="mt-3">
          <Input value={reason} onChange={(event) => setReason(event.target.value)} placeholder="Policy violation, request from ops…" />
        </Field>
      </Modal>
    </div>
  );
}
