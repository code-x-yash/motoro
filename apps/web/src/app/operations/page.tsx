'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { DispatchAttemptDto, EmergencyRequestDto, OperationsDashboardDto, Paginated, RealtimeServerMessage } from '@rr/types';
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
  Modal,
  Select,
  Stat,
  StatusBadge,
  Table,
  Tabs,
  Tbody,
  Td,
  Textarea,
  Th,
  Thead,
  Tr,
  UrgencyBadge,
} from '@rr/ui';
import { Radio, ShieldAlert } from 'lucide-react';
import { AppShell } from '@/components/app-shell';
import { apiGet, apiPost, errorMessage } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useRealtime } from '@/lib/realtime';
import { formatDateTime, timeAgo, titleCase } from '@/lib/format';
import { MapPanel, type MapMarker } from '@/components/map-panel';

interface MapPoint {
  id?: string;
  userId?: string;
  reference?: string;
  status?: string;
  urgency?: string;
  latitude: number | null;
  longitude: number | null;
  address?: string | null;
}

interface MechanicRow {
  userId: string;
  fullName: string;
  status: string;
  verificationStatus: string;
  latitude: number | null;
  longitude: number | null;
  lastKnownLatitude?: number | null;
  lastKnownLongitude?: number | null;
  ratingAverage?: number;
  jobsCompleted?: number;
  activeJobs?: number;
}

interface OpsDetail {
  request: EmergencyRequestDto;
  attempts: DispatchAttemptDto[];
}

const TABS = [
  { id: 'queue', label: 'Queue' },
  { id: 'map', label: 'Live map' },
  { id: 'mechanics', label: 'Mechanics' },
  { id: 'failed', label: 'Failed dispatches' },
];

export default function OperationsPage() {
  return (
    <AppShell roles={['OPERATIONS', 'ADMIN']}>
      <OperationsConsole />
    </AppShell>
  );
}

