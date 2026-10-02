'use client';

import { useEffect, useState } from 'react';
import { Alert, Badge, Button, Card, CardContent, CopyButton, EmptyState, Field, Input, KeyValue, LoadingState, Modal, Select, Table, Tbody, Td, Th, Thead, Tr } from '@rr/ui';
import { AppShell } from '@/components/app-shell';
import { apiGet, apiPost, errorMessage } from '@/lib/api';
import { formatDateTime, titleCase } from '@/lib/format';

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
  const [viewTarget, setViewTarget] = useState<AdminUser | null>(null);
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
          ) : users.length === 0 ? (
            <EmptyState
              title="No users found"
              description={
                role ? 'No accounts match the selected role filter.' : 'Registered accounts appear here as soon as they sign up.'
              }
            />
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
                      <Badge tone="blue">{titleCase(user.role)}</Badge>
                    </Td>
                    <Td>
                      <Badge tone={user.status === 'ACTIVE' ? 'emerald' : 'rose'}>{titleCase(user.status)}</Badge>
                    </Td>
                    <Td>{formatDateTime(user.createdAt)}</Td>
                    <Td>{user.lastLoginAt ? formatDateTime(user.lastLoginAt) : 'Never'}</Td>
                    <Td className="text-right">
                      <div className="flex justify-end gap-2">
                        <Button size="sm" variant="secondary" onClick={() => setViewTarget(user)}>
                          View
                        </Button>
                        <Button
                          size="sm"
                          variant={user.status === 'SUSPENDED' ? 'secondary' : 'danger'}
                          onClick={() => setTarget(user)}
                        >
                          {user.status === 'SUSPENDED' ? 'Reinstate' : 'Suspend'}
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

      <Modal
        open={Boolean(viewTarget)}
        onClose={() => setViewTarget(null)}
        title="Account details"
        footer={
          <Button variant="secondary" onClick={() => setViewTarget(null)}>
            Close
          </Button>
        }
      >
        {viewTarget ? (
          <div className="divide-y divide-slate-100">
            <KeyValue label="Name" value={viewTarget.fullName} />
            <KeyValue label="Email" value={viewTarget.email} />
            <KeyValue label="Phone" value={viewTarget.phone ?? 'None'} />
            <KeyValue label="Role" value={titleCase(viewTarget.role)} />
            <KeyValue
              label="Status"
              value={<Badge tone={viewTarget.status === 'ACTIVE' ? 'emerald' : 'rose'}>{titleCase(viewTarget.status)}</Badge>}
            />
            <KeyValue label="User ID" value={<CopyButton value={viewTarget.id} label="Copy id" />} />
            <KeyValue label="Created" value={formatDateTime(viewTarget.createdAt)} />
            <KeyValue label="Last login" value={viewTarget.lastLoginAt ? formatDateTime(viewTarget.lastLoginAt) : 'Never'} />
          </div>
        ) : null}
      </Modal>
    </div>
  );
}
