'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import type { DiagnosisDto, EmergencyRequestDto, JobDto, QuoteDto, TimelineEventDto } from '@rr/types';
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
  JOB_STATUS_TONE,
  LoadingState,
  Select,
  StatusBadge,
  Textarea,
  UrgencyBadge,
  cn,
} from '@rr/ui';
import { CheckCircle2, Camera, MapPin, Navigation, Package, PlayCircle, Upload } from 'lucide-react';
import { AppShell } from '@/components/app-shell';
import { apiGet, apiPost, errorMessage, fieldErrors } from '@/lib/api';
import { formatDateTime, formatINR, titleCase } from '@/lib/format';
import { nextProgressStepLabel, progressStepLabel } from '@/lib/progress';
import { MapPanel, type MapMarker, type MapRouteInfo } from '@/components/map-panel';

interface JobDetail {
  job: JobDto;
  request: EmergencyRequestDto;
  diagnosis: DiagnosisDto | null;
  quote: QuoteDto | null;
}

interface DiagnosisItemDraft {
  code: string;
  label: string;
  result: 'OK' | 'FAIL' | 'NA' | 'UNCERTAIN';
  notes: string;
}

interface QuoteItemDraft {
  type: 'PART' | 'LABOUR' | 'FEE' | 'DISCOUNT';
  description: string;
  quantity: string;
  unitPriceRupees: string;
}

export default function JobWorkbenchPage() {
  return (
    <AppShell roles={['MECHANIC', 'WORKSHOP', 'TOWING_PARTNER']}>
      <Suspense fallback={<LoadingState label="Opening workbench…" />}>
        <Workbench />
      </Suspense>
    </AppShell>
  );
}

