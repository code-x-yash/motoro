'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import type { VehicleDto, Paginated, EmergencyRequestDto } from '@rr/types';
import { ISSUE_TYPES, type IssueType } from '@rr/config';
import { Alert, Button, Card, CardContent, CardHeader, CardTitle, Checkbox, Field, Input, Select, Textarea, cn } from '@rr/ui';
import { Battery, CircleDot, Crosshair, Fuel, Gauge, HelpCircle, KeyRound, Lightbulb, Siren, Thermometer, Wrench } from 'lucide-react';
import { AppShell } from '@/components/app-shell';
import { ApiError, apiGet, apiPost, errorMessage, fieldErrors } from '@/lib/api';

/** Statuses that block creating a second request (mirrors the worker's active set). */
const ACTIVE_STATUSES = new Set([
  'CREATED', 'SEARCHING', 'DISPATCHING', 'ASSIGNED', 'MECHANIC_EN_ROUTE', 'MECHANIC_NEARBY',
  'ARRIVED', 'DIAGNOSING', 'QUOTE_PENDING', 'QUOTE_APPROVED', 'REPAIRING', 'ESCALATED',
  'TOWING_REQUIRED',
]);

/** Most recent active request for the signed-in driver, used when the API reports one is already active. */
async function latestRequestId(): Promise<string | null> {
  try {
    const list = await apiGet<Paginated<EmergencyRequestDto>>('/api/emergencies', { query: { limit: 10 } });
    return list.items.find((item) => ACTIVE_STATUSES.has(item.status))?.id ?? null;
  } catch {
    return null;
  }
}

const URGENCIES = [
  { value: 'LOW', label: 'Low — can wait a bit' },
  { value: 'NORMAL', label: 'Normal — standard dispatch' },
  { value: 'HIGH', label: 'High — stranded / unsafe' },
  { value: 'CRITICAL', label: 'Critical — accident or danger' },
];

const ISSUE_LABELS: Record<IssueType, string> = {
  BATTERY: 'Battery / jump start',
  FLAT_TYRE: 'Flat tyre',
  OUT_OF_FUEL: 'Out of fuel',
  ENGINE_PROBLEM: 'Engine problem',
  ELECTRICAL_PROBLEM: 'Electrical problem',
  OVERHEATING: 'Overheating',
  LOCKOUT: 'Keys locked in',
  ACCIDENT: 'Accident',
  GENERAL_BREAKDOWN: 'General breakdown',
  DONT_KNOW: "Not sure what's wrong",
};

const ISSUE_ICONS: Record<IssueType, typeof Battery> = {
  BATTERY: Battery,
  FLAT_TYRE: CircleDot,
  OUT_OF_FUEL: Fuel,
  ENGINE_PROBLEM: Gauge,
  ELECTRICAL_PROBLEM: Lightbulb,
  OVERHEATING: Thermometer,
  LOCKOUT: KeyRound,
  ACCIDENT: Siren,
  GENERAL_BREAKDOWN: Wrench,
  DONT_KNOW: HelpCircle,
};

interface AccidentFlags {
  driverInjured: boolean;
  anyoneInjured: boolean;
  blockingTraffic: boolean;
  needsTowing: boolean;
  medicalAssistance: boolean;
  policeAssistance: boolean;
}

const DEFAULT_LOCATION = { latitude: 19.076, longitude: 72.8777, accuracy: 0 };

export default function NewRequestPage() {
  return (
    <AppShell roles={['DRIVER']}>
      <NewRequestForm />
    </AppShell>
  );
}