function OperationsConsole() {
  const { user } = useAuth();
  const [dashboard, setDashboard] = useState<OperationsDashboardDto | null>(null);
  const [queue, setQueue] = useState<EmergencyRequestDto[]>([]);
  const [mapPoints, setMapPoints] = useState<MapPoint[]>([]);
  const [mechanics, setMechanics] = useState<MechanicRow[]>([]);
  const [failed, setFailed] = useState<Record<string, unknown>[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState('queue');
  const [search, setSearch] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<OpsDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const [dash, queueData, mapData, mechData, failedData] = await Promise.all([
        apiGet<OperationsDashboardDto>('/api/operations/dashboard'),
        apiGet<Paginated<EmergencyRequestDto>>('/api/operations/emergencies', {
          query: {
            status: 'CREATED,SEARCHING,DISPATCHING,ASSIGNED,MECHANIC_EN_ROUTE,MECHANIC_NEARBY,ARRIVED,DIAGNOSING,QUOTE_PENDING,QUOTE_APPROVED,REPAIRING,ESCALATED,TOWING_REQUIRED',
            limit: 50,
          },
        }),
        apiGet<{ requests: MapPoint[]; mechanics: MapPoint[] }>('/api/operations/map').catch(() => ({
          requests: [],
          mechanics: [],
        })),
        apiGet<{ items: MechanicRow[] }>('/api/operations/mechanics').catch(() => ({ items: [] })),
        apiGet<{ items: Record<string, unknown>[] }>('/api/operations/failed-dispatches').catch(() => ({
          items: [],
        })),
      ]);
      setDashboard(dash);
      setQueue(queueData.items);
      setMapPoints([...(mapData.requests ?? []), ...(mapData.mechanics ?? [])]);
      setMechanics(mechData.items);
      setFailed(failedData.items);
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 7000);
    return () => clearInterval(timer);
  }, [load]);

  const onMessage = useCallback(
    (message: RealtimeServerMessage) => {
      if (message.type === 'request.event' || message.type === 'request.state' || message.type === 'notification') {
        void load();
      }
    },
    [load],
  );

  useRealtime(user ? 'ops' : null, onMessage, { enabled: Boolean(user) });

  const openDetail = async (id: string) => {
    setSelectedId(id);
    setDetailLoading(true);
    setDetailError(null);
    try {
      setDetail(await apiGet<OpsDetail>(`/api/operations/emergencies/${id}`));
    } catch (err) {
      setDetailError(errorMessage(err));
      setDetail(null);
    } finally {
      setDetailLoading(false);
    }
  };

  const closeDetail = () => {
    setSelectedId(null);
    setDetail(null);
    setDetailError(null);
  };

  const act = async (action: string, body?: Record<string, unknown>) => {
    if (!selectedId) return;
    setBusy(true);
    setError(null);
    try {
      await apiPost(`/api/operations/emergencies/${selectedId}/${action}`, body ?? {});
      await openDetail(selectedId);
      await load();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const filteredQueue = useMemo(
    () =>
      queue.filter((item) => {
        if (!search.trim()) return true;
        const needle = search.toLowerCase();
        return (
          item.reference.toLowerCase().includes(needle) ||
          item.driverName.toLowerCase().includes(needle) ||
          (item.vehicleRegistration ?? '').toLowerCase().includes(needle)
        );
      }),
    [queue, search],
  );

  const markers = useMemo<MapMarker[]>(
    () =>
      mapPoints
        .filter((point) => typeof point.latitude === 'number' && typeof point.longitude === 'number')
        .map((point) => ({
          id: point.id ?? point.userId ?? `${point.latitude},${point.longitude}`,
          latitude: point.latitude as number,
          longitude: point.longitude as number,
          tone: point.reference ? (point.urgency === 'CRITICAL' ? 'rose' : 'amber') : 'emerald',
          label: point.reference ?? 'Mechanic',
        })),
    [mapPoints],
  );

  const mapsLink = useMemo(() => {
    const point = mapPoints.find(
      (item) => typeof item.latitude === 'number' && typeof item.longitude === 'number',
    );
    if (!point) return null;
    return `https://www.google.com/maps/search/?api=1&query=${point.latitude},${point.longitude}`;
  }, [mapPoints]);

  if (loading && !dashboard) return <LoadingState label="Connecting to command centre…" />;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="page-title">Command centre</h1>
          <p className="page-subtitle">Live queue, dispatch telemetry and manual override controls.</p>
        </div>
        <span className="inline-flex items-center gap-2 text-xs text-slate-500">
          <span className="h-2 w-2 animate-pulse rounded-full bg-emerald-500" /> auto-refresh 7s
        </span>
      </div>

      {error ? <Alert tone="danger">{error}</Alert> : null}

      <div className="grid-stat">
        <Stat label="Active" value={dashboard?.active ?? 0} tone="blue" />
        <Stat label="Searching" value={dashboard?.searching ?? 0} tone="amber" />
        <Stat label="Escalated" value={dashboard?.escalated ?? 0} tone="rose" />
        <Stat label="Delayed" value={dashboard?.delayed ?? 0} tone="amber" />
        <Stat label="Completed today" value={dashboard?.completedToday ?? 0} tone="emerald" />
        <Stat label="Mechanics online" value={dashboard?.activeMechanics ?? 0} />
        <Stat label="En route" value={dashboard?.enRoute ?? 0} tone="blue" />
        <Stat label="Towing" value={dashboard?.towing ?? 0} tone="rose" />
      </div>

      <Tabs tabs={TABS} active={tab} onChange={setTab} />

      {tab === 'queue' ? (
        <div className="space-y-4">
          <Input
            placeholder="Search reference, driver or registration…"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            className="max-w-md"
          />
          <Card>
            <CardContent className="p-0">
              {filteredQueue.length === 0 ? (
                <EmptyState title="Queue is clear" description="No active emergencies right now." />
              ) : (
                <Table>
                  <Thead>
                    <Tr>
                      <Th>Reference</Th>
                      <Th>Driver</Th>
                      <Th>Issue</Th>
                      <Th>Status</Th>
                      <Th>Created</Th>
                      <Th className="text-right">Actions</Th>
                    </Tr>
                  </Thead>
                  <Tbody>
                    {filteredQueue.map((item) => (
                      <Tr key={item.id}>
                        <Td>
                          <div className="flex items-center gap-2">
                            <span className="font-medium text-slate-900">{item.reference}</span>
                            <UrgencyBadge urgency={item.urgency} />
                          </div>
                        </Td>
                        <Td>
                          <p className="text-slate-800">{item.driverName}</p>
                          <p className="text-xs text-slate-400">{item.vehicleRegistration ?? 'None'}</p>
                        </Td>
                        <Td>{titleCase(item.issueType)}</Td>
                        <Td>
                          <StatusBadge status={item.status} />
                        </Td>
                        <Td>{timeAgo(item.createdAt)}</Td>
                        <Td className="text-right">
                          <div className="flex justify-end gap-2">
                            <Button size="sm" variant="secondary" onClick={() => void openDetail(item.id)}>
                              Manage
                            </Button>
                            <Link href={`/requests/detail?id=${item.id}`}>
                              <Button size="sm" variant="ghost">
                                Open
                              </Button>
                            </Link>
                          </div>
                        </Td>
                      </Tr>
                    ))}
                  </Tbody>
                </Table>
              )}
            </CardContent>
          </Card>

          {dashboard?.recentEscalations?.length ? (
            <Card>
              <CardHeader>
                <CardTitle>Recent escalations</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                {dashboard.recentEscalations.map((item) => (
                  <div key={item.id} className="flex items-center justify-between gap-3 rounded-lg border border-rose-100 bg-rose-50/60 px-3 py-2">
                    <div>
                      <p className="text-sm font-medium text-slate-800">{item.reference}</p>
                      <p className="text-xs text-slate-500">
                        {titleCase(item.issueType)} · level {item.escalationLevel} · {formatDateTime(item.createdAt)}
                      </p>
                    </div>
                    <Button size="sm" variant="secondary" onClick={() => void openDetail(item.id)}>
                      Handle
                    </Button>
                  </div>
                ))}
              </CardContent>
            </Card>
          ) : null}
        </div>
      ) : null}

      {tab === 'map' ? (
        <Card>
          <CardHeader>
            <CardTitle>Live operations map</CardTitle>
            <span className="text-xs text-slate-500">{markers.length} markers</span>
          </CardHeader>
          <CardContent>
            <MapPanel markers={markers} height="h-[28rem]" mapsLink={mapsLink} />
          </CardContent>
        </Card>
      ) : null}

      {tab === 'mechanics' ? (
        <Card>
          <CardContent className="p-0">
            {mechanics.length === 0 ? (
              <EmptyState title="No mechanics" description="No mechanics are registered yet." />
            ) : (
              <Table>
                <Thead>
                  <Tr>
                    <Th>Mechanic</Th>
                    <Th>Status</Th>
                    <Th>Verification</Th>
                    <Th>Active jobs</Th>
                    <Th>Location</Th>
                  </Tr>
                </Thead>
                <Tbody>
                  {mechanics.map((mechanic) => (
                    <Tr key={mechanic.userId}>
                      <Td className="font-medium text-slate-900">{mechanic.fullName}</Td>
                      <Td>
                        <Badge tone={mechanic.status === 'AVAILABLE' ? 'emerald' : 'slate'}>{titleCase(mechanic.status)}</Badge>
                      </Td>
                      <Td>
                        <Badge tone={mechanic.verificationStatus === 'VERIFIED' ? 'emerald' : 'amber'}>
                          {titleCase(mechanic.verificationStatus)}
                        </Badge>
                      </Td>
                      <Td>{mechanic.activeJobs ?? 0}</Td>
                      <Td>
                        {mechanic.lastKnownLatitude ?? mechanic.latitude
                          ? `${(mechanic.lastKnownLatitude ?? mechanic.latitude)?.toFixed(3)}, ${(mechanic.lastKnownLongitude ?? mechanic.longitude)?.toFixed(3)}`
                          : 'None'}
                      </Td>
                    </Tr>
                  ))}
                </Tbody>
              </Table>
            )}
          </CardContent>
        </Card>
      ) : null}

      {tab === 'failed' ? (
        <Card>
          <CardContent className="p-0">
            {failed.length === 0 ? (
              <EmptyState title="No failed dispatches" description="Offers are being accepted on time." />
            ) : (
              <Table>
                <Thead>
                  <Tr>
                    <Th>Reference</Th>
                    <Th>Mechanic</Th>
                    <Th>Result</Th>
                    <Th>Offered</Th>
                  </Tr>
                </Thead>
                <Tbody>
                  {failed.map((row, index) => (
                    <Tr key={String(row.id ?? index)}>
                      <Td className="font-medium">{String(row.reference ?? 'None')}</Td>
                      <Td>{String(row.mechanic_name ?? row.mechanicName ?? 'None')}</Td>
                      <Td>
                        <Badge tone="rose">{row.status ? titleCase(String(row.status)) : 'None'}</Badge>
                      </Td>
                      <Td>{row.offered_at ? formatDateTime(String(row.offered_at)) : 'None'}</Td>
                    </Tr>
                  ))}
                </Tbody>
              </Table>
            )}
          </CardContent>
        </Card>
      ) : null}

      <Modal open={Boolean(selectedId)} onClose={closeDetail} title="Emergency override" wide>
        {detailLoading ? (
          <LoadingState label="Loading request…" />
        ) : detailError || !detail ? (
          <div className="space-y-4">
            <Alert tone="danger" title="Could not load this request">
              {detailError ?? 'This request is no longer available.'}
            </Alert>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={closeDetail}>
                Close
              </Button>
              {selectedId ? (
                <Button onClick={() => void openDetail(selectedId)}>Retry</Button>
              ) : null}
            </div>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone="blue">{detail.request.reference}</Badge>
              <StatusBadge status={detail.request.status} />
              <UrgencyBadge urgency={detail.request.urgency} />
              <Badge>{titleCase(detail.request.issueType)}</Badge>
              <span className="ml-auto text-xs text-slate-500">
                Escalation level {detail.request.escalationLevel}
              </span>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="rounded-lg border border-slate-100 p-3 text-sm">
                <p className="text-xs font-medium uppercase text-slate-400">Customer</p>
                <p className="mt-1 font-medium text-slate-800">{detail.request.driverName}</p>
                <p className="text-xs text-slate-500">{detail.request.driverPhone ?? 'No phone'}</p>
                <p className="mt-2 text-xs text-slate-500">
                  {detail.request.address ?? `${detail.request.latitude.toFixed(4)}, ${detail.request.longitude.toFixed(4)}`}
                </p>
                <a
                  href={`https://www.google.com/maps/search/?api=1&query=${detail.request.latitude},${detail.request.longitude}`}
                  target="_blank"
                  rel="noreferrer"
                  className="mt-1 inline-block text-xs font-medium text-brand-700 hover:underline"
                >
                  Open in Google Maps
                </a>
                <p className="mt-2 text-xs text-slate-500">{detail.request.vehicleLabel ?? 'No vehicle'}</p>
              </div>
              <div className="rounded-lg border border-slate-100 p-3">
                <p className="text-xs font-medium uppercase text-slate-400">Dispatch attempts</p>
                <div className="mt-2 space-y-1.5">
                  {detail.attempts.length === 0 ? (
                    <p className="text-xs text-slate-500">No attempts yet.</p>
                  ) : (
                    detail.attempts.map((attempt) => (
                      <div key={attempt.id} className="flex items-center justify-between gap-2 text-xs">
                        <span className="text-slate-600">
                          #{attempt.attemptNo} {attempt.mechanicName}
                        </span>
                        <Badge
                          tone={
                            attempt.status === 'ACCEPTED'
                              ? 'emerald'
                              : attempt.status === 'PENDING'
                                ? 'amber'
                                : 'slate'
                          }
                        >
                          {titleCase(attempt.status)}
                        </Badge>
                      </div>
                    ))
                  )}
                </div>
              </div>
            </div>

            <OpsActions
              busy={busy}
              mechanics={mechanics}
              onAssign={(mechanicUserId, mode) =>
                act(mode === 'assign' ? 'assign' : 'reassign', { mechanicUserId })
              }
              onEscalate={(reason) => act('escalate', { reason })}
              onNote={(note) => act('note', { note })}
              onCancel={(reason) => act('cancel', { reason })}
              requestId={detail.request.id}
            />
          </div>
        )}
      </Modal>
    </div>
  );
}

