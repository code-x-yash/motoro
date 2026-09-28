'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState, type FormEvent } from 'react';
import type { Role } from '@rr/types';
import { Alert, Button, Card, CardContent, Field, Input, Select } from '@rr/ui';
import { homePathFor, useAuth } from '@/lib/auth';
import { errorMessage, fieldErrors } from '@/lib/api';
import { LandingNav } from '@/components/landing-nav';

const ROLE_OPTIONS: { value: Role; label: string }[] = [
  { value: 'DRIVER', label: 'Driver — I need roadside help' },
  { value: 'MECHANIC', label: 'Mechanic — I fix vehicles' },
  { value: 'WORKSHOP', label: 'Workshop — I run a garage' },
  { value: 'TOWING_PARTNER', label: 'Towing partner — I run tow trucks' },
];

function RegisterForm() {
  const router = useRouter();
  const search = useSearchParams();
  const { register } = useAuth();
  const initialRole = search.get('role');
  const [role, setRole] = useState<Role>(
    ROLE_OPTIONS.some((option) => option.value === initialRole) ? (initialRole as Role) : 'DRIVER',
  );
  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setFields({});
    try {
      const user = await register({
        fullName: fullName.trim(),
        email: email.trim(),
        phone: phone.trim() || undefined,
        password,
        role,
      });
      router.replace(homePathFor(user.role));
    } catch (err) {
      setFields(fieldErrors(err));
      setError(errorMessage(err));
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto flex max-w-md flex-col px-4 py-10">
      <h1 className="text-xl font-semibold tracking-tight">Create your account</h1>
      <p className="mt-1 text-sm text-slate-500">Drivers, mechanics, workshops and operators.</p>

      <Card className="mt-6">
        <CardContent className="py-5">
          {error ? (
            <Alert tone="danger" className="mb-4">
              {error}
            </Alert>
          ) : null}
          <form onSubmit={submit} className="space-y-4">
            <Field label="I am a" htmlFor="role" error={fields.role}>
              <Select id="role" value={role} onChange={(event) => setRole(event.target.value as Role)}>
                {ROLE_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Full name" htmlFor="fullName" error={fields.fullName}>
              <Input
                id="fullName"
                required
                value={fullName}
                onChange={(event) => setFullName(event.target.value)}
                placeholder="Yash Rajora"
              />
            </Field>
            <Field label="Email" htmlFor="email" error={fields.email}>
              <Input
                id="email"
                type="email"
                required
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                placeholder="you@example.com"
              />
            </Field>
            <Field label="Phone (optional)" htmlFor="phone" error={fields.phone} hint="Used for SMS/WhatsApp dispatch updates.">
              <Input
                id="phone"
                type="tel"
                value={phone}
                onChange={(event) => setPhone(event.target.value)}
                placeholder="98765 43210"
              />
            </Field>
            <Field label="Password" htmlFor="password" error={fields.password} hint="At least 8 characters with a number and a symbol.">
              <Input
                id="password"
                type="password"
                required
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                placeholder="••••••••"
              />
            </Field>
            <Button type="submit" loading={busy} fullWidth>
              Create account
            </Button>
          </form>
        </CardContent>
      </Card>

      <p className="mt-4 text-center text-sm text-slate-500">
        Already have an account?{' '}
        <Link href="/login" className="font-medium text-brand-700 hover:underline">
          Log in
        </Link>
      </p>
    </div>
  );
}

export default function RegisterPage() {
  return (
    <div className="min-h-screen bg-slate-50">
      <LandingNav />
      <Suspense>
        <RegisterForm />
      </Suspense>
    </div>
  );
}