function NewRequestForm() {
  const router = useRouter();
  const [vehicles, setVehicles] = useState<VehicleDto[]>([]);
  const [vehicleId, setVehicleId] = useState('');
  const [issueType, setIssueType] = useState<IssueType>('BATTERY');
  const [urgency, setUrgency] = useState('NORMAL');
  const [description, setDescription] = useState('');
  const [address, setAddress] = useState('');
  const [location, setLocation] = useState(DEFAULT_LOCATION);
  const [locating, setLocating] = useState(false);
  const [locationLabel, setLocationLabel] = useState('Using default city coordinates');
  const [accident, setAccident] = useState<AccidentFlags>({
    driverInjured: false,
    anyoneInjured: false,
    blockingTraffic: false,
    needsTowing: false,
    medicalAssistance: false,
    policeAssistance: false,
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});

  useEffect(() => {
    void apiGet<Paginated<VehicleDto>>('/api/vehicles', { query: { limit: 20 } })
      .then((data) => {
        setVehicles(data.items);
        if (data.items[0]) setVehicleId(data.items[0].id);
      })
      .catch(() => undefined);
  }, []);

  const isAccident = issueType === 'ACCIDENT';

  const locate = () => {
    if (!navigator.geolocation) {
      setError('Location is not available in this browser.');
      return;
    }
    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      (position) => {
        setLocation({
          latitude: position.coords.latitude,
          longitude: position.coords.longitude,
          accuracy: position.coords.accuracy ?? 0,
        });
        setLocationLabel(`${position.coords.latitude.toFixed(4)}, ${position.coords.longitude.toFixed(4)} · GPS`);
        setLocating(false);
      },
      () => {
        setLocationLabel('Using default city coordinates (location denied)');
        setLocating(false);
      },
      { enableHighAccuracy: true, timeout: 8000 },
    );
  };

  const skillHint = useMemo(() => {
    if (issueType === 'BATTERY') return 'Battery jump start';
    if (issueType === 'FLAT_TYRE') return 'Spare tyre fitting';
    if (issueType === 'OUT_OF_FUEL') return 'Fuel delivery';
    if (issueType === 'ACCIDENT') return 'Towing & accident support';
    return 'Nearest general mechanic';
  }, [issueType]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setFields({});
    try {
      const payload: Record<string, unknown> = {
        issueType,
        urgency,
        description: description.trim() || null,
        latitude: location.latitude,
        longitude: location.longitude,
        accuracy: location.accuracy,
        address: address.trim() || null,
        channel: 'WEB',
        vehicleId: vehicleId || null,
      };
      if (isAccident) payload.accidentMode = accident;
      const created = await apiPost<{ id?: string; request?: { id: string } }>('/api/emergencies', payload);
      const createdId = created.request?.id ?? created.id;
      if (!createdId) {
        throw new Error('Your request was created but could not be opened — check your history.');
      }
      router.replace(`/requests/${createdId}`);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'ACTIVE_REQUEST_EXISTS') {
        const existingId = await latestRequestId();
        if (existingId) {
          router.replace(`/requests/${existingId}`);
          return;
        }
      }
      setFields(fieldErrors(err));
      setError(errorMessage(err));
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto max-w-3xl space-y-5">
      <div>
        <h1 className="page-title">Request help</h1>
        <p className="page-subtitle">Tell us what happened — dispatch starts the moment you submit.</p>
      </div>

      {error ? <Alert tone="danger">{error}</Alert> : null}

      <Card>
        <CardHeader>
          <CardTitle>What broke down?</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={submit} className="space-y-4">
            <Field label="Issue type" error={fields.issueType}>
              <div role="group" aria-label="Issue type" className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
                {ISSUE_TYPES.map((type) => {
                  const Icon = ISSUE_ICONS[type];
                  const active = issueType === type;
                  return (
                    <button
                      key={type}
                      type="button"
                      onClick={() => setIssueType(type)}
                      aria-pressed={active}
                      className={cn(
                        'flex flex-col items-start gap-2 rounded-xl border p-3 text-left text-xs font-medium transition',
                        active
                          ? 'border-brand-600 bg-brand-600 text-white shadow-pop'
                          : 'border-slate-200 bg-white text-slate-700 hover:-translate-y-0.5 hover:border-sun-400 hover:bg-sun-50 hover:shadow-card',
                      )}
                    >
                      <span
                        className={cn(
                          'flex h-8 w-8 items-center justify-center rounded-lg',
                          active ? 'bg-white/15 text-sun-300' : 'bg-sun-100 text-ink',
                        )}
                      >
                        <Icon className="h-4 w-4" />
                      </span>
                      <span className="leading-snug">{ISSUE_LABELS[type] ?? type}</span>
                    </button>
                  );
                })}
              </div>
            </Field>

            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Urgency" error={fields.urgency}>
                <div role="group" aria-label="Urgency" className="flex flex-wrap gap-2">
                  {URGENCIES.map((option) => {
                    const active = urgency === option.value;
                    return (
                      <button
                        key={option.value}
                        type="button"
                        onClick={() => setUrgency(option.value)}
                        aria-pressed={active}
                        className={cn(
                          'rounded-full border px-3 py-1.5 text-xs font-medium transition',
                          active
                            ? option.value === 'CRITICAL' || option.value === 'HIGH'
                              ? 'border-rose-600 bg-rose-600 text-white'
                              : 'border-ink bg-ink text-white'
                            : 'border-slate-200 bg-white text-slate-600 hover:border-sun-400 hover:bg-sun-50',
                        )}
                      >
                        {option.label}
                      </button>
                    );
                  })}
                </div>
              </Field>
              <Field label="Vehicle" htmlFor="vehicle" error={fields.vehicleId} hint={skillHint}>
                <Select id="vehicle" value={vehicleId} onChange={(event) => setVehicleId(event.target.value)}>
                  <option value="">No vehicle selected</option>
                  {vehicles.map((vehicle) => (
                    <option key={vehicle.id} value={vehicle.id}>
                      {vehicle.make} {vehicle.model} · {vehicle.registrationNumber}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>

            <Field label="Description (optional)" htmlFor="description" error={fields.description} hint="What happened, sounds, warning lights…">
              <Textarea
                id="description"
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                placeholder="Car won't start, dashboard lights flicker…"
              />
            </Field>

            <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <p className="text-sm font-medium text-slate-800">Breakdown location</p>
                  <p className="text-xs text-slate-500">{locationLabel}</p>
                </div>
                <Button
                  variant="secondary"
                  size="sm"
                  loading={locating}
                  onClick={() => {
                    locate();
                  }}
                >
                  <Crosshair className="h-3.5 w-3.5" />
                  Use my location
                </Button>
              </div>
              <div className="mt-3 grid gap-3 sm:grid-cols-3">
                <Field label="Latitude">
                  <Input
                    value={location.latitude}
                    onChange={(event) => setLocation((prev) => ({ ...prev, latitude: Number(event.target.value) }))}
                  />
                </Field>
                <Field label="Longitude">
                  <Input
                    value={location.longitude}
                    onChange={(event) => setLocation((prev) => ({ ...prev, longitude: Number(event.target.value) }))}
                  />
                </Field>
                <Field label="Address (optional)">
                  <Input value={address} onChange={(event) => setAddress(event.target.value)} placeholder="Landmark or street" />
                </Field>
              </div>
            </div>

            {isAccident ? (
              <div className="rounded-xl border border-rose-200 bg-rose-50 p-4">
                <p className="text-sm font-semibold text-rose-800">Accident mode</p>
                <p className="text-xs text-rose-700">Select everything that applies — this changes who we dispatch.</p>
                <div className="mt-3 grid gap-2 sm:grid-cols-2">
                  {(Object.keys(accident) as (keyof AccidentFlags)[]).map((key) => (
                    <Checkbox
                      key={key}
                      checked={accident[key]}
                      onChange={(event) => setAccident((prev) => ({ ...prev, [key]: event.target.checked }))}
                      label={{
                        driverInjured: 'I am injured',
                        anyoneInjured: 'Someone is injured',
                        blockingTraffic: 'Blocking traffic',
                        needsTowing: 'Needs towing',
                        medicalAssistance: 'Need medical assistance',
                        policeAssistance: 'Need police assistance',
                      }[key]}
                    />
                  ))}
                </div>
              </div>
            ) : null}

            <div className={cn('flex flex-wrap items-center justify-between gap-3')}>
              <p className="text-xs text-slate-500">
                Dispatch scans nearby mechanics instantly and escalates if nobody accepts.
              </p>
              <Button type="submit" variant="sun" loading={busy}>
                Start dispatch
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
