'use client';

import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import type {
  EmergencyContactDto,
  EmergencyRequestDto,
  RealtimeServerMessage,
  TimelineEventDto,
} from '@rr/types';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Field,
  LoadingState,
  Modal,
  Rating,
  StatusBadge,
  Textarea,
  UrgencyBadge,
  cn,
} from '@rr/ui';
import { Check, Clock, MapPin, Navigation, Share2, ShieldAlert, XCircle } from 'lucide-react';
import { apiGet, apiPost, errorMessage } from '@/lib/api';
import { useRealtime } from '@/lib/realtime';
import { formatDateTime, formatINR, titleCase } from '@/lib/format';
import { PROGRESS_STEPS, progressStepIndex } from '@/lib/progress';
import { MapPanel, type MapMarker, type MapRouteInfo } from '@/components/map-panel';

export function RequestSession({ requestId }: { requestId: string }) {
  const [request, setRequest] = useState<EmergencyRequestDto | null>(null);
  const [timeline, setTimeline] = useState<TimelineEventDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [liveMarker, setLiveMarker] = useState<{ latitude: number; longitude: number; role: string } | null>(null);
  const [routeInfo, setRouteInfo] = useState<MapRouteInfo | null>(null);
  const [otpCopied, setOtpCopied] = useState(false);

  const [cancelOpen, setCancelOpen] = useState(false);
  const [cancelReason, setCancelReason] = useState('');
  const [shareOpen, setShareOpen] = useState(false);
  const [contacts, setContacts] = useState<EmergencyContactDto[]>([]);
  const [selectedContacts, setSelectedContacts] = useState<string[]>([]);
  const [reviewOpen, setReviewOpen] = useState(false);

  useEffect(() => {
    if (!shareOpen) return;
    void apiGet<{ items: EmergencyContactDto[] }>('/api/me/emergency-contacts')
      .then((data) => setContacts(data.items ?? []))
      .catch(() => setContacts([]));
  }, [shareOpen]);

  const load = useCallback(async () => {
    try {
      const [detail, events] = await Promise.all([
        apiGet<{ request?: EmergencyRequestDto } | EmergencyRequestDto>(`/api/emergencies/${requestId}`),
        apiGet<{ items?: TimelineEventDto[] } | TimelineEventDto[]>(
          `/api/emergencies/${requestId}/timeline`,
        ).catch(() => ({ items: [] as TimelineEventDto[] })),
      ]);
      const dto = (detail as { request?: EmergencyRequestDto }).request ?? (detail as EmergencyRequestDto);
      if (!dto?.id) {
        setError('This assistance request could not be found.');
        setRequest(null);
        return;
      }
      setRequest(dto);
      const list = Array.isArray(events) ? events : (events as { items?: TimelineEventDto[] }).items;
      setTimeline(list ?? []);
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [requestId]);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 6000);
    return () => clearInterval(timer);
  }, [load]);

  const onMessage = useCallback(
    (message: RealtimeServerMessage) => {
      if (message.type === 'request.state') {
        const payload = message.payload as { request?: EmergencyRequestDto };
        if (payload.request) setRequest(payload.request);
        void load();
      }
      if (message.type === 'mechanic.location' || message.type === 'request.location') {
        const payload = message.payload as { latitude?: number; longitude?: number; source?: string };
        if (typeof payload.latitude === 'number' && typeof payload.longitude === 'number') {
          setLiveMarker({ latitude: payload.latitude, longitude: payload.longitude, role: payload.source ?? 'MECHANIC' });
        }
      }
      if (message.type === 'request.event') void load();
    },
    [load],
  );

  const realtime = useRealtime(`request:${requestId}`, onMessage, { enabled: Boolean(requestId) });

  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setActionError(null);
    try {
      await action();
      await load();
    } catch (err) {
      setActionError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const markers = useMemo<MapMarker[]>(() => {
    if (!request) return [];
    const list: MapMarker[] = [
      { id: 'request', latitude: request.latitude, longitude: request.longitude, tone: 'rose', label: 'Breakdown location', icon: <MapPin className="h-3.5 w-3.5" /> },
    ];
    if (liveMarker) {
      list.push({
        id: 'live',
        latitude: liveMarker.latitude,
        longitude: liveMarker.longitude,
        tone: liveMarker.role === 'MECHANIC' ? 'emerald' : 'brand',
        label: liveMarker.role === 'MECHANIC' ? 'Mechanic (live)' : 'Your location (live)',
        icon: <Navigation className="h-3.5 w-3.5" />,
      });
    }
    return list;
  }, [request, liveMarker]);

  if (loading && !request) return <LoadingState label="Opening session…" />;
  if (error && !request) return <Alert tone="danger">{error}</Alert>;
  if (!request) return null;

  const job = request.job;
  const quote = request.quote;
  const canPay = ['COMPLETED', 'PAYMENT_PENDING'].includes(request.status) && request.paymentStatus !== 'PAID';
  const canReview = request.status === 'PAID' && !request.rating;

  const arrivalOtp =
    typeof request.arrivalOtp === 'string' && request.arrivalOtp.trim().length > 0 ? request.arrivalOtp.trim() : null;
  const pastArrival = [
    'DIAGNOSING',
    'QUOTE_PENDING',
    'QUOTE_APPROVED',
    'REPAIRING',
    'COMPLETED',
    'PAYMENT_PENDING',
    'PAID',
    'CANCELLED',
    'FAILED',
  ].includes(request.status);
  const showArrivalOtp = Boolean(arrivalOtp) && !pastArrival;
  const awaitingArrivalOtp = !arrivalOtp && ['MECHANIC_NEARBY', 'ARRIVED'].includes(request.status);

  const copyOtp = () => {
    if (!arrivalOtp || !navigator.clipboard) return;
    void navigator.clipboard.writeText(arrivalOtp).then(() => {
      setOtpCopied(true);
      window.setTimeout(() => setOtpCopied(false), 2000);
    });
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone="blue">{request.reference}</Badge>
        <StatusBadge status={request.status} />
        <UrgencyBadge urgency={request.urgency} />
        <Badge>{titleCase(request.issueType)}</Badge>
        <span className="ml-auto inline-flex items-center gap-1.5 text-xs text-slate-500">
          <span className={cn('h-2 w-2 rounded-full', realtime.connected ? 'bg-emerald-500' : 'bg-amber-400')} />
          {realtime.connected ? 'Live' : 'Reconnecting…'}
        </span>
      </div>

      <ProgressStrip status={request.status} />

      {showArrivalOtp && arrivalOtp ? (
        <Card className="border-2 border-sun-300 bg-sun-300/20">
          <CardContent className="flex flex-wrap items-center justify-between gap-4">
            <div className="min-w-0">
              <p className="text-sm font-semibold text-ink">Your mechanic has arrived</p>
              <p className="text-xs text-slate-600">Share this code with your mechanic to start the job.</p>
              <p className="mt-3 font-mono text-3xl font-bold tabular-nums leading-none tracking-[0.3em] text-ink select-all">
                {arrivalOtp.slice(0, 3)} {arrivalOtp.slice(3)}
              </p>
              <p className="mt-3 text-xs font-medium text-slate-600">
                <OtpCountdown expiresAt={request.arrivalOtpExpiresAt ?? null} />
              </p>
            </div>
            <Button variant="ink" size="sm" onClick={copyOtp}>
              {otpCopied ? 'Copied' : 'Copy'}
            </Button>
          </CardContent>
        </Card>
      ) : null}

      {awaitingArrivalOtp ? (
        <Card className="border border-sun-200 bg-sun-50">
          <CardContent className="flex items-center gap-2 py-3 text-sm text-slate-700">
            <Clock className="h-4 w-4 shrink-0 text-sun-700" />
            Your mechanic is here — the start code was sent to your phone and notifications.
          </CardContent>
        </Card>
      ) : null}

      {actionError ? <Alert tone="danger">{actionError}</Alert> : null}

      <div className="grid gap-5 lg:grid-cols-5">
        <div className="space-y-5 lg:col-span-3">
          <Card>
            <CardHeader>
              <CardTitle>Live map</CardTitle>
              <span className="text-xs text-slate-500">{request.address ?? 'Coordinates from GPS'}</span>
            </CardHeader>
            <CardContent>
              <MapPanel
                markers={markers}
                height="h-72"
                route={
                  liveMarker && liveMarker.role === 'MECHANIC'
                    ? {
                        from: { latitude: liveMarker.latitude, longitude: liveMarker.longitude },
                        to: { latitude: request.latitude, longitude: request.longitude },
                      }
                    : null
                }
                onRouteInfo={setRouteInfo}
                mapsLink={`https://www.google.com/maps/search/?api=1&query=${request.latitude},${request.longitude}`}
              />
              {routeInfo ? (
                <p className="mt-2 text-xs font-medium text-slate-600">
                  Mechanic{' '}
                  {[
                    routeInfo.distanceKm !== null ? `~${routeInfo.distanceKm} km` : null,
                    routeInfo.durationMin !== null ? `${routeInfo.durationMin} min away` : null,
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </p>
              ) : null}
              <p className="mt-1 text-xs text-slate-500">
                {request.latitude.toFixed(5)}, {request.longitude.toFixed(5)}
              </p>
            </CardContent>
          </Card>

          {quote && quote.status === 'PENDING' && job ? (
            <Card className="border-violet-200">
              <CardHeader>
                <div>
                  <CardTitle>Quote waiting for your approval</CardTitle>
                  <p className="text-xs text-slate-500">Work starts only after you approve.</p>
                </div>
                <span className="text-lg font-semibold text-slate-900">{formatINR(quote.totalCents)}</span>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="divide-y divide-slate-100 rounded-lg border border-slate-100">
                  {quote.items.map((item) => (
                    <div key={item.id} className="flex items-center justify-between px-3 py-2 text-sm">
                      <span className="text-slate-700">
                        {item.description}
                        <span className="ml-2 text-xs text-slate-400">
                          {item.type} · {item.quantity} × {formatINR(item.unitPriceCents)}
                        </span>
                      </span>
                      <span className="font-medium tabular-nums">{formatINR(item.totalCents)}</span>
                    </div>
                  ))}
                </div>
                <div className="flex gap-2">
                  <Button
                    variant="success"
                    loading={busy}
                    onClick={() =>
                      run(() => apiPost(`/api/jobs/${job.id}/quote/approve`, { decision: 'APPROVED' }))
                    }
                  >
                    Approve quote
                  </Button>
                  <Button
                    variant="secondary"
                    loading={busy}
                    onClick={() =>
                      run(() => apiPost(`/api/jobs/${job.id}/quote/reject`, { decision: 'REJECTED' }))
                    }
                  >
                    Reject
                  </Button>
                </div>
              </CardContent>
            </Card>
          ) : null}

          {canPay ? (
            <Card className="border-emerald-200">
              <CardHeader>
                <CardTitle>Payment due</CardTitle>
                <span className="text-lg font-semibold">{formatINR(request.totalAmountCents)}</span>
              </CardHeader>
              <CardContent className="flex flex-wrap gap-2">
                <Button
                  variant="success"
                  loading={busy}
                  onClick={() => run(() => apiPost(`/api/emergencies/${request.id}/payment`, { method: 'UPI' }))}
                >
                  Pay with UPI
                </Button>
                <Button
                  variant="secondary"
                  loading={busy}
                  onClick={() => run(() => apiPost(`/api/emergencies/${request.id}/payment`, { method: 'CARD' }))}
                >
                  Pay with card
                </Button>
                <Button
                  variant="ghost"
                  onClick={() => {
                    void apiPost(`/api/emergencies/${request.id}/payment`, { method: 'CASH' }).then(() => load());
                  }}
                >
                  Pay cash to mechanic
                </Button>
              </CardContent>
            </Card>
          ) : null}

          <Card>
            <CardHeader>
              <CardTitle>Timeline</CardTitle>
              <span className="text-xs text-slate-500">{timeline.length} events</span>
            </CardHeader>
            <CardContent>
              <ol className="space-y-3">
                {[...timeline].reverse().map((event) => (
                  <li key={event.id} className="flex gap-3">
                    <span className="mt-1 h-2 w-2 shrink-0 rounded-full bg-brand-500" />
                    <div className="min-w-0">
                      <p className="text-sm text-slate-700">{event.message}</p>
                      <p className="text-xs text-slate-400">
                        {formatDateTime(event.createdAt)} · {event.actorRole ?? 'SYSTEM'}
                      </p>
                    </div>
                  </li>
                ))}
              </ol>
            </CardContent>
          </Card>
        </div>

        <div className="space-y-5 lg:col-span-2">
          <Card>
            <CardHeader>
              <CardTitle>Progress</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              <Row label="Status" value={titleCase(request.status)} />
              <Row label="Created" value={formatDateTime(request.createdAt)} />
              <Row label="Vehicle" value={request.vehicleLabel ?? '—'} />
              <Row label="Escalation level" value={String(request.escalationLevel)} />
              <Row
                label="Estimate / total"
                value={
                  quote
                    ? `${formatINR(quote.subtotalCents)} + tax → ${formatINR(quote.totalCents)}`
                    : request.totalAmountCents
                      ? formatINR(request.totalAmountCents)
                      : 'Pending diagnosis'
                }
              />
              <Row label="Payment" value={request.paymentStatus ?? '—'} />
            </CardContent>
          </Card>

          {request.assignedMechanic ? (
            <Card>
              <CardHeader>
                <div>
                  <CardTitle>{request.assignedMechanic.fullName}</CardTitle>
                  <p className="text-xs text-slate-500">
                    {titleCase(request.assignedMechanic.status)} ·{' '}
                    {request.assignedMechanic.distanceKm !== null
                      ? `${request.assignedMechanic.distanceKm.toFixed(1)} km away`
                      : 'Distance pending'}
                  </p>
                </div>
                <Rating value={request.assignedMechanic.ratingAverage} count={request.assignedMechanic.ratingCount} size="sm" />
              </CardHeader>
              <CardContent>
                <div className="flex flex-wrap gap-1.5">
                  {request.assignedMechanic.skills.slice(0, 6).map((skill) => (
                    <Badge key={skill}>{skill}</Badge>
                  ))}
                </div>
                <p className="mt-3 text-xs text-slate-500">
                  ETA {request.assignedMechanic.etaMinutes ? `${Math.round(request.assignedMechanic.etaMinutes)} min` : 'updating…'}
                </p>
              </CardContent>
            </Card>
          ) : null}

          <Card>
            <CardHeader>
              <CardTitle>Actions</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-2">
              <Button variant="secondary" onClick={() => setShareOpen(true)}>
                <Share2 className="h-4 w-4" /> Share with contacts
              </Button>
              <Button
                variant="secondary"
                loading={busy}
                onClick={() => run(() => apiPost(`/api/emergencies/${request.id}/escalate`, {}))}
              >
                <ShieldAlert className="h-4 w-4" /> Escalate to operations
              </Button>
              {canReview ? (
                <Button variant="primary" onClick={() => setReviewOpen(true)}>
                  Rate this service
                </Button>
              ) : null}
              {['CANCELLED', 'PAID', 'FAILED'].includes(request.status) ? null : (
                <Button variant="danger" onClick={() => setCancelOpen(true)}>
                  <XCircle className="h-4 w-4" /> Cancel request
                </Button>
              )}
            </CardContent>
          </Card>
        </div>
      </div>

      <Modal
        open={cancelOpen}
        onClose={() => setCancelOpen(false)}
        title="Cancel this request?"
        footer={
          <>
            <Button variant="secondary" onClick={() => setCancelOpen(false)}>
              Keep request
            </Button>
            <Button
              variant="danger"
              loading={busy}
              onClick={async () => {
                await run(() => apiPost(`/api/emergencies/${request.id}/cancel`, { reason: cancelReason }));
                setCancelOpen(false);
              }}
            >
              Cancel request
            </Button>
          </>
        }
      >
        <Field label="Reason" hint="A mechanic may already be on the way.">
          <Textarea value={cancelReason} onChange={(event) => setCancelReason(event.target.value)} />
        </Field>
      </Modal>

      <Modal
        open={shareOpen}
        onClose={() => setShareOpen(false)}
        title="Share your live status"
        footer={
          <>
            <Button variant="secondary" onClick={() => setShareOpen(false)}>
              Close
            </Button>
            <Button
              loading={busy}
              onClick={async () => {
                await run(() => apiPost(`/api/emergencies/${request.id}/share`, { contactIds: selectedContacts }));
                setShareOpen(false);
              }}
            >
              Send updates
            </Button>
          </>
        }
      >
        {contacts.length === 0 ? (
          <p className="text-sm text-slate-500">
            No emergency contacts yet — add them from your profile.
          </p>
        ) : (
          <div className="space-y-2">
            {contacts.map((contact) => (
              <label key={contact.id} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={selectedContacts.includes(contact.id)}
                  onChange={(event) =>
                    setSelectedContacts((prev) =>
                      event.target.checked ? [...prev, contact.id] : prev.filter((id) => id !== contact.id),
                    )
                  }
                />
                {contact.name} · {contact.phone}
              </label>
            ))}
          </div>
        )}
      </Modal>

      <ReviewModal
        open={reviewOpen}
        onClose={() => setReviewOpen(false)}
        requestId={request.id}
        onDone={() => {
          setReviewOpen(false);
          void load();
        }}
      />
    </div>
  );
}

function ProgressStrip({ status }: { status: string }) {
  if (status === 'CANCELLED' || status === 'FAILED') {
    return (
      <div className="-mx-1 flex items-center gap-2 overflow-x-auto px-1 pb-1">
        <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-rose-50 px-3 py-1.5 text-xs font-semibold text-rose-700 ring-1 ring-inset ring-rose-200">
          <XCircle className="h-3.5 w-3.5" />
          {status === 'CANCELLED' ? 'Request cancelled' : 'Request failed'}
        </span>
      </div>
    );
  }

  const current = progressStepIndex(status);

  return (
    <div className="-mx-1 flex items-center gap-2 overflow-x-auto px-1 pb-1" aria-label="Request progress">
      {PROGRESS_STEPS.map((step, index) => {
        const done = index < current;
        const isCurrent = index === current;
        return (
          <span
            key={step}
            className={cn(
              'inline-flex shrink-0 items-center gap-1.5 rounded-full px-3 py-1.5 text-xs',
              done && 'bg-brand-600 text-white',
              isCurrent && 'bg-sun-400 font-semibold text-ink',
              !done && !isCurrent && 'border border-slate-200 bg-white text-slate-400',
            )}
          >
            {done ? <Check className="h-3 w-3" aria-hidden /> : <span className="tabular-nums">{index + 1}</span>}
            {step}
          </span>
        );
      })}
    </div>
  );
}

function OtpCountdown({ expiresAt }: { expiresAt: string | null }) {
  const endAt = expiresAt ? new Date(expiresAt).getTime() : Number.NaN;
  const valid = Number.isFinite(endAt);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!expiresAt) return;
    const end = new Date(expiresAt).getTime();
    if (Number.isNaN(end)) return;
    if (Date.now() >= end) {
      setNow(end);
      return;
    }
    const timer = setInterval(() => {
      if (Date.now() >= end) {
        setNow(end);
        clearInterval(timer);
      } else {
        setNow(Date.now());
      }
    }, 1000);
    return () => clearInterval(timer);
  }, [expiresAt]);

  if (!valid) return <span>Ask your mechanic to refresh this code.</span>;

  const remaining = Math.max(0, Math.floor((endAt - now) / 1000));
  if (remaining <= 0) return <span className="text-rose-700">Expired — ask your mechanic to refresh</span>;

  const minutes = Math.floor(remaining / 60);
  const seconds = remaining % 60;
  const display =
    minutes >= 60
      ? `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
      : `${minutes}:${String(seconds).padStart(2, '0')}`;
  return (
    <span>
      Code expires in{' '}
      <span className="font-mono tabular-nums">{display}</span>
    </span>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-xs text-slate-500">{label}</span>
      <span className="text-right font-medium text-slate-800">{value}</span>
    </div>
  );
}

function ReviewModal({
  open,
  onClose,
  requestId,
  onDone,
}: {
  open: boolean;
  onClose: () => void;
  requestId: string;
  onDone: () => void;
}) {
  const [overall, setOverall] = useState(5);
  const [categories, setCategories] = useState({
    arrival: 5,
    diagnosis: 5,
    pricing: 5,
    professionalism: 5,
    resolution: 5,
  });
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await apiPost('/api/reviews', { requestId, overall, ...categories, comment: comment || null });
      onDone();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} title="Rate this service">
      <form onSubmit={submit} className="space-y-3">
        {error ? <Alert tone="danger">{error}</Alert> : null}
        <div className="flex items-center justify-between">
          <span className="text-sm text-slate-600">Overall</span>
          <Rating value={overall} onChange={setOverall} />
        </div>
        {(Object.keys(categories) as (keyof typeof categories)[]).map((key) => (
          <div key={key} className="flex items-center justify-between">
            <span className="text-sm capitalize text-slate-600">{key}</span>
            <Rating
              value={categories[key]}
              size="sm"
              onChange={(value) => setCategories((prev) => ({ ...prev, [key]: value }))}
            />
          </div>
        ))}
        <Field label="Comment (optional)">
          <Textarea value={comment} onChange={(event) => setComment(event.target.value)} />
        </Field>
        <Button type="submit" loading={busy} fullWidth>
          Submit review
        </Button>
      </form>
    </Modal>
  );
}
