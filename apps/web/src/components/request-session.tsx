'use client';

import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import type {
  DisputeDto,
  EmergencyContactDto,
  EmergencyRequestDto,
  InvoiceDto,
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
  EmptyState,
  Field,
  Input,
  LoadingState,
  Modal,
  Rating,
  Select,
  StatusBadge,
  Textarea,
  UrgencyBadge,
  cn,
} from '@rr/ui';
import { Check, Clock, Loader2, MapPin, Navigation, Share2, ShieldAlert, Truck, Wrench, XCircle } from 'lucide-react';
import { apiGet, apiPost, errorMessage } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { DEFAULT_CONFIG, ISSUE_LABELS, formatMoney } from '@rr/config';
import { useRealtime } from '@/lib/realtime';
import { formatDateTime, formatINR, timeAgo, titleCase } from '@/lib/format';
import { PROGRESS_STEPS, progressStepIndex } from '@/lib/progress';
import { MapPanel, type MapMarker, type MapRouteInfo } from '@/components/map-panel';

declare global {
  interface Window {
    Razorpay?: new (options: Record<string, unknown>) => {
      open(): void;
      on(event: string, handler: (response: { error?: { description?: string } }) => void): void;
    };
  }
}

const ACTOR_LABELS: Record<string, string> = {
  DRIVER: 'Driver',
  MECHANIC: 'Mechanic',
  WORKSHOP: 'Workshop',
  TOWING_PARTNER: 'Towing partner',
  OPERATIONS: 'Operations',
  ADMIN: 'Admin',
  SYSTEM: 'Motoro',
};

function timelineActorLabel(actorRole: string | null, viewerRole: string | undefined): string {
  const role = actorRole ?? 'SYSTEM';
  if (viewerRole && role === viewerRole) return 'You';
  return ACTOR_LABELS[role] ?? titleCase(role);
}

function humanizeEventMessage(message: string): string {
  let out = message.replace(/ — /g, ', ');
  const legacy = out.match(/^(?:Status changed to|Job status:)\s+(.+)$/i);
  if (legacy) out = `Status updated to ${titleCase(legacy[1])}`;
  out = out.replace(/\(([A-Z][A-Z_]+[A-Z])\)/g, (match, code: string) => {
    const label = ISSUE_LABELS[code as keyof typeof ISSUE_LABELS];
    return label ? `(${label})` : match;
  });
  return out;
}

interface ReviewEntry {
  id: string;
  reviewerUserId: string;
  revieweeName: string;
  overall: number;
  categories: Record<string, number>;
  comment: string | null;
  createdAt: string;
}

interface ChatMessage {
  id: string;
  requestId: string;
  senderUserId: string;
  senderName: string;
  body: string;
  createdAt: string;
  readAt: string | null;
}