function Workbench() {
  const searchParams = useSearchParams();
  const jobId = searchParams.get('id') ?? '';

  const [detail, setDetail] = useState<JobDetail | null>(null);
  const [timeline, setTimeline] = useState<TimelineEventDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [busyAction, setBusyAction] = useState<string | null>(null);

  const [otp, setOtp] = useState('');
  const [diagnosisNotes, setDiagnosisNotes] = useState('');
  const [diagnosisItems, setDiagnosisItems] = useState<DiagnosisItemDraft[]>([]);
  const [quoteItems, setQuoteItems] = useState<QuoteItemDraft[]>([
    { type: 'LABOUR', description: 'Labour charge', quantity: '1', unitPriceRupees: '500' },
  ]);
  const [quoteNotes, setQuoteNotes] = useState('');
  const [fields, setFields] = useState<Record<string, string>>({});
  const [photoStage, setPhotoStage] = useState<'BEFORE' | 'DIAGNOSIS' | 'AFTER' | 'VERIFICATION'>('BEFORE');
  const [uploading, setUploading] = useState(false);
  const [myPos, setMyPos] = useState<{ latitude: number; longitude: number } | null>(null);
  const [routeInfo, setRouteInfo] = useState<MapRouteInfo | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await apiGet<JobDetail>(`/api/jobs/${jobId}`);
      setDetail(data);
      if (data.diagnosis) {
        setDiagnosisNotes(data.diagnosis.notes ?? '');
        setDiagnosisItems(
          data.diagnosis.items.map((item) => ({
            code: item.code,
            label: item.label,
            result: item.result,
            notes: item.notes ?? '',
          })),
        );
      }
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [jobId]);

  const loadTimeline = useCallback(async () => {
    if (!detail) return;
    try {
      const data = await apiGet<{ items: TimelineEventDto[] }>(
        `/api/emergencies/${detail.request.id}/timeline`,
      );
      setTimeline(data.items ?? []);
    } catch {
      setTimeline([]);
    }
  }, [detail]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    void loadTimeline();
    const timer = setInterval(() => {
      void load();
      void loadTimeline();
    }, 8000);
    return () => clearInterval(timer);
  }, [load, loadTimeline]);

  const run = async (action: () => Promise<unknown>, key: string) => {
    setBusy(true);
    setBusyAction(key);
    setError(null);
    try {
      await action();
      await load();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
      setBusyAction(null);
    }
  };

  const sendLocation = async (payload: Record<string, number>) => {
    if (!detail) return;
    await apiPost(`/api/jobs/${detail.job.id}/location`, payload).catch(() => undefined);
  };

  const sendLocationRef = useRef(sendLocation);
  useEffect(() => {
    sendLocationRef.current = sendLocation;
  });

  const jobActive = detail ? !['COMPLETED', 'CANCELLED'].includes(detail.job.status) : false;

  useEffect(() => {
    if (!jobActive || !navigator.geolocation) return;
    let lastSentAt = 0;
    const watchId = navigator.geolocation.watchPosition(
      (position) => {
        const next = { latitude: position.coords.latitude, longitude: position.coords.longitude };
        setMyPos(next);
        const now = Date.now();
        if (now - lastSentAt >= 10000) {
          lastSentAt = now;
          void sendLocationRef.current(next);
        }
      },
      () => undefined,
      { enableHighAccuracy: true, maximumAge: 4000 },
    );
    return () => navigator.geolocation.clearWatch(watchId);
  }, [jobActive]);

  const goEnRoute = () =>
    run(async () => {
      const pos = await currentLocation();
      if (pos) await sendLocation(pos);
      await apiPost(`/api/jobs/${jobId}/en-route`, pos ?? {});
    }, 'en-route');

  const goArrived = () => run(() => apiPost(`/api/jobs/${jobId}/arrived`, {}), 'arrived');

  const verifyOtp = async (event: FormEvent) => {
    event.preventDefault();
    setFields({});
    await run(() => apiPost(`/api/jobs/${jobId}/verify`, { otp: otp.trim() }), 'verify').then(() => setOtp(''));
  };

  const submitDiagnosis = async (event: FormEvent) => {
    event.preventDefault();
    setFields({});
    await run(
      () =>
        apiPost(`/api/jobs/${jobId}/diagnosis`, {
          notes: diagnosisNotes,
          items: diagnosisItems
            .filter((item) => item.label.trim())
            .map((item) => ({
              code: item.code.trim() || 'CHECK',
              label: item.label.trim(),
              result: item.result,
              notes: item.notes.trim() || null,
            })),
        }),
      'diagnosis',
    );
  };

  const submitQuote = async (event: FormEvent) => {
    event.preventDefault();
    setFields({});
    setBusy(true);
    setBusyAction('quote');
    try {
      await apiPost(`/api/jobs/${jobId}/quote`, {
        items: quoteItems
          .filter((item) => item.description.trim())
          .map((item) => ({
            type: item.type,
            description: item.description.trim(),
            quantity: Number(item.quantity) || 1,
            unitPriceCents: Math.round((Number(item.unitPriceRupees) || 0) * 100),
          })),
        taxPercent: 18,
        notes: quoteNotes.trim() || null,
      });
      await load();
    } catch (err) {
      setFields(fieldErrors(err));
      setError(errorMessage(err));
    } finally {
      setBusy(false);
      setBusyAction(null);
    }
  };

  const uploadPhoto = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file || !detail) return;
    setUploading(true);
    setError(null);
    try {
      const presign = await apiPost<{ uploadUrl: string; objectKey: string; headers: Record<string, string> }>(
        '/api/uploads/presign',
        {
          contentType: file.type,
          purpose: photoStage === 'DIAGNOSIS' || photoStage === 'BEFORE' ? 'diagnosis' : 'completion',
          fileName: file.name,
          sizeBytes: file.size,
          entityId: detail.request.id,
        },
      );
      const put = await fetch(presign.uploadUrl, {
        method: 'PUT',
        headers: { 'content-type': file.type },
        body: file,
      });
      if (!put.ok) throw new Error(`Upload failed (HTTP ${put.status})`);
      await apiPost(`/api/jobs/${jobId}/photos`, {
        stage: photoStage,
        objectKey: presign.objectKey,
        caption: photoStage,
      });
      await load();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setUploading(false);
      event.target.value = '';
    }
  };

  if (loading && !detail) return <LoadingState label="Opening workbench…" />;
  if (!detail) {
    return (
      <div className="space-y-4">
        <Alert tone="danger">{error ?? 'Job not found.'}</Alert>
        <Button variant="secondary" onClick={() => window.history.back()}>
          Back
        </Button>
      </div>
    );
  }

  const { job, request, quote } = detail;
  const markers: MapMarker[] = [
    { id: 'request', latitude: request.latitude, longitude: request.longitude, tone: 'rose', label: 'Customer', icon: <MapPin className="h-3.5 w-3.5" /> },
  ];
  if (myPos) {
    markers.push({ id: 'me', latitude: myPos.latitude, longitude: myPos.longitude, tone: 'brand', label: 'You', icon: <Navigation className="h-3.5 w-3.5" /> });
  }
  const directionsUrl = `https://www.google.com/maps/dir/?api=1&destination=${request.latitude},${request.longitude}&travelmode=driving`;
  const customerStep = progressStepLabel(request.status);
  const nextCustomerStep = nextProgressStepLabel(request.status);
  const etaParts = routeInfo
    ? [
        routeInfo.distanceKm !== null ? `${routeInfo.distanceKm} km` : null,
        routeInfo.durationMin !== null ? `${routeInfo.durationMin} min` : null,
      ].filter((part): part is string => part !== null)
    : [];
  const quoteTotal = quote ? quote.subtotalCents + quote.taxCents - quote.discountCents : 0;
  const draftSubtotalCents = Math.round(
    quoteItems.reduce((sum, item) => sum + (Number(item.quantity) || 0) * (Number(item.unitPriceRupees) || 0), 0) * 100,
  );

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <Link
            href="/mechanic/jobs"
            className="inline-flex items-center gap-1 text-xs font-medium text-brand-700 hover:underline"
          >
            Back to jobs
          </Link>
          <h1 className="page-title mt-1">{request.reference}</h1>
          <p className="page-subtitle">Job workbench · {titleCase(request.issueType)}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <StatusBadge status={job.status} map={JOB_STATUS_TONE} />
          <UrgencyBadge urgency={request.urgency} />
          <span className="text-xs text-slate-500">Request status</span>
          <StatusBadge status={request.status} />
        </div>
      </div>

      {error ? <Alert tone="danger">{error}</Alert> : null}

      <div className="grid gap-5 lg:grid-cols-5">
        <div className="space-y-4 lg:col-span-3">
          <Card>
            <CardHeader>
              <CardTitle>Work steps</CardTitle>
              <span className="text-xs text-slate-500">Follow the flow — each step unlocks the next.</span>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex flex-wrap gap-2">
                <Button
                  disabled={!['ACCEPTED'].includes(job.status) || busy}
                  loading={busyAction === 'en-route'}
                  onClick={() => {
                    window.open(directionsUrl, '_blank', 'noopener');
                    void goEnRoute();
                  }}
                >
                  <Navigation className="h-4 w-4" /> Start navigation
                </Button>
                <Button
                  variant="secondary"
                  disabled={!['EN_ROUTE'].includes(job.status) || busy}
                  loading={busyAction === 'arrived'}
                  onClick={() => void goArrived()}
                >
                  Mark arrived
                </Button>
                <Button
                  variant="secondary"
                  disabled={!['QUOTE_APPROVED'].includes(job.status) || busy}
                  loading={busyAction === 'start'}
                  onClick={() => void run(() => apiPost(`/api/jobs/${jobId}/start`, {}), 'start')}
                >
                  <PlayCircle className="h-4 w-4" /> Start repair
                </Button>
                <Button
                  variant="success"
                  disabled={!['REPAIRING'].includes(job.status) || busy}
                  loading={busyAction === 'complete'}
                  onClick={() => void run(() => apiPost(`/api/jobs/${jobId}/complete`, {}), 'complete')}
                >
                  <CheckCircle2 className="h-4 w-4" /> Mark complete
                </Button>
              </div>

              <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-slate-500">
                <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-500" />
                <span className="font-medium text-slate-600">
                  Customer sees: {customerStep}
                  {nextCustomerStep ? ` → ${nextCustomerStep}` : ''}
                </span>
                <span>customer is watching this live</span>
              </p>

              {['ARRIVED'].includes(job.status) ? (
                <form onSubmit={verifyOtp} className="flex flex-wrap items-end gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3">
                  <Field label="Customer OTP (6 digits)" error={fields.otp} className="w-40">
                    <Input
                      value={otp}
                      onChange={(event) => setOtp(event.target.value.replace(/\D/g, '').slice(0, 6))}
                      placeholder="123456"
                      inputMode="numeric"
                    />
                  </Field>
                  <Button type="submit" loading={busyAction === 'verify'} disabled={otp.length !== 6}>
                    Verify arrival
                  </Button>
                  <p className="w-full text-xs text-amber-800">
                    Ask the customer for the OTP sent to them when you arrived.
                  </p>
                </form>
              ) : null}

              {job.status === 'QUOTE_PENDING' ? (
                <Alert tone="info" title="Quote sent for approval">
                  The customer must approve before you can start the repair.
                </Alert>
              ) : null}

              {['VERIFIED', 'DIAGNOSING'].includes(job.status) ? (
                <form onSubmit={submitDiagnosis} className="space-y-3 rounded-xl border border-slate-200 p-4">
                  <div className="flex items-center justify-between">
                    <h3 className="text-sm font-semibold">Diagnosis</h3>
                    <Badge tone="cyan">{detail.diagnosis ? 'Recorded' : 'Required'}</Badge>
                  </div>
                  <Field label="Notes">
                    <Textarea
                      value={diagnosisNotes}
                      onChange={(event) => setDiagnosisNotes(event.target.value)}
                      placeholder="Battery voltage 11.8V, starter click but no crank…"
                    />
                  </Field>
                  <div className="space-y-2">
                    {diagnosisItems.map((item, index) => (
                      <div key={index} className="grid gap-2 sm:grid-cols-4">
                        <Input
                          value={item.code}
                          placeholder="Code"
                          onChange={(event) =>
                            setDiagnosisItems((prev) =>
                              prev.map((row, i) => (i === index ? { ...row, code: event.target.value } : row)),
                            )
                          }
                        />
                        <Input
                          value={item.label}
                          placeholder="Check label"
                          onChange={(event) =>
                            setDiagnosisItems((prev) =>
                              prev.map((row, i) => (i === index ? { ...row, label: event.target.value } : row)),
                            )
                          }
                        />
                        <Select
                          value={item.result}
                          onChange={(event) =>
                            setDiagnosisItems((prev) =>
                              prev.map((row, i) =>
                                i === index
                                  ? { ...row, result: event.target.value as DiagnosisItemDraft['result'] }
                                  : row,
                              ),
                            )
                          }
                        >
                          <option value="OK">OK</option>
                          <option value="FAIL">FAIL</option>
                          <option value="NA">N/A</option>
                          <option value="UNCERTAIN">UNCERTAIN</option>
                        </Select>
                        <div className="flex gap-2">
                          <Input
                            value={item.notes}
                            placeholder="Notes"
                            onChange={(event) =>
                              setDiagnosisItems((prev) =>
                                prev.map((row, i) => (i === index ? { ...row, notes: event.target.value } : row)),
                              )
                            }
                          />
                          <Button
                            variant="ghost"
                            size="sm"
                            aria-label="Remove check"
                            onClick={() => setDiagnosisItems((prev) => prev.filter((_, i) => i !== index))}
                          >
                            ✕
                          </Button>
                        </div>
                      </div>
                    ))}
                  </div>
                  <div className="flex gap-2">
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() =>
                        setDiagnosisItems((prev) => [
                          ...prev,
                          { code: 'CHECK', label: '', result: 'OK', notes: '' },
                        ])
                      }
                    >
                      Add check
                    </Button>
                    <Button type="submit" loading={busyAction === 'diagnosis'}>
                      Save diagnosis
                    </Button>
                  </div>
                </form>
              ) : null}

              {['DIAGNOSING', 'QUOTE_PENDING'].includes(job.status) ? (
                <form onSubmit={submitQuote} className="space-y-3 rounded-xl border border-slate-200 p-4">
                  <div className="flex items-center justify-between">
                    <h3 className="text-sm font-semibold">Quote for the customer</h3>
                    {quote ? <Badge tone={quote.status === 'APPROVED' ? 'emerald' : 'amber'}>{quote.status}</Badge> : null}
                  </div>
                  <div className="space-y-2">
                    {quoteItems.map((item, index) => (
                      <div key={index} className="grid gap-2 sm:grid-cols-5">
                        <Select
                          value={item.type}
                          onChange={(event) =>
                            setQuoteItems((prev) =>
                              prev.map((row, i) =>
                                i === index ? { ...row, type: event.target.value as QuoteItemDraft['type'] } : row,
                              ),
                            )
                          }
                        >
                          <option value="PART">Part</option>
                          <option value="LABOUR">Labour</option>
                          <option value="FEE">Fee</option>
                          <option value="DISCOUNT">Discount</option>
                        </Select>
                        <Input
                          value={item.description}
                          placeholder="Description"
                          onChange={(event) =>
                            setQuoteItems((prev) =>
                              prev.map((row, i) => (i === index ? { ...row, description: event.target.value } : row)),
                            )
                          }
                        />
                        <Input
                          type="number"
                          min={0.01}
                          step={0.01}
                          value={item.quantity}
                          placeholder="Qty"
                          onChange={(event) =>
                            setQuoteItems((prev) =>
                              prev.map((row, i) => (i === index ? { ...row, quantity: event.target.value } : row)),
                            )
                          }
                        />
                        <Input
                          type="number"
                          min={0}
                          step={1}
                          value={item.unitPriceRupees}
                          placeholder="₹ each"
                          onChange={(event) =>
                            setQuoteItems((prev) =>
                              prev.map((row, i) =>
                                i === index ? { ...row, unitPriceRupees: event.target.value } : row,
                              ),
                            )
                          }
                        />
                        <Button
                          variant="ghost"
                          size="sm"
                          aria-label="Remove line"
                          onClick={() => setQuoteItems((prev) => prev.filter((_, i) => i !== index))}
                        >
                          ✕
                        </Button>
                      </div>
                    ))}
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() =>
                        setQuoteItems((prev) => [
                          ...prev,
                          { type: 'PART', description: '', quantity: '1', unitPriceRupees: '0' },
                        ])
                      }
                    >
                      Add line
                    </Button>
                    <span className="text-xs text-slate-500">Subtotal {formatINR(draftSubtotalCents)}</span>
                    <Button type="submit" loading={busyAction === 'quote'} className="ml-auto">
                      <Package className="h-4 w-4" /> Send quote
                    </Button>
                  </div>
                  <Field label="Notes for customer (optional)">
                    <Input value={quoteNotes} onChange={(event) => setQuoteNotes(event.target.value)} />
                  </Field>
                </form>
              ) : null}

              {quote && !['DIAGNOSING', 'QUOTE_PENDING'].includes(job.status) ? (
                <div className="rounded-xl border border-slate-200 p-4">
                  <div className="flex items-center justify-between">
                    <h3 className="text-sm font-semibold">Quote</h3>
                    <Badge tone={quote.status === 'APPROVED' ? 'emerald' : 'slate'}>{quote.status}</Badge>
                  </div>
                  <ul className="mt-2 space-y-1 text-sm">
                    {quote.items.map((item) => (
                      <li key={item.id} className="flex justify-between text-slate-600">
                        <span>
                          {item.description} · {item.quantity} × {formatINR(item.unitPriceCents)}
                        </span>
                        <span className="tabular-nums">{formatINR(item.totalCents)}</span>
                      </li>
                    ))}
                  </ul>
                  <p className="mt-2 flex justify-between text-sm font-semibold text-slate-900">
                    <span>Total (+18% GST)</span>
                    <span>{formatINR(quote.totalCents || quoteTotal)}</span>
                  </p>
                </div>
              ) : null}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Evidence photos</CardTitle>
              <span className="text-xs text-slate-500">{job.photos.length} uploaded</span>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="flex flex-wrap items-center gap-2">
                <Select
                  value={photoStage}
                  onChange={(event) => setPhotoStage(event.target.value as typeof photoStage)}
                  className="w-44"
                >
                  <option value="BEFORE">Before</option>
                  <option value="DIAGNOSIS">Diagnosis</option>
                  <option value="AFTER">After</option>
                  <option value="VERIFICATION">Verification</option>
                </Select>
                <label className={cn('inline-flex h-9 cursor-pointer items-center gap-2 rounded-lg border border-slate-300 px-3 text-xs font-semibold text-slate-700 hover:bg-slate-50', uploading && 'opacity-60')}>
                  <Upload className="h-3.5 w-3.5" />
                  {uploading ? 'Uploading…' : 'Upload photo'}
                  <input type="file" accept="image/*" className="hidden" onChange={uploadPhoto} disabled={uploading} />
                </label>
              </div>
              {job.photos.length === 0 ? (
                <EmptyState
                  title="No photos yet"
                  description="Upload before and after photos as evidence for this job."
                  className="py-6"
                />
              ) : (
                <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
                  {job.photos.map((photo) =>
                    photo.url ? (
                      <a
                        key={photo.id}
                        href={photo.url}
                        target="_blank"
                        rel="noreferrer"
                        className="group overflow-hidden rounded-lg border border-slate-100"
                        title={photo.caption ?? photo.stage}
                      >
                        <img
                          src={photo.url}
                          alt={photo.caption ?? `${photo.stage} photo`}
                          className="aspect-square w-full object-cover transition group-hover:opacity-85"
                        />
                        <p className="p-1 text-center text-[10px] font-medium text-slate-500">{photo.stage}</p>
                      </a>
                    ) : (
                      <div key={photo.id} className="rounded-lg border border-slate-100 p-2 text-center">
                        <Camera className="mx-auto h-5 w-5 text-slate-300" />
                        <p className="mt-1 text-[10px] font-medium text-slate-500">{photo.stage}</p>
                      </div>
                    ),
                  )}
                </div>
              )}
            </CardContent>
          </Card>
        </div>

        <div className="space-y-4 lg:col-span-2">
          <Card>
            <CardHeader>
              <CardTitle>Customer & vehicle</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-sm">
              <Row label="Driver" value={request.driverName} />
              <Row label="Phone" value={request.driverPhone ?? '—'} />
              <Row label="Vehicle" value={request.vehicleLabel ?? '—'} />
              <Row label="Registration" value={request.vehicleRegistration ?? '—'} />
              <Row label="Issue" value={titleCase(request.issueType)} />
              <Row label="Description" value={request.description ?? '—'} />
              <Row label="Created" value={formatDateTime(request.createdAt)} />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Location</CardTitle>
            </CardHeader>
            <CardContent>
              <MapPanel
                markers={markers}
                height="h-52"
                route={
                  myPos
                    ? {
                        from: { latitude: myPos.latitude, longitude: myPos.longitude },
                        to: { latitude: request.latitude, longitude: request.longitude },
                      }
                    : null
                }
                onRouteInfo={setRouteInfo}
                mapsLink={directionsUrl}
              />
              {routeInfo ? (
                <p className="mt-2 text-xs font-medium text-slate-700">
                  You → customer{etaParts.length ? ` · ${etaParts.join(' · ')}` : ''}
                </p>
              ) : null}
              <p className="mt-2 text-xs text-slate-500">
                {request.address ?? `${request.latitude.toFixed(5)}, ${request.longitude.toFixed(5)}`}
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Timeline</CardTitle>
            </CardHeader>
            <CardContent className="max-h-72 space-y-3 overflow-y-auto">
              {timeline.length === 0 ? (
                <EmptyState
                  title="No activity yet"
                  description="Status changes and notes appear here as the job progresses."
                  className="py-6"
                />
              ) : (
                [...timeline].reverse().slice(0, 20).map((event) => (
                  <div key={event.id} className="flex gap-2">
                    <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-brand-500" />
                    <div>
                      <p className="text-xs text-slate-700">{event.message}</p>
                      <p className="text-[11px] text-slate-400">{formatDateTime(event.createdAt)}</p>
                    </div>
                  </div>
                ))
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-3">
      <span className="text-xs text-slate-500">{label}</span>
      <span className="truncate text-right font-medium text-slate-800">{value}</span>
    </div>
  );
}

async function currentLocation(): Promise<{ latitude: number; longitude: number } | null> {
  if (!navigator.geolocation) return null;
  return new Promise((resolve) => {
    navigator.geolocation.getCurrentPosition(
      (position) => resolve({ latitude: position.coords.latitude, longitude: position.coords.longitude }),
      () => resolve(null),
      { enableHighAccuracy: true, timeout: 6000 },
    );
  });
}
