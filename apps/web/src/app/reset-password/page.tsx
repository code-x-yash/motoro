'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState, type FormEvent } from 'react';
import { Alert, Button, Card, CardContent, Field, Input } from '@rr/ui';
import { CheckCircle2 } from 'lucide-react';
import { apiPost, errorMessage, fieldErrors } from '@/lib/api';
import { LandingNav } from '@/components/landing-nav';
import { AuthLayout } from '@/components/auth-layout';

function ResetForm() {
  const router = useRouter();
  const search = useSearchParams();
  const token = search.get('token') ?? '';
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (password !== confirm) {
      setFields({ confirm: 'Passwords do not match.' });
      return;
    }
    setBusy(true);
    setError(null);
    setFields({});
    try {
      await apiPost('/api/auth/reset-password', { token, password });
      setDone(true);
    } catch (err) {
      setFields(fieldErrors(err));
      setError(errorMessage(err));
      setBusy(false);
    }
  };

  return (
    <AuthLayout
      headline="Pick a fresh password and you're back on the road."
      blurb="Reset links are single-use and expire in one hour — set a new password and log in."
      footer={
        <>
          Remembered it?{' '}
          <Link href="/login" className="font-medium text-brand-700 hover:underline">
            Back to log in
          </Link>
        </>
      }
    >
      <h1 className="text-2xl font-bold tracking-tight text-ink sm:text-3xl">
        Choose a new password
      </h1>
      <p className="mt-1 text-sm text-slate-500">This link can be used once.</p>

      <Card className="mt-6">
        <CardContent className="py-5">
          {done ? (
            <div className="space-y-4 text-center">
              <CheckCircle2 className="mx-auto h-10 w-10 text-emerald-500" />
              <div>
                <p className="text-base font-semibold text-ink">Password updated</p>
                <p className="mt-1 text-sm text-slate-500">
                  For safety we signed you out on every device — log in with your new
                  password.
                </p>
              </div>
              <Button
                fullWidth
                onClick={() => {
                  router.replace('/login');
                }}
              >
                Go to log in
              </Button>
            </div>
          ) : !token ? (
            <Alert tone="danger" title="Invalid link">
              This reset link is missing its token. Request a new one from the
              <Link href="/forgot-password" className="font-medium underline">
                {' '}
                forgot password{' '}
              </Link>
              page.
            </Alert>
          ) : (
            <>
              {error ? (
                <Alert tone="danger" className="mb-4">
                  {error}
                </Alert>
              ) : null}
              <form onSubmit={submit} className="space-y-4">
                <Field
                  label="New password"
                  htmlFor="password"
                  error={fields.password}
                  hint="At least 8 characters with a number and a symbol."
                >
                  <Input
                    id="password"
                    type="password"
                    autoComplete="new-password"
                    required
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                    placeholder="••••••••"
                  />
                </Field>
                <Field label="Confirm password" htmlFor="confirm" error={fields.confirm}>
                  <Input
                    id="confirm"
                    type="password"
                    autoComplete="new-password"
                    required
                    value={confirm}
                    onChange={(event) => setConfirm(event.target.value)}
                    placeholder="••••••••"
                  />
                </Field>
                <Button type="submit" loading={busy} fullWidth>
                  Update password
                </Button>
              </form>
            </>
          )}
        </CardContent>
      </Card>
    </AuthLayout>
  );
}

export default function ResetPasswordPage() {
  return (
    <div className="min-h-screen bg-canvas">
      <LandingNav />
      <Suspense>
        <ResetForm />
      </Suspense>
    </div>
  );
}
