'use client';

import { useEffect, useState, type FormEvent } from 'react';
import type { MechanicProfileDto } from '@rr/types';
import { Alert, Badge, Button, Card, CardContent, CardHeader, CardTitle, Field, Input, LoadingState, Select, Textarea } from '@rr/ui';
import { AppShell } from '@/components/app-shell';
import { apiDelete, apiGet, apiPatch, apiPost, errorMessage, fieldErrors } from '@/lib/api';

interface AvailabilitySlot {
  id: string;
  dayOfWeek: number;
  startMinute: number;
  endMinute: number;
}

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function minutesToTime(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function timeToMinutes(value: string): number {
  const [h, m] = value.split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
}

export default function MechanicSettingsPage() {
  return (
    <AppShell roles={['MECHANIC', 'WORKSHOP', 'TOWING_PARTNER']}>
      <MechanicSettings />
    </AppShell>
  );
}

function MechanicSettings() {
  const [profile, setProfile] = useState<MechanicProfileDto | null>(null);
  const [slots, setSlots] = useState<AvailabilitySlot[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  const [bio, setBio] = useState('');
  const [skills, setSkills] = useState('');
  const [address, setAddress] = useState('');
  const [radius, setRadius] = useState('10');
  const [experience, setExperience] = useState('3');
  const [documentKey, setDocumentKey] = useState('');

  const [slot, setSlot] = useState({ day: '1', start: '09:00', end: '18:00' });

  const load = async () => {
    try {
      const [profilePayload, slotData] = await Promise.all([
        apiGet<{ profile?: MechanicProfileDto } & Partial<MechanicProfileDto>>('/api/mechanics/me'),
        apiGet<{ items: AvailabilitySlot[] }>('/api/mechanics/me/availability').catch(() => ({ items: [] })),
      ]);
      const profileData = (profilePayload.profile ?? profilePayload) as MechanicProfileDto;
      setProfile(profileData);
      setBio(profileData.bio ?? '');
      setSkills((profileData.skills ?? []).join(', '));
      setAddress(profileData.address ?? '');
      setRadius(String(profileData.serviceRadiusKm));
      setExperience(String(profileData.experienceYears));
      setSlots(slotData.items);
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const saveProfile = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setFields({});
    try {
      await apiPatch('/api/mechanics/me', {
        bio: bio.trim() || null,
        address: address.trim() || null,
        serviceRadiusKm: Number(radius) || 10,
        skills: skills
          .split(',')
          .map((skill) => skill.trim())
          .filter(Boolean),
      });
      await load();
    } catch (err) {
      setFields(fieldErrors(err));
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const submitVerification = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setFields({});
    try {
      await apiPost('/api/mechanics/me/verification', {
        experienceYears: Number(experience) || 0,
        address: address.trim() || 'Address pending',
        documentKey: documentKey.trim() || undefined,
      });
      await load();
    } catch (err) {
      setFields(fieldErrors(err));
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const addSlot = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    try {
      await apiPost('/api/mechanics/me/availability', {
        dayOfWeek: Number(slot.day),
        startMinute: timeToMinutes(slot.start),
        endMinute: timeToMinutes(slot.end),
      });
      const data = await apiGet<{ items: AvailabilitySlot[] }>('/api/mechanics/me/availability');
      setSlots(data.items);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const removeSlot = async (id: string) => {
    try {
      await apiDelete(`/api/mechanics/me/availability/${id}`);
      setSlots((prev) => prev.filter((item) => item.id !== id));
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  if (loading) return <LoadingState label="Loading profile…" />;

  return (
    <div className="space-y-5">
      <div>
        <h1 className="page-title">Mechanic settings</h1>
        <p className="page-subtitle">Verification, service area, skills and working hours.</p>
      </div>

      {error ? <Alert tone="danger">{error}</Alert> : null}

      <div className="grid gap-5 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Verification</CardTitle>
            <Badge tone={profile?.verificationStatus === 'VERIFIED' ? 'emerald' : 'amber'}>
              {profile?.verificationStatus ?? 'UNKNOWN'}
            </Badge>
          </CardHeader>
          <CardContent>
            <form onSubmit={submitVerification} className="space-y-3">
              <p className="text-xs text-slate-500">
                Submit your experience and address for admin review. You go online only after approval.
              </p>
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Experience (years)" error={fields.experienceYears}>
                  <Input type="number" min={0} max={60} value={experience} onChange={(event) => setExperience(event.target.value)} />
                </Field>
                <Field label="Document key (optional)" error={fields.documentKey} hint="Presigned R2 key of your licence/ID">
                  <Input value={documentKey} onChange={(event) => setDocumentKey(event.target.value)} />
                </Field>
              </div>
              <Field label="Workshop / pickup address" error={fields.address}>
                <Input value={address} onChange={(event) => setAddress(event.target.value)} />
              </Field>
              <Button type="submit" loading={busy} disabled={profile?.verificationStatus === 'VERIFIED'}>
                Submit for review
              </Button>
            </form>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Service profile</CardTitle>
          </CardHeader>
          <CardContent>
            <form onSubmit={saveProfile} className="space-y-3">
              <Field label="Bio">
                <Textarea value={bio} onChange={(event) => setBio(event.target.value)} placeholder="8 years on two-wheeler electricals…" />
              </Field>
              <Field label="Skills (comma separated)" error={fields.skills} hint="battery, electrical, engine, tyre…">
                <Input value={skills} onChange={(event) => setSkills(event.target.value)} />
              </Field>
              <Field label="Service radius (km)" error={fields.serviceRadiusKm}>
                <Input type="number" min={1} max={500} value={radius} onChange={(event) => setRadius(event.target.value)} />
              </Field>
              <Button type="submit" loading={busy}>
                Save profile
              </Button>
            </form>
          </CardContent>
        </Card>

        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Weekly availability</CardTitle>
            <span className="text-xs text-slate-500">{slots.length} windows</span>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex flex-wrap gap-2">
              {slots.map((item) => (
                <span
                  key={item.id}
                  className="inline-flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-2.5 py-1 text-xs text-slate-700"
                >
                  {DAYS[item.dayOfWeek]} {minutesToTime(item.startMinute)}–{minutesToTime(item.endMinute)}
                  <button type="button" className="text-slate-400 hover:text-rose-600" onClick={() => void removeSlot(item.id)}>
                    ✕
                  </button>
                </span>
              ))}
              {slots.length === 0 ? <p className="text-sm text-slate-500">No windows configured — you will receive offers whenever you are online.</p> : null}
            </div>

            <form onSubmit={addSlot} className="flex flex-wrap items-end gap-3 border-t border-slate-100 pt-4">
              <Field label="Day">
                <Select value={slot.day} onChange={(event) => setSlot((prev) => ({ ...prev, day: event.target.value }))}>
                  {DAYS.map((day, index) => (
                    <option key={day} value={String(index)}>
                      {day}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Start">
                <Input type="time" value={slot.start} onChange={(event) => setSlot((prev) => ({ ...prev, start: event.target.value }))} />
              </Field>
              <Field label="End">
                <Input type="time" value={slot.end} onChange={(event) => setSlot((prev) => ({ ...prev, end: event.target.value }))} />
              </Field>
              <Button type="submit" variant="secondary" loading={busy}>
                Add window
              </Button>
            </form>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