function OpsActions({
  busy,
  mechanics,
  onAssign,
  onEscalate,
  onNote,
  onCancel,
  requestId,
}: {
  busy: boolean;
  mechanics: MechanicRow[];
  onAssign: (mechanicUserId: string, mode: 'assign' | 'reassign') => void;
  onEscalate: (reason: string) => void;
  onNote: (note: string) => void;
  onCancel: (reason: string) => void;
  requestId: string;
}) {
  const [mechanicUserId, setMechanicUserId] = useState('');
  const [note, setNote] = useState('');
  const [reason, setReason] = useState('');

  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <Card>
          <CardContent className="space-y-2">
            <p className="text-xs font-medium uppercase text-slate-400">Assign / reassign mechanic</p>
            <Select value={mechanicUserId} onChange={(event) => setMechanicUserId(event.target.value)}>
              <option value="">Select a verified mechanic…</option>
              {mechanics
                .filter((mechanic) => mechanic.verificationStatus === 'VERIFIED')
                .map((mechanic) => (
                  <option key={mechanic.userId} value={mechanic.userId}>
                    {mechanic.fullName} · {titleCase(mechanic.status)}
                  </option>
                ))}
            </Select>
            <div className="flex gap-2">
              <Button size="sm" disabled={!mechanicUserId || busy} onClick={() => onAssign(mechanicUserId, 'assign')}>
                Assign now
              </Button>
              <Button
                size="sm"
                variant="secondary"
                disabled={!mechanicUserId || busy}
                onClick={() => onAssign(mechanicUserId, 'reassign')}
              >
                Reassign
              </Button>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="space-y-2">
            <p className="text-xs font-medium uppercase text-slate-400">Internal note</p>
            <Textarea value={note} onChange={(event) => setNote(event.target.value)} placeholder="Called customer, waiting for tow…" />
            <Button size="sm" disabled={!note.trim() || busy} onClick={() => { onNote(note.trim()); setNote(''); }}>
              Add note
            </Button>
          </CardContent>
        </Card>
      </div>

      <div className="flex flex-wrap items-end gap-2">
        <Field label="Escalation reason" className="flex-1">
          <Input
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder="No mechanic accepted within radius"
          />
        </Field>
        <Button
          variant="danger"
          disabled={!reason.trim() || busy}
          onClick={() => {
            onCancel(reason.trim());
            setReason('');
          }}
        >
          <ShieldAlert className="h-4 w-4" /> Cancel request
        </Button>
        <Button
          variant="secondary"
          disabled={!reason.trim() || busy}
          onClick={() => {
            onEscalate(reason.trim());
            setReason('');
          }}
        >
          <Radio className="h-4 w-4" /> Escalate
        </Button>
        <Link href={`/requests/detail?id=${requestId}`}>
          <Button variant="ghost">Full session</Button>
        </Link>
      </div>
    </div>
  );
}