export function RequestSession({ requestId }: { requestId: string }) {
  const { user } = useAuth();
  const readOnlyViewer = user?.role === 'MECHANIC' || user?.role === 'WORKSHOP';
  const [request, setRequest] = useState<EmergencyRequestDto | null>(null);
  const [timeline, setTimeline] = useState<TimelineEventDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [liveMarker, setLiveMarker] = useState<{
    latitude: number;
    longitude: number;
    role: string;
    at?: string | null;
  } | null>(null);
  const [routeInfo, setRouteInfo] = useState<MapRouteInfo | null>(null);
  const [otpCopied, setOtpCopied] = useState(false);

  const [cancelOpen, setCancelOpen] = useState(false);
  const [cancelReason, setCancelReason] = useState('');
  const [shareOpen, setShareOpen] = useState(false);
  const [contacts, setContacts] = useState<EmergencyContactDto[]>([]);
  const [selectedContacts, setSelectedContacts] = useState<string[]>([]);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [disputes, setDisputes] = useState<DisputeDto[]>([]);
  const [reviews, setReviews] = useState<ReviewEntry[]>([]);
  const [couponInput, setCouponInput] = useState('');
  const [appliedCoupon, setAppliedCoupon] = useState<{ code: string; discountCents: number } | null>(null);
  const [couponError, setCouponError] = useState<string | null>(null);
  const [couponBusy, setCouponBusy] = useState(false);
  const [disputeOpen, setDisputeOpen] = useState(false);
  const [disputeCategory, setDisputeCategory] = useState('SERVICE_QUALITY');
  const [disputeReason, setDisputeReason] = useState('');
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [chatInput, setChatInput] = useState('');
  const [chatBusy, setChatBusy] = useState(false);
  const [chatError, setChatError] = useState<string | null>(null);
  const [invoice, setInvoice] = useState<InvoiceDto | null>(null);
  const [invoicePayments, setInvoicePayments] = useState<
    Array<{
      id: string;
      provider: string;
      status: string;
      amountCents: number;
      method: string;
      paidAt: string | null;
      createdAt: string;
    }>
  >([]);

  const [upiCheckout, setUpiCheckout] = useState<CheckoutPayload | null>(null);
  const [upiPhase, setUpiPhase] = useState<'pay' | 'wait'>('pay');
  const [upiUtr, setUpiUtr] = useState('');
  const [upiNote, setUpiNote] = useState<string | null>(null);
  const [upiCopied, setUpiCopied] = useState(false);

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
      const seedLocation = dto.mechanicLocation;
      if (seedLocation) {
        setLiveMarker((prev) =>
          prev?.at && new Date(prev.at).getTime() > new Date(seedLocation.at).getTime()
            ? prev
            : {
                latitude: seedLocation.latitude,
                longitude: seedLocation.longitude,
                role: 'MECHANIC',
                at: seedLocation.at,
              },
        );
      }
      const list = Array.isArray(events) ? events : (events as { items?: TimelineEventDto[] }).items;
      setTimeline(list ?? []);
      apiGet<{ items?: DisputeDto[] }>(`/api/disputes?requestId=${requestId}`)
        .then((data) => setDisputes(data.items ?? []))
        .catch(() => undefined);
      apiGet<{ items?: ReviewEntry[] }>(`/api/reviews?requestId=${requestId}`)
        .then((data) => setReviews(data.items ?? []))
        .catch(() => undefined);
      apiGet<{ items?: ChatMessage[] }>(`/api/emergencies/${requestId}/messages`)
        .then((data) => setMessages(data.items ?? []))
        .catch(() => undefined);
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

  useEffect(() => {
    if (!request || request.paymentStatus !== 'PAID') return;
    let cancelled = false;
    void apiGet<{
      invoice: InvoiceDto | null;
      payments?: Array<{
        id: string;
        provider: string;
        status: string;
        amountCents: number;
        method: string;
        paidAt: string | null;
        createdAt: string;
      }>;
    }>(`/api/emergencies/${request.id}/invoice`)
      .then((data) => {
        if (cancelled) return;
        setInvoice(data.invoice);
        setInvoicePayments(data.payments ?? []);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [request?.id, request?.paymentStatus]);

  const onMessage = useCallback(
    (message: RealtimeServerMessage) => {
      if (message.type === 'request.state') {
        const payload = message.payload as { request?: EmergencyRequestDto };
        if (payload.request) setRequest(payload.request);
        void load();
      }
      if (message.type === 'mechanic.location' || message.type === 'request.location') {
        const payload = message.payload as {
          latitude?: number;
          longitude?: number;
          source?: string;
          at?: string;
        };
        const latitude = payload.latitude;
        const longitude = payload.longitude;
        if (typeof latitude === 'number' && typeof longitude === 'number') {
          setLiveMarker((prev) => {
            if (prev?.at && payload.at && new Date(prev.at).getTime() > new Date(payload.at).getTime()) {
              return prev;
            }
            return {
              latitude,
              longitude,
              role: payload.source ?? 'MECHANIC',
              at: payload.at ?? null,
            };
          });
        }
      }
      if (message.type === 'request.event') void load();
      if (message.type === 'quote.updated' || message.type === 'job.updated') void load();
      if (message.type === 'chat.message') {
        const payload = message.payload as { message?: ChatMessage };
        if (payload.message) {
          const incoming = payload.message;
          setMessages((prev) => (prev.some((m) => m.id === incoming.id) ? prev : [...prev, incoming]));
        }
      }
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

  const canChat = Boolean(
    user && request && (user.id === request.driverUserId || user.id === request.assignedMechanicUserId),
  );

  const sendChat = async (event: FormEvent) => {
    event.preventDefault();
    const body = chatInput.trim();
    if (!body || chatBusy) return;
    setChatBusy(true);
    setChatError(null);
    try {
      const data = await apiPost<{ message: ChatMessage }>(`/api/emergencies/${requestId}/messages`, { body });
      const sent = data.message;
      setMessages((prev) => (prev.some((m) => m.id === sent.id) ? prev : [...prev, sent]));
      setChatInput('');
    } catch (err) {
      setChatError(errorMessage(err));
    } finally {
      setChatBusy(false);
    }
  };

  interface CheckoutPayload {
    /** Absent = razorpay (legacy). */
    kind?: 'razorpay' | 'upi';
    key?: string;
    orderId?: string;
    amountCents: number;
    currency?: string;
    name?: string;
    upiUrl?: string;
    vpa?: string;
    payeeName?: string;
  }
  interface PaymentCreateResponse {
    payment?: { status?: string; checkout?: CheckoutPayload | null };
  }

  const loadRazorpayScript = () =>
    new Promise<boolean>((resolve) => {
      if (typeof window === 'undefined') return resolve(false);
      if (window.Razorpay) return resolve(true);
      const script = document.createElement('script');
      script.src = 'https://checkout.razorpay.com/v1/checkout.js';
      script.onload = () => resolve(true);
      script.onerror = () => resolve(false);
      document.body.appendChild(script);
    });

  const startOnlinePayment = async (method: 'UPI' | 'CARD') => {
    await run(async () => {
      const data = await apiPost<PaymentCreateResponse>(`/api/emergencies/${request!.id}/payment`, {
        method,
        ...(appliedCoupon ? { couponCode: appliedCoupon.code } : {}),
      });
      const checkout = data.payment?.checkout;
      if (!checkout) return; // Settled instantly (test provider) or nothing to open.

      if (checkout.kind === 'upi') {
        setUpiPhase('pay');
        setUpiUtr('');
        setUpiNote(null);
        setUpiCopied(false);
        setUpiCheckout(checkout);
        return;
      }

      const loaded = await loadRazorpayScript();
      const RazorpayCtor = window.Razorpay;
      if (!loaded || !RazorpayCtor) {
        throw new Error('Could not load the payment checkout. Please pay by cash instead.');
      }
      await new Promise<void>((resolve, reject) => {
        const rzp = new RazorpayCtor({
          key: checkout.key,
          amount: checkout.amountCents,
          currency: checkout.currency,
          name: checkout.name,
          order_id: checkout.orderId,
          prefill: { name: request?.driverName ?? undefined },
          theme: { color: '#d93809' },
          modal: { ondismiss: () => reject(new Error('Payment cancelled.')) },
          handler: (response: {
            razorpay_order_id: string;
            razorpay_payment_id: string;
            razorpay_signature: string;
          }) => {
            void apiPost(`/api/emergencies/${request!.id}/payment/verify`, {
              orderId: response.razorpay_order_id,
              paymentId: response.razorpay_payment_id,
              signature: response.razorpay_signature,
            })
              .then(() => resolve())
              .catch((err) => reject(err));
          },
        });
        rzp.on('payment.failed', (response: { error?: { description?: string } }) =>
          reject(new Error(response.error?.description ?? 'Payment failed.')),
        );
        rzp.open();
      });
    });
  };

  const confirmUpiPaid = async () => {
    if (!request) return;
    const ref = upiUtr.trim();
    if (ref && !/^[A-Za-z0-9-]{6,40}$/.test(ref)) {
      setActionError('Enter a valid UPI reference (6-40 letters/digits).');
      return;
    }
    await run(async () => {
      await apiPost(`/api/emergencies/${request.id}/payment/confirm`, ref ? { utr: ref } : {});
      setUpiNote(null);
      setUpiPhase('wait');
    });
  };

  useEffect(() => {
    if (upiPhase !== 'wait') return;
    if (request?.paymentStatus === 'PAID') {
      setUpiCheckout(null);
      setUpiPhase('pay');
      return;
    }
    const poll = window.setInterval(() => void load(), 4000);
    const stop = window.setTimeout(
      () => setUpiNote("Still waiting for confirmation. We'll notify you the moment it lands."),
      32000,
    );
    return () => {
      window.clearInterval(poll);
      window.clearTimeout(stop);
    };
  }, [upiPhase, request?.paymentStatus, load]);

  const previewCoupon = async () => {
    if (!couponInput.trim() || !request) return;
    setCouponBusy(true);
    setCouponError(null);
    try {
      const data = await apiPost<{ coupon: { code: string; discountCents: number } }>(
        `/api/emergencies/${request.id}/coupon/preview`,
        { code: couponInput.trim() },
      );
      setAppliedCoupon(data.coupon);
    } catch (err) {
      setAppliedCoupon(null);
      setCouponError(errorMessage(err));
    } finally {
      setCouponBusy(false);
    }
  };

  const markers = useMemo<MapMarker[]>(() => {
    if (!request) return [];
    const towing = (request.assignedMechanic?.skills ?? []).some((skill) => skill.toLowerCase() === 'towing');
    const list: MapMarker[] = [
      { id: 'request', latitude: request.latitude, longitude: request.longitude, tone: 'rose', label: 'Breakdown location', icon: <MapPin className="h-3.5 w-3.5" /> },
    ];
    if (liveMarker) {
      list.push({
        id: 'live',
        latitude: liveMarker.latitude,
        longitude: liveMarker.longitude,
        tone: liveMarker.role === 'MECHANIC' ? 'emerald' : 'brand',
        label:
          liveMarker.role === 'MECHANIC'
            ? `${request.assignedMechanic?.fullName ?? 'Mechanic'}${towing ? ' (tow truck)' : ''} (live)`
            : 'Your location (live)',
        icon:
          towing && liveMarker.role === 'MECHANIC' ? (
            <Truck className="h-3.5 w-3.5" />
          ) : (
            <Navigation className="h-3.5 w-3.5" />
          ),
      });
    }
    return list;
  }, [request, liveMarker]);

  if (loading && !request) return <LoadingState label="Opening session…" />;
  if (error && !request) return <Alert tone="danger">{error}</Alert>;
  if (!request) return null;

  const job = request.job;
  const quote = request.quote;
  const feeDue =
    request.status === 'CANCELLED' &&
    request.paymentStatus === 'PENDING' &&
    (request.totalAmountCents ?? 0) > 0;
  const canPay =
    !readOnlyViewer &&
    ((['COMPLETED', 'PAYMENT_PENDING'].includes(request.status) && request.paymentStatus !== 'PAID') || feeDue);
  const canReview = !readOnlyViewer && request.status === 'PAID' && !request.rating;

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

  const trackingActive =
    Boolean(request.assignedMechanic) &&
    ['ASSIGNED', 'MECHANIC_EN_ROUTE', 'MECHANIC_NEARBY', 'TOWING_REQUIRED'].includes(request.status);
  const isTowing = Boolean(request.assignedMechanic?.skills.some((skill) => skill.toLowerCase() === 'towing'));
  const liveEtaMin = routeInfo?.durationMin ?? request.assignedMechanic?.etaMinutes ?? null;
  const liveEtaKm = routeInfo?.distanceKm ?? request.assignedMechanic?.distanceKm ?? null;

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

      {trackingActive && request.assignedMechanic ? (
        <Card className="border-emerald-200 bg-gradient-to-r from-emerald-50 to-white">
          <CardContent className="flex items-center gap-4 py-4">
            <span className="relative flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-emerald-600 text-white">
              {isTowing ? <Truck className="h-6 w-6" /> : <Wrench className="h-6 w-6" />}
              <span className="absolute -inset-1 animate-ping rounded-full bg-emerald-400/30" aria-hidden />
            </span>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-semibold text-ink">
                {request.assignedMechanic.fullName}{' '}
                {request.status === 'MECHANIC_NEARBY'
                  ? isTowing
                    ? 'is arriving with your tow truck'
                    : 'is arriving now'
                  : request.status === 'ASSIGNED'
                    ? 'accepted your request'
                    : isTowing
                      ? 'is bringing your tow truck'
                      : 'is on the way'}
              </p>
              <p className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-slate-600">
                <span className="inline-flex items-center gap-1 font-medium text-emerald-700">
                  <span
                    className={cn('h-1.5 w-1.5 rounded-full', realtime.connected ? 'bg-emerald-500' : 'bg-amber-400')}
                  />
                  {realtime.connected ? 'Live' : 'Updating…'}
                </span>
                {liveEtaMin !== null ? <span>· ~{liveEtaMin} min away</span> : null}
                {liveEtaKm !== null ? <span>· {liveEtaKm} km</span> : null}
              </p>
            </div>
            <a
              href="#live-map"
              className="shrink-0 rounded-lg border border-emerald-300 bg-white px-3 py-2 text-xs font-semibold text-emerald-800 shadow-sm transition-colors hover:bg-emerald-50"
            >
              View map
            </a>
          </CardContent>
        </Card>
      ) : null}

      <ProgressStrip status={request.status} />

      {request.photos && request.photos.some((photo) => photo.url) ? (
        <Card>
          <CardHeader>
            <CardTitle>Breakdown photos</CardTitle>
            <span className="text-xs text-slate-500">Attached when the request was created.</span>
          </CardHeader>
          <CardContent>
            <div className="flex flex-wrap gap-2">
              {request.photos.map((photo) =>
                photo.url ? (
                  <a key={photo.id} href={photo.url} target="_blank" rel="noreferrer">
                    <img
                      src={photo.url}
                      alt={photo.caption ?? `Breakdown photo (${photo.stage.toLowerCase()})`}
                      className="h-24 w-24 rounded-lg border border-slate-200 object-cover transition hover:opacity-80"
                    />
                  </a>
                ) : null,
              )}
            </div>
          </CardContent>
        </Card>
      ) : null}

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
          <CardContent className="flex items-center gap-2 py-3 text-sm text-ink">
            <Clock className="h-4 w-4 shrink-0 text-sun-700" />
            Your mechanic is here: the start code was sent to your phone and notifications.
          </CardContent>
        </Card>
      ) : null}

      {actionError ? <Alert tone="danger">{actionError}</Alert> : null}

      <div className="grid gap-5 lg:grid-cols-5">
        <div className="space-y-5 lg:col-span-3">
          <div id="live-map" className="scroll-mt-24">
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
          </div>

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
                {readOnlyViewer ? (
                  <p className="text-xs text-slate-500">Waiting for the customer to approve this quote.</p>
                ) : (
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
                )}
              </CardContent>
            </Card>
          ) : null}

          {canPay ? (
            <Card className="border-emerald-200">
              <CardHeader>
                <CardTitle>Payment due</CardTitle>
                <span className="text-lg font-semibold">
                  {formatINR(Math.max(0, (request.totalAmountCents ?? 0) - (appliedCoupon?.discountCents ?? 0)))}
                  {appliedCoupon ? (
                    <span className="ml-2 text-sm font-normal text-emerald-700">
                      {appliedCoupon.code} − {formatINR(appliedCoupon.discountCents)}
                    </span>
                  ) : null}
                </span>
              </CardHeader>
              <CardContent className="space-y-3">
                {appliedCoupon || request.couponCode ? null : (
                  <div className="flex flex-wrap items-end gap-2">
                    <Field label="Coupon code" className="flex-1 min-w-44">
                      <Input
                        value={couponInput}
                        onChange={(event) => setCouponInput(event.target.value.toUpperCase())}
                        placeholder="SAVE10"
                      />
                    </Field>
                    <Button variant="secondary" loading={couponBusy} onClick={() => void previewCoupon()}>
                      Apply
                    </Button>
                  </div>
                )}
                {couponError ? <Alert tone="danger">{couponError}</Alert> : null}
                {request.couponCode && !appliedCoupon ? (
                  <p className="text-xs text-emerald-700">
                    {request.couponCode} applied · {formatINR(request.couponDiscountCents)} off
                  </p>
                ) : null}
                <div className="flex flex-wrap gap-2">
                  <Button
                    variant="success"
                    loading={busy}
                    onClick={() => void startOnlinePayment('UPI')}
                  >
                    Pay with UPI
                  </Button>
                  <Button
                    variant="secondary"
                    loading={busy}
                    onClick={() => void startOnlinePayment('CARD')}
                  >
                    Pay with card
                  </Button>
                  <Button
                    variant="ghost"
                    onClick={() => {
                      void apiPost(`/api/emergencies/${request.id}/payment`, {
                        method: 'CASH',
                        ...(appliedCoupon ? { couponCode: appliedCoupon.code } : {}),
                      }).then(() => load());
                    }}
                  >
                    Pay cash to mechanic
                  </Button>
                </div>
              </CardContent>
            </Card>
          ) : null}

          {invoice ? (
            <Card>
              <CardHeader>
                <CardTitle>Invoice</CardTitle>
                <span className="text-sm font-medium text-slate-500">{invoice.number}</span>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="divide-y divide-slate-100 rounded-lg border border-slate-100 text-sm">
                  <div className="flex justify-between px-3 py-2">
                    <span className="text-slate-500">Subtotal</span>
                    <span className="tabular-nums">{formatINR(invoice.subtotalCents)}</span>
                  </div>
                  <div className="flex justify-between px-3 py-2">
                    <span className="text-slate-500">GST (18%)</span>
                    <span className="tabular-nums">{formatINR(invoice.taxCents)}</span>
                  </div>
                  {invoice.discountCents > 0 ? (
                    <div className="flex justify-between px-3 py-2 text-emerald-700">
                      <span>
                        Discount{request.couponCode ? ` (${request.couponCode})` : ''}
                      </span>
                      <span className="tabular-nums">−{formatINR(invoice.discountCents)}</span>
                    </div>
                  ) : null}
                  <div className="flex justify-between px-3 py-2 font-medium">
                    <span>Total</span>
                    <span className="tabular-nums">{formatINR(invoice.totalCents)}</span>
                  </div>
                </div>
                {invoicePayments.length > 0 ? (
                  <div className="space-y-1">
                    {invoicePayments.map((payment) => (
                      <div key={payment.id} className="flex items-center justify-between text-xs text-slate-500">
                        <span>
                          {titleCase(payment.method)} · {titleCase(payment.provider)} · {titleCase(payment.status)}
                        </span>
                        <span>{payment.paidAt ? formatDateTime(payment.paidAt) : formatDateTime(payment.createdAt ?? '')}</span>
                      </div>
                    ))}
                  </div>
                ) : null}
                <div className="flex flex-wrap items-center gap-3">
                  <Badge tone={invoice.status === 'PAID' ? 'emerald' : 'slate'}>{titleCase(invoice.status)}</Badge>
                  {invoice.pdfUrl ? (
                    <a
                      href={invoice.pdfUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="text-sm font-medium text-brand-700 hover:underline"
                    >
                      Download PDF
                    </a>
                  ) : (
                    <span className="text-xs text-slate-400">PDF is being prepared…</span>
                  )}
                </div>
              </CardContent>
            </Card>
          ) : null}

          {reviews.length > 0 ? (
            <Card>
              <CardHeader>
                <CardTitle>Reviews</CardTitle>
                <span className="text-xs text-slate-500">{reviews.length} submitted</span>
              </CardHeader>
              <CardContent className="space-y-4">
                {reviews.map((review) => (
                  <div key={review.id} className="space-y-1.5">
                    <div className="flex items-center justify-between gap-2">
                      <Rating value={review.overall} size="sm" />
                      <span className="text-xs text-slate-400">{formatDateTime(review.createdAt)}</span>
                    </div>
                    {review.comment ? <p className="text-sm text-slate-700">{review.comment}</p> : null}
                  </div>
                ))}
              </CardContent>
            </Card>
          ) : null}

          <Card>
            <CardHeader>
              <CardTitle>Session chat</CardTitle>
              <span className="text-xs text-slate-500">
                {request.assignedMechanic ? 'Driver and mechanic' : 'Messages with support'}
                {realtime.connected ? ' · live' : ''}
              </span>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="max-h-64 space-y-2 overflow-y-auto rounded-lg border border-slate-200 bg-slate-50 p-3">
                {messages.length === 0 ? (
                  <p className="text-sm text-slate-500">No messages yet.</p>
                ) : (
                  messages.map((message) => {
                    const mine = message.senderUserId === user?.id;
                    return (
                      <div key={message.id} className={mine ? 'flex justify-end' : 'flex justify-start'}>
                        <div
                          className={
                            'max-w-[80%] rounded-2xl px-3 py-2 text-sm shadow-sm ' +
                            (mine ? 'bg-brand-600 text-white' : 'border border-slate-200 bg-white text-slate-700')
                          }
                        >
                          {!mine ? (
                            <p className="mb-0.5 text-xs font-medium text-slate-500">{message.senderName}</p>
                          ) : null}
                          <p className="whitespace-pre-wrap break-words">{message.body}</p>
                          <p className={'mt-1 text-[10px] ' + (mine ? 'text-brand-100' : 'text-slate-400')}>
                            {formatDateTime(message.createdAt)}
                          </p>
                        </div>
                      </div>
                    );
                  })
                )}
              </div>
              {canChat ? (
                <form onSubmit={sendChat} className="flex gap-2">
                  <Input
                    value={chatInput}
                    onChange={(e) => setChatInput(e.target.value)}
                    placeholder="Type a message…"
                    maxLength={1000}
                    aria-label="Chat message"
                  />
                  <Button type="submit" disabled={chatBusy || !chatInput.trim()}>
                    {chatBusy ? 'Sending…' : 'Send'}
                  </Button>
                </form>
              ) : (
                <p className="text-xs text-slate-500">Only the driver and assigned mechanic can post messages.</p>
              )}
              {chatError ? <p className="text-xs text-rose-600">{chatError}</p> : null}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Timeline</CardTitle>
              <span className="text-xs text-slate-500">{timeline.length} events</span>
            </CardHeader>
            <CardContent>
              {timeline.length === 0 ? (
                <EmptyState
                  title="No timeline events yet"
                  description="Dispatch, quote and payment steps appear here the moment they happen."
                />
              ) : (
                <ol className="space-y-3">
                  {[...timeline].reverse().map((event) => (
                    <li key={event.id} className="flex gap-3">
                      <span className="mt-1 h-2 w-2 shrink-0 rounded-full bg-brand-500" />
                      <div className="min-w-0">
                        <p className="text-sm text-slate-700">{humanizeEventMessage(event.message)}</p>
                        <p className="text-xs text-slate-400" title={formatDateTime(event.createdAt)}>
                          {timelineActorLabel(event.actorRole ?? null, user?.role)} · {timeAgo(event.createdAt)}
                        </p>
                      </div>
                    </li>
                  ))}
                </ol>
              )}
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
              <Row label="Vehicle" value={request.vehicleLabel ?? 'None'} />
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
              <Row
                label="Payment"
                value={request.paymentStatus ? titleCase(request.paymentStatus) : 'None'}
              />
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
              <CardTitle>{readOnlyViewer ? 'Overview' : 'Actions'}</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-2">
              {disputes.length > 0 ? (
                <div className="space-y-2">
                  {disputes.map((dispute) => (
                    <div key={dispute.id} className="rounded-lg border border-slate-200 bg-slate-50 p-3">
                      <div className="flex items-center justify-between gap-2">
                        <Badge tone={dispute.status === 'OPEN' ? 'amber' : dispute.status === 'IN_REVIEW' ? 'blue' : dispute.status === 'RESOLVED' ? 'emerald' : 'slate'}>
                          {dispute.status.replace('_', ' ')}
                        </Badge>
                        <span className="text-xs text-slate-500">{titleCase(dispute.category)}</span>
                      </div>
                      <p className="mt-1.5 text-xs text-slate-600">{dispute.reason}</p>
                      {dispute.resolution ? (
                        <p className="mt-1 text-xs text-emerald-700">Resolution: {dispute.resolution}</p>
                      ) : null}
                    </div>
                  ))}
                </div>
              ) : null}
              {readOnlyViewer ? (
                <p className="text-xs text-slate-500">
                  Read-only view. Sharing, escalation and cancellation stay with the driver.
                </p>
              ) : (
                <>
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
                  {disputes.some((d) => d.status === 'OPEN' || d.status === 'IN_REVIEW') ? null : (
                    <Button variant="secondary" onClick={() => setDisputeOpen(true)}>
                      Raise a dispute
                    </Button>
                  )}
                  {['CANCELLED', 'PAID', 'FAILED'].includes(request.status) ? null : (
                    <Button variant="danger" onClick={() => setCancelOpen(true)}>
                      <XCircle className="h-4 w-4" /> Cancel request
                    </Button>
                  )}
                </>
              )}
            </CardContent>
          </Card>
        </div>
      </div>

      <Modal
        open={Boolean(upiCheckout)}
        onClose={() => {
          setUpiCheckout(null);
          setUpiPhase('pay');
        }}
        title={upiPhase === 'wait' ? 'Confirming your payment' : 'Pay via UPI'}
        footer={
          upiPhase === 'pay' && upiCheckout ? (
            <>
              <Button variant="secondary" onClick={() => setUpiCheckout(null)}>
                Cancel
              </Button>
              <Button variant="success" loading={busy} onClick={confirmUpiPaid}>
                I've paid {formatINR(upiCheckout.amountCents)}
              </Button>
            </>
          ) : (
            <Button
              variant="secondary"
              onClick={() => {
                setUpiCheckout(null);
                setUpiPhase('pay');
              }}
            >
              Close
            </Button>
          )
        }
      >
        {upiPhase === 'pay' && upiCheckout ? (
          <div className="space-y-4">
            <div className="rounded-2xl bg-canvas p-4 text-center">
              <p className="text-xs uppercase tracking-wide text-slate-500">Amount to pay</p>
              <p className="mt-1 text-3xl font-semibold">{formatINR(upiCheckout.amountCents)}</p>
            </div>
            <Button
              variant="primary"
              fullWidth
              onClick={() => {
                if (upiCheckout.upiUrl) window.location.href = upiCheckout.upiUrl;
              }}
            >
              Open UPI app
            </Button>
            {upiCheckout.vpa ? (
              <div className="flex items-center justify-between gap-2 rounded-xl border border-border p-3">
                <div className="min-w-0">
                  <p className="text-xs text-slate-500">Or pay this VPA from any app</p>
                  <p className="truncate font-mono text-sm font-medium">{upiCheckout.vpa}</p>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    void navigator.clipboard?.writeText(upiCheckout.vpa ?? '');
                    setUpiCopied(true);
                    window.setTimeout(() => setUpiCopied(false), 2000);
                  }}
                >
                  {upiCopied ? 'Copied' : 'Copy'}
                </Button>
              </div>
            ) : null}
            <ol className="list-decimal space-y-1 pl-5 text-sm text-slate-500">
              <li>Pay the exact amount in any UPI app.</li>
              <li>Copy the UPI reference number from your app (optional).</li>
              <li>Tap &ldquo;I&rsquo;ve paid&rdquo; &mdash; we&rsquo;ll confirm with our team.</li>
            </ol>
            <Field label="UPI reference (optional)" hint="The reference speeds up confirmation.">
              <Input
                value={upiUtr}
                onChange={(event) => setUpiUtr(event.target.value)}
                placeholder="e.g. 415023678912"
              />
            </Field>
          </div>
        ) : (
          <div className="space-y-3 py-2 text-center">
            <Loader2 className="mx-auto h-8 w-8 animate-spin text-brand-600" />
            <p className="font-medium">Waiting for confirmation&hellip;</p>
            <p className="text-sm text-slate-500">
              {upiNote ??
                'Your payment was reported to our team. You will be notified as soon as it is confirmed.'}
            </p>
          </div>
        )}
      </Modal>

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
        <p className="mt-3 text-xs text-slate-500">
          The first {DEFAULT_CONFIG.cancellation.freeWindowSeconds} seconds are free. After that, cancelling while a
          mechanic is already dispatched adds a {formatMoney(DEFAULT_CONFIG.cancellation.feeCents)} cancellation fee to
          this request.
        </p>
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
            No emergency contacts yet. Add them from your profile.
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

      <Modal
        open={disputeOpen}
        onClose={() => setDisputeOpen(false)}
        title="Raise a dispute"
        footer={
          <>
            <Button variant="secondary" onClick={() => setDisputeOpen(false)}>
              Cancel
            </Button>
            <Button
              loading={busy}
              onClick={async () => {
                if (disputeReason.trim().length < 10) {
                  setActionError('Please describe the issue in at least 10 characters.');
                  return;
                }
                setBusy(true);
                setActionError(null);
                try {
                  await apiPost(`/api/disputes`, {
                    requestId: request.id,
                    category: disputeCategory,
                    reason: disputeReason.trim(),
                  });
                  setDisputeReason('');
                  setDisputeOpen(false);
                  await load();
                } catch (err) {
                  setActionError(errorMessage(err));
                } finally {
                  setBusy(false);
                }
              }}
            >
              Submit dispute
            </Button>
          </>
        }
      >
        <Field label="What went wrong?">
          <Select value={disputeCategory} onChange={(event) => setDisputeCategory(event.target.value)}>
            <option value="SERVICE_QUALITY">Service quality</option>
            <option value="OVERCHARGING">Overcharging</option>
            <option value="NO_SHOW">Mechanic did not show up</option>
            <option value="VEHICLE_DAMAGE">Vehicle damage</option>
            <option value="SAFETY">Safety concern</option>
            <option value="OTHER">Other</option>
          </Select>
        </Field>
        <Field label="Details" hint="At least 10 characters. Our team reviews every dispute.">
          <Textarea
            value={disputeReason}
            onChange={(event) => setDisputeReason(event.target.value)}
            placeholder="Describe what happened…"
          />
        </Field>
        {actionError ? <Alert tone="danger" className="mt-3">{actionError}</Alert> : null}
      </Modal>
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
  if (remaining <= 0) return <span className="text-rose-700">Expired. Ask your mechanic to refresh.</span>;

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
