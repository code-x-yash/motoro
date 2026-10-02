'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import type { VehicleDto, Paginated, EmergencyRequestDto } from '@rr/types';
import { ISSUE_TYPES, type IssueType } from '@rr/config';
import { Alert, Button, Card, CardContent, CardHeader, CardTitle, Checkbox, EmptyState, Field, Input, Select, Textarea, cn } from '@rr/ui';
import { Battery, CircleDot, Crosshair, Fuel, Gauge, HelpCircle, ImagePlus, KeyRound, Lightbulb, Siren, Thermometer, Wrench, X } from 'lucide-react';
import { AppShell } from '@/components/app-shell';
import { ApiError, apiGet, apiPost, errorMessage, fieldErrors } from '@/lib/api';
import { MAX_UPLOAD_BYTES, UPLOAD_TYPES, uploadToR2 } from '@/lib/uploads';

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
  { value: 'LOW', label: 'Low: can wait a bit' },
  { value: 'NORMAL', label: 'Normal: standard dispatch' },
  { value: 'HIGH', label: 'High: stranded / unsafe' },
  { value: 'CRITICAL', label: 'Critical: accident or danger' },
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
  const [vehiclesError, setVehiclesError] = useState(false);
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
  const [photos, setPhotos] = useState<File[]>([]);
  const [geoSuggestions, setGeoSuggestions] = useState<Array<{ label: string; latitude: number; longitude: number }>>([]);
  const [geoBusy, setGeoBusy] = useState(false);

  const reverseLookup = (latitude: number, longitude: number) => {
    void apiGet<{ address: { label: string } }>('/api/geo/reverse', { query: { latitude, longitude } })
      .then((data) => {
        if (data.address?.label) setAddress(data.address.label);
      })
      .catch(() => undefined);
  };

  const searchAddress = async () => {
    if (address.trim().length < 2) return;
    setGeoBusy(true);
    setError(null);
    try {
      const data = await apiGet<{ items: Array<{ label: string; latitude: number; longitude: number }> }>(
        '/api/geo/search',
        { query: { query: address.trim(), limit: 5 } },
      );
      setGeoSuggestions(data.items ?? []);
      if ((data.items ?? []).length === 0) setError('No matching addresses found.');
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setGeoBusy(false);
    }
  };

  const addPhotos = (list: FileList | null) => {
    if (!list) return;
    const next = [...photos];
    for (const file of Array.from(list)) {
      if (next.length >= 5) break;
      if (!(UPLOAD_TYPES as readonly string[]).includes(file.type)) {
        setError('Photos must be JPG, PNG or WebP.');
        continue;
      }
      if (file.size > MAX_UPLOAD_BYTES) {
        setError('Each photo must be under 8 MB.');
        continue;
      }
      next.push(file);
    }
    setPhotos(next);
  };

  useEffect(() => {
    void apiGet<Paginated<VehicleDto>>('/api/vehicles', { query: { limit: 20 } })
      .then((data) => {
        setVehicles(data.items);
        if (data.items[0]) setVehicleId(data.items[0].id);
      })
      .catch(() => setVehiclesError(true));
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
        reverseLookup(position.coords.latitude, position.coords.longitude);
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
    const latitude = Number(location.latitude);
    const longitude = Number(location.longitude);
    const accuracy = Number.isFinite(Number(location.accuracy)) ? Number(location.accuracy) : 0;
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || Math.abs(latitude) > 90 || Math.abs(longitude) > 180) {
      setError('Location unavailable. Try again.');
      return;
    }
    setBusy(true);
    setError(null);
    setFields({});
    try {
      const payload: Record<string, unknown> = {
        issueType,
        urgency,
        description: description.trim() || null,
        latitude,
        longitude,
        accuracy,
        address: address.trim() || null,
        channel: 'WEB',
        vehicleId: vehicleId || null,
      };
      if (isAccident) payload.accidentMode = accident;
      if (photos.length > 0) {
        const keys: string[] = [];
        for (const photo of photos) {
          keys.push(await uploadToR2(photo, 'breakdown'));
        }
        payload.photoKeys = keys;
      }
      const created = await apiPost<{ id?: string; request?: { id: string } }>('/api/emergencies', payload);
      const createdId = created.request?.id ?? created.id;
      if (!createdId) {
        throw new Error('Your request was created but could not be opened. Check your history.');
      }
      router.replace(`/requests/detail?id=${createdId}`);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'ACTIVE_REQUEST_EXISTS') {
        const existingId = await latestRequestId();
        if (existingId) {
          router.replace(`/requests/detail?id=${existingId}`);
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
        <p className="page-subtitle">Tell us what happened: dispatch starts the moment you submit.</p>
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
                {vehicles.length === 0 ? (
                  <EmptyState
                    className="px-0 py-4 text-left"
                    title="No vehicles in your garage"
                    description={
                      vehiclesError
                        ? 'Your garage could not be loaded. You can still request help without a vehicle.'
                        : 'Add your car, bike or scooter so dispatch knows what is stranded.'
                    }
                    action={
                      <Link
                        href="/vehicles"
                        className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-brand-600 px-3.5 text-xs font-semibold text-white hover:bg-brand-700"
                      >
                        Add a vehicle
                      </Link>
                    }
                  />
                ) : null}
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

            <Field label="Photos (optional)" htmlFor="photos" hint="Up to 5 images: they help the mechanic arrive prepared.">
              <div className="flex flex-wrap items-center gap-2">
                <label
                  htmlFor="photos"
                  className="inline-flex h-10 cursor-pointer items-center gap-2 rounded-lg border border-dashed border-slate-300 px-3 text-sm font-medium text-slate-600 hover:border-brand-500 hover:text-brand-700"
                >
                  <ImagePlus className="h-4 w-4" /> Add photos
                  <input
                    id="photos"
                    type="file"
                    accept={UPLOAD_TYPES.join(',')}
                    multiple
                    className="hidden"
                    onChange={(event) => {
                      addPhotos(event.target.files);
                      event.target.value = '';
                    }}
                  />
                </label>
                {photos.map((photo, index) => (
                  <span
                    key={`${photo.name}-${index}`}
                    className="inline-flex items-center gap-1.5 rounded-full bg-slate-100 px-2.5 py-1 text-xs text-slate-700"
                  >
                    {photo.name.slice(0, 24)}
                    <button
                      type="button"
                      aria-label={`Remove ${photo.name}`}
                      onClick={() => setPhotos((prev) => prev.filter((_, i) => i !== index))}
                      className="text-slate-400 hover:text-rose-600"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </span>
                ))}
              </div>
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
                  {locationLabel.startsWith('Using default') ? 'Use my location' : 'Refresh location'}
                </Button>
              </div>
              <div className="mt-3 grid gap-3 sm:grid-cols-3">
                <Field label="Latitude" hint="Detected automatically.">
                  <Input
                    readOnly
                    value={Number.isFinite(location.latitude) ? location.latitude.toFixed(5) : ''}
                    className="bg-slate-100 text-slate-600"
                    aria-label="Detected latitude"
                  />
                </Field>
                <Field label="Longitude" hint="Detected automatically.">
                  <Input
                    readOnly
                    value={Number.isFinite(location.longitude) ? location.longitude.toFixed(5) : ''}
                    className="bg-slate-100 text-slate-600"
                    aria-label="Detected longitude"
                  />
                </Field>
                <Field label="Address (optional)" hint="Type an address or use my location to auto-fill.">
                  <div className="flex gap-2">
                    <Input
                      value={address}
                      onChange={(event) => {
                        setAddress(event.target.value);
                        setGeoSuggestions([]);
                      }}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') {
                          event.preventDefault();
                          void searchAddress();
                        }
                      }}
                      placeholder="Landmark or street"
                    />
                    <Button type="button" variant="secondary" loading={geoBusy} onClick={() => void searchAddress()}>
                      Search
                    </Button>
                  </div>
                  {geoSuggestions.length > 0 ? (
                    <ul className="mt-2 divide-y divide-slate-100 rounded-lg border border-slate-200 bg-white">
                      {geoSuggestions.map((suggestion) => (
                        <li key={`${suggestion.latitude},${suggestion.longitude}`}>
                          <button
                            type="button"
                            className="block w-full px-3 py-2 text-left text-xs text-slate-700 hover:bg-sun-50"
                            onClick={() => {
                              setLocation({ latitude: suggestion.latitude, longitude: suggestion.longitude, accuracy: 0 });
                              setAddress(suggestion.label);
                              setLocationLabel(`${suggestion.latitude.toFixed(4)}, ${suggestion.longitude.toFixed(4)} · address search`);
                              setGeoSuggestions([]);
                            }}
                          >
                            {suggestion.label}
                          </button>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </Field>
              </div>
            </div>

            {isAccident ? (
              <div className="rounded-xl border border-rose-200 bg-rose-50 p-4">
                <p className="text-sm font-semibold text-rose-800">Accident mode</p>
                <p className="text-xs text-rose-700">Select everything that applies: this changes who we dispatch.</p>
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
