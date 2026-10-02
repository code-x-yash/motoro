'use client';

import { useEffect, useState, type FormEvent } from 'react';
import type { FuelType, Paginated, VehicleDto, VehicleType } from '@rr/types';
import {
  Alert,
  Button,
  Card,
  CardContent,
  EmptyState,
  Field,
  Input,
  LoadingState,
  Modal,
  Select,
  cn,
} from '@rr/ui';
import { Car, Plus, Trash2 } from 'lucide-react';
import { AppShell } from '@/components/app-shell';
import { apiDelete, apiGet, apiPatch, apiPost, errorMessage, fieldErrors } from '@/lib/api';
import { titleCase } from '@/lib/format';

const FUEL_TYPES: FuelType[] = ['PETROL', 'DIESEL', 'CNG', 'ELECTRIC', 'HYBRID'];
const VEHICLE_TYPES: VehicleType[] = ['TWO_WHEELER', 'CAR', 'SUV', 'SCOOTER', 'COMMERCIAL', 'EV'];

function formatDate(value: string | null | undefined): string {
  if (!value) return 'None';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
}

interface FormState {
  registrationNumber: string;
  make: string;
  model: string;
  variant: string;
  year: string;
  fuelType: FuelType;
  vehicleType: VehicleType;
  insuranceExpiry: string;
  rcNumber: string;
  color: string;
}

const EMPTY: FormState = {
  registrationNumber: '',
  make: '',
  model: '',
  variant: '',
  year: '',
  fuelType: 'PETROL',
  vehicleType: 'CAR',
  insuranceExpiry: '',
  rcNumber: '',
  color: '',
};

export default function VehiclesPage() {
  return (
    <AppShell>
      <VehiclesContent />
    </AppShell>
  );
}

