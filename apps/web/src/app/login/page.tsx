'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { Alert, Button, Card, CardContent, Field, Input } from '@rr/ui';
import { homePathFor, useAuth } from '@/lib/auth';
import { errorMessage, fieldErrors } from '@/lib/api';
import { LandingNav } from '@/components/landing-nav';

const DEMO_ACCOUNTS = [
  { label: 'Driver', email: 'driver1@motoro.test' },
  { label: 'Mechanic', email: 'mechanic6@motoro.test' },
  { label: 'Operations', email: 'ops1@motoro.test' },
  { label: 'Admin', email: 'admin@motoro.test' },
];

export default function LoginPage() {
  const router = useRouter();
  const { login } = useAuth();
  const [email, setEmail] = useState('');
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
      const user = await login(email.trim(), password);
      router.replace(homePathFor(user.role));
    } catch (err) {
      setFields(fieldErrors(err));
      setError(errorMessage(err));
      setBusy(false);
    }
  };

  return (
    <div className="min-h-screen bg-slate-50">
      <LandingNav />
      <div className="mx-auto flex max-w-md flex-col px-4 py-10">
        <h1 className="text-xl font-semibold tracking-tight">Welcome back</h1>
        <p className="mt-1 text-sm text-slate-500">
          Log in to request help or manage jobs.
        </p>

        <Card className="mt-6">
          <CardContent className="py-5">
            {error ? (
              <Alert tone="danger" className="mb-4">
                {error}
              </Alert>
            ) : null}
            <form onSubmit={submit} className="space-y-4">
              <Field label="Email" htmlFor="email" error={fields.email}>
                <Input
                  id="email"
                  type="email"
                  autoComplete="email"
                  required
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  placeholder="you@example.com"
                />
              </Field>
              <Field label="Password" htmlFor="password" error={fields.password}>
                <Input
                  id="password"
                  type="password"
                  autoComplete="current-password"
                  required
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  placeholder="••••••••"
                />
              </Field>
              <div className="-mt-2 text-right">
                <Link
                  href="/forgot-password"
                  className="text-xs font-medium text-brand-700 hover:underline"
                >
                  Forgot password?
                </Link>
              </div>
              <Button type="submit" loading={busy} fullWidth>
                Log in
              </Button>
            </form>

            <div className="mt-5 border-t border-slate-100 pt-4">
              <p className="text-xs font-medium text-slate-500">Demo accounts (seeded data)</p>
              <div className="mt-2 flex flex-wrap gap-2">
                {DEMO_ACCOUNTS.map((account) => (
                  <button
                    key={account.email}
                    type="button"
                    onClick={() => {
                      setEmail(account.email);
                      setPassword('Demo@1234');
                    }}
                    className="rounded-lg border border-slate-200 bg-white px-2.5 py-1 text-xs text-slate-600 hover:border-brand-300 hover:text-brand-700"
                  >
                    {account.label}
                  </button>
                ))}
              </div>
              <p className="mt-2 text-[11px] text-slate-400">Password for all demo accounts: Demo@1234</p>
            </div>
          </CardContent>
        </Card>

        <p className="mt-4 text-center text-sm text-slate-500">
          New to Motoro?{' '}
          <Link href="/register" className="font-medium text-brand-700 hover:underline">
            Create an account
          </Link>
        </p>
      </div>
    </div>
  );
}
