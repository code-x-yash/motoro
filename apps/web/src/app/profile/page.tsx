'use client';

import { useEffect, useState, type FormEvent } from 'react';
import type { EmergencyContactDto } from '@rr/types';
import {
  Alert,
  Avatar,
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
  Select,
} from '@rr/ui';
import { Trash2 } from 'lucide-react';
import { AppShell } from '@/components/app-shell';
import { apiDelete, apiGet, apiPatch, apiPost, fieldErrors } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { formatDateTime, titleCase } from '@/lib/format';

export default function ProfilePage() {
  return (
    <AppShell>
      <ProfileContent />
    </AppShell>
  );
}

function ProfileContent() {
  const { user, profile, refresh } = useAuth();
  const [fullName, setFullName] = useState('');
  const [phone, setPhone] = useState('');
  const [locale, setLocale] = useState<'en' | 'hi'>('en');
  const [contacts, setContacts] = useState<EmergencyContactDto[]>([]);
  const [fields, setFields] = useState<Record<string, string>>({});
  const [loaded, setLoaded] = useState(false);
  const [notifPrefs, setNotifPrefs] = useState<Record<string, boolean>>({});
  const [notifSaved, setNotifSaved] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (!user) return;
    setFullName(user.fullName);
    setPhone(user.phone ?? '');
    setLocale(user.locale);
    void apiGet<{ items: EmergencyContactDto[] }>('/api/me/emergency-contacts')
      .then((data) => setContacts(data.items ?? []))
      .catch(() => undefined)
      .finally(() => setLoaded(true));
    void apiGet<{ notifications: Record<string, boolean> }>('/api/me/preferences')
      .then((data) => setNotifPrefs(data.notifications ?? {}))
      .catch(() => undefined);
  }, [user]);

  const header = (
    <div>
      <h1 className="page-title">Profile</h1>
      <p className="page-subtitle">Account details, notification preferences and emergency contacts.</p>
    </div>
  );

  if (!user) {
    return (
      <div className="max-w-5xl space-y-5">
        {header}
        <LoadingState label="Loading your profile…" />
      </div>
    );
  }

  const saveProfile = async (event: FormEvent) => {
    event.preventDefault();
    setFields({});
    try {
      await apiPatch('/api/me', { fullName: fullName.trim(), phone: phone.trim() || undefined, locale });
      await refresh();
      setSaved(true);
      window.setTimeout(() => setSaved(false), 3000);
    } catch (err) {
      setFields(fieldErrors(err));
    }
  };

  const addContact = async (event: FormEvent) => {
    event.preventDefault();
    const form = event.target as HTMLFormElement;
    const data = new FormData(form);
    try {
      await apiPost('/api/me/emergency-contacts', {
        name: String(data.get('name') ?? ''),
        phone: String(data.get('phone') ?? ''),
        relationship: String(data.get('relationship') ?? ''),
      });
      form.reset();
      const list = await apiGet<{ items: EmergencyContactDto[] }>('/api/me/emergency-contacts');
      setContacts(list.items ?? []);
    } catch (err) {
      setFields(fieldErrors(err));
    }
  };

  const removeContact = async (id: string) => {
    try {
      await apiDelete(`/api/me/emergency-contacts/${id}`);
      setContacts((prev) => prev.filter((contact) => contact.id !== id));
    } catch (err) {
      setFields(fieldErrors(err));
    }
  };

  const toggleChannel = async (channel: 'EMAIL' | 'SMS' | 'WHATSAPP' | 'PUSH', enabled: boolean) => {
    setNotifSaved(false);
    const previous = notifPrefs;
    setNotifPrefs((prev) => {
      const next = { ...prev };
      if (enabled) delete next[channel];
      else next[channel] = false;
      return next;
    });
    try {
      const data = await apiPatch<{ notifications: Record<string, boolean> }>('/api/me/preferences', {
        notifications: { [channel]: enabled },
      });
      setNotifPrefs(data.notifications ?? {});
      setNotifSaved(true);
    } catch (err) {
      setNotifPrefs(previous);
      setFields(fieldErrors(err));
    }
  };

  const CHANNELS: Array<{ key: 'EMAIL' | 'SMS' | 'WHATSAPP' | 'PUSH'; label: string; hint: string }> = [
    { key: 'EMAIL', label: 'Email', hint: 'Quotes, invoices and account alerts' },
    { key: 'SMS', label: 'SMS', hint: 'OTPs, dispatch and ETA updates' },
    { key: 'WHATSAPP', label: 'WhatsApp', hint: 'Quick status messages' },
    { key: 'PUSH', label: 'Push', hint: 'Browser push notifications' },
  ];

  return (
    <div className="grid max-w-5xl gap-5 lg:grid-cols-3">
      <div className="lg:col-span-3">{header}</div>

      <Card className="lg:col-span-1">
        <CardContent className="space-y-4 py-6">
          <div className="flex items-center gap-3">
            <Avatar name={user.fullName} className="h-12 w-12 text-sm" />
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold text-slate-900">{user.fullName}</p>
              <p className="truncate text-xs text-slate-500">{user.email}</p>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <Badge tone="blue">{titleCase(user.role)}</Badge>
            <Badge tone={user.status === 'ACTIVE' ? 'emerald' : 'rose'}>{titleCase(user.status)}</Badge>
            {profile && 'verificationStatus' in profile ? (
              <Badge tone={profile.verificationStatus === 'VERIFIED' ? 'emerald' : 'amber'}>
                {profile.verificationStatus ? titleCase(profile.verificationStatus) : 'Unknown'}
              </Badge>
            ) : null}
          </div>
          <dl className="space-y-2 text-xs">
            <div className="flex justify-between">
              <dt className="text-slate-500">Member since</dt>
              <dd className="font-medium text-slate-700">{formatDateTime(user.createdAt)}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-slate-500">Phone</dt>
              <dd className="font-medium text-slate-700">{user.phone ?? 'None'}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-slate-500">Email verified</dt>
              <dd className="font-medium text-slate-700">{user.emailVerifiedAt ? 'Yes' : 'No'}</dd>
            </div>
          </dl>
        </CardContent>
      </Card>

      <div className="space-y-5 lg:col-span-2">
        <Card>
          <CardHeader>
            <CardTitle>Account</CardTitle>
          </CardHeader>
          <CardContent>
            {saved ? (
              <Alert tone="success" className="mb-4">
                Profile saved.
              </Alert>
            ) : null}
            <form onSubmit={saveProfile} className="grid gap-4 sm:grid-cols-2">
              <Field label="Full name" error={fields.fullName}>
                <Input value={fullName} onChange={(event) => setFullName(event.target.value)} />
              </Field>
              <Field label="Phone" error={fields.phone}>
                <Input value={phone} onChange={(event) => setPhone(event.target.value)} />
              </Field>
              <Field label="Preferred language" error={fields.locale}>
                <Select value={locale} onChange={(event) => setLocale(event.target.value as 'en' | 'hi')}>
                  <option value="en">English</option>
                  <option value="hi">हिन्दी</option>
                </Select>
              </Field>
              <div className="flex items-end sm:col-span-2">
                <Button type="submit">Save profile</Button>
              </div>
            </form>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Notifications</CardTitle>
            <span className="text-xs text-slate-500">In-app alerts are always on. Choose where else to reach you.</span>
          </CardHeader>
          <CardContent className="space-y-2">
            <div className="flex items-center justify-between gap-3 rounded-lg border border-slate-100 bg-slate-50 px-3 py-2">
              <div>
                <p className="text-sm font-medium text-slate-800">In-app</p>
                <p className="text-xs text-slate-500">Bell inbox and live updates</p>
              </div>
              <input type="checkbox" checked disabled className="h-4 w-4 accent-slate-400" aria-label="In-app enabled" />
            </div>
            {CHANNELS.map((channel) => {
              const enabled = notifPrefs[channel.key] !== false;
              return (
                <label
                  key={channel.key}
                  className="flex cursor-pointer items-center justify-between gap-3 rounded-lg border border-slate-100 px-3 py-2 hover:bg-slate-50"
                >
                  <div>
                    <p className="text-sm font-medium text-slate-800">{channel.label}</p>
                    <p className="text-xs text-slate-500">{channel.hint}</p>
                  </div>
                  <input
                    type="checkbox"
                    checked={enabled}
                    onChange={(event) => void toggleChannel(channel.key, event.target.checked)}
                    className="h-4 w-4 accent-brand-600"
                  />
                </label>
              );
            })}
            {notifSaved ? <p className="text-xs font-medium text-emerald-600">Preferences saved.</p> : null}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Emergency contacts</CardTitle>
            <span className="text-xs text-slate-500">They receive live status when you share a request.</span>
          </CardHeader>
          <CardContent className="space-y-4">
            {!loaded ? <LoadingState /> : null}
            {contacts.length === 0 && loaded ? (
              <EmptyState
                title="No emergency contacts yet"
                description="Add someone we can keep updated while you are on the road."
                action={
                  <Button variant="secondary" onClick={() => document.getElementById('contact-name')?.focus()}>
                    Add a contact
                  </Button>
                }
              />
            ) : (
              <div className="space-y-2">
                {contacts.map((contact) => (
                  <div key={contact.id} className="flex items-center justify-between gap-3 rounded-lg border border-slate-100 px-3 py-2">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-slate-800">{contact.name}</p>
                      <p className="truncate text-xs text-slate-500">
                        {contact.phone} · {contact.relationship}
                      </p>
                    </div>
                    <Button
                      size="sm"
                      variant="ghost"
                      aria-label={`Remove ${contact.name}`}
                      onClick={() => void removeContact(contact.id)}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                ))}
              </div>
            )}

            <form onSubmit={addContact} className="grid gap-3 sm:grid-cols-4">
              <Field label="Name">
                <Input id="contact-name" name="name" required placeholder="Sunita" />
              </Field>
              <Field label="Phone">
                <Input name="phone" required placeholder="98765 43210" />
              </Field>
              <Field label="Relationship">
                <Input name="relationship" required placeholder="Mother" />
              </Field>
              <div className="flex items-end">
                <Button type="submit" variant="secondary" fullWidth>
                  Add
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