function VehiclesContent() {
  const [vehicles, setVehicles] = useState<VehicleDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<VehicleDto | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY);
  const [fields, setFields] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [confirmTarget, setConfirmTarget] = useState<VehicleDto | null>(null);
  const [removing, setRemoving] = useState(false);

  const load = () =>
    void apiGet<Paginated<VehicleDto>>('/api/vehicles', { query: { limit: 50 } })
      .then((data) => setVehicles(data.items))
      .catch((err) => setError(errorMessage(err)))
      .finally(() => setLoading(false));

  useEffect(() => {
    void load();
  }, []);

  const openCreate = () => {
    setEditing(null);
    setForm(EMPTY);
    setFields({});
    setFormError(null);
    setModalOpen(true);
  };

  const openEdit = (vehicle: VehicleDto) => {
    setEditing(vehicle);
    setForm({
      registrationNumber: vehicle.registrationNumber,
      make: vehicle.make,
      model: vehicle.model,
      variant: vehicle.variant ?? '',
      year: vehicle.year ? String(vehicle.year) : '',
      fuelType: vehicle.fuelType,
      vehicleType: vehicle.vehicleType,
      insuranceExpiry: vehicle.insuranceExpiry ?? '',
      rcNumber: vehicle.rcNumber ?? '',
      color: vehicle.color ?? '',
    });
    setFields({});
    setFormError(null);
    setModalOpen(true);
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setFields({});
    setFormError(null);
    const payload = {
      registrationNumber: form.registrationNumber.trim().toUpperCase(),
      make: form.make.trim(),
      model: form.model.trim(),
      variant: form.variant.trim() || null,
      year: form.year ? Number(form.year) : null,
      fuelType: form.fuelType,
      vehicleType: form.vehicleType,
      insuranceExpiry: form.insuranceExpiry || null,
      rcNumber: form.rcNumber.trim() || null,
      color: form.color.trim() || null,
    };
    try {
      if (editing) {
        await apiPatch(`/api/vehicles/${editing.id}`, payload);
      } else {
        await apiPost('/api/vehicles', payload);
      }
      setModalOpen(false);
      await load();
    } catch (err) {
      setFields(fieldErrors(err));
      setFormError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (vehicle: VehicleDto) => {
    setRemoving(true);
    try {
      await apiDelete(`/api/vehicles/${vehicle.id}`);
      setVehicles((prev) => prev.filter((item) => item.id !== vehicle.id));
      setConfirmTarget(null);
    } catch (err) {
      setError(errorMessage(err));
      setConfirmTarget(null);
    } finally {
      setRemoving(false);
    }
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="page-title">Vehicles</h1>
          <p className="page-subtitle">Your garage: prefill requests and dispatch with the right parts.</p>
        </div>
        <Button onClick={openCreate}>
          <Plus className="h-4 w-4" /> Add vehicle
        </Button>
      </div>

      {error ? <Alert tone="danger">{error}</Alert> : null}

      {loading ? <LoadingState label="Loading garage…" /> : null}

      {!loading && vehicles.length === 0 ? (
        <Card>
          <EmptyState
            title="No vehicles yet"
            description="Add your car, bike or scooter so dispatch knows what is stranded."
            action={<Button onClick={openCreate}>Add your first vehicle</Button>}
            icon={<Car className="h-10 w-10" />}
          />
        </Card>
      ) : !loading ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {vehicles.map((vehicle) => (
            <Card key={vehicle.id}>
              <CardContent className="space-y-3">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <p className="text-sm font-semibold text-slate-900">
                      {vehicle.make} {vehicle.model}
                      {vehicle.variant ? ` ${vehicle.variant}` : ''}
                    </p>
                    <p className="text-xs text-slate-500">
                      {vehicle.registrationNumber} · {titleCase(vehicle.fuelType)} · {titleCase(vehicle.vehicleType)}
                    </p>
                  </div>
                  <span className="rounded-md bg-slate-100 px-2 py-1 text-xs text-slate-500">
                    {vehicle.year ?? 'None'}
                  </span>
                </div>
                <div className="flex flex-wrap gap-3 text-xs text-slate-500">
                  {vehicle.color ? <span>Color: {vehicle.color}</span> : null}
                  {vehicle.rcNumber ? <span>RC: {vehicle.rcNumber}</span> : null}
                  {vehicle.insuranceExpiry ? <span>Insurance: {formatDate(vehicle.insuranceExpiry)}</span> : null}
                </div>
                <div className="flex gap-2">
                  <Button size="sm" variant="secondary" onClick={() => openEdit(vehicle)}>
                    Edit
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="text-rose-600"
                    aria-label={`Remove ${vehicle.registrationNumber}`}
                    onClick={() => setConfirmTarget(vehicle)}
                  >
                    <Trash2 className="h-3.5 w-3.5" /> Remove
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      ) : null}

      <Modal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        title={editing ? 'Edit vehicle' : 'Add vehicle'}
        wide
      >
        <form onSubmit={submit} className="grid gap-4 sm:grid-cols-2">
          {formError ? (
            <div className="sm:col-span-2">
              <Alert tone="danger">{formError}</Alert>
            </div>
          ) : null}
          <Field label="Registration number" error={fields.registrationNumber} className={cn('sm:col-span-1')}>
            <Input
              required
              value={form.registrationNumber}
              onChange={(event) => setForm((prev) => ({ ...prev, registrationNumber: event.target.value }))}
              placeholder="MH 01 AB 1234"
            />
          </Field>
          <Field label="Make" error={fields.make}>
            <Input required value={form.make} onChange={(event) => setForm((prev) => ({ ...prev, make: event.target.value }))} placeholder="Maruti" />
          </Field>
          <Field label="Model" error={fields.model}>
            <Input required value={form.model} onChange={(event) => setForm((prev) => ({ ...prev, model: event.target.value }))} placeholder="Swift" />
          </Field>
          <Field label="Variant (optional)" error={fields.variant}>
            <Input value={form.variant} onChange={(event) => setForm((prev) => ({ ...prev, variant: event.target.value }))} placeholder="VXi" />
          </Field>
          <Field label="Year" error={fields.year}>
            <Input
              type="number"
              min={1950}
              max={2035}
              value={form.year}
              onChange={(event) => setForm((prev) => ({ ...prev, year: event.target.value }))}
            />
          </Field>
          <Field label="Fuel" error={fields.fuelType}>
            <Select value={form.fuelType} onChange={(event) => setForm((prev) => ({ ...prev, fuelType: event.target.value as FuelType }))}>
              {FUEL_TYPES.map((fuel) => (
                <option key={fuel} value={fuel}>
                  {fuel}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Type" error={fields.vehicleType}>
            <Select
              value={form.vehicleType}
              onChange={(event) => setForm((prev) => ({ ...prev, vehicleType: event.target.value as VehicleType }))}
            >
              {VEHICLE_TYPES.map((type) => (
                <option key={type} value={type}>
                  {type}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Colour (optional)" error={fields.color}>
            <Input value={form.color} onChange={(event) => setForm((prev) => ({ ...prev, color: event.target.value }))} />
          </Field>
          <Field label="Insurance expiry" error={fields.insuranceExpiry}>
            <Input
              type="date"
              value={form.insuranceExpiry}
              onChange={(event) => setForm((prev) => ({ ...prev, insuranceExpiry: event.target.value }))}
            />
          </Field>
          <Field label="RC number (optional)" error={fields.rcNumber}>
            <Input value={form.rcNumber} onChange={(event) => setForm((prev) => ({ ...prev, rcNumber: event.target.value }))} />
          </Field>
          <div className="flex justify-end gap-2 sm:col-span-2">
            <Button variant="secondary" onClick={() => setModalOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" loading={busy}>
              {editing ? 'Save changes' : 'Add vehicle'}
            </Button>
          </div>
        </form>
      </Modal>

      <Modal
        open={Boolean(confirmTarget)}
        onClose={() => setConfirmTarget(null)}
        title="Remove this vehicle?"
        footer={
          <>
            <Button variant="secondary" onClick={() => setConfirmTarget(null)}>
              Cancel
            </Button>
            <Button variant="danger" loading={removing} onClick={() => confirmTarget && void remove(confirmTarget)}>
              Remove
            </Button>
          </>
        }
      >
        <p className="text-sm text-slate-600">
          {confirmTarget
            ? `${confirmTarget.registrationNumber} will be removed from your garage. Past requests keep their records.`
            : null}
        </p>
      </Modal>
    </div>
  );
}
