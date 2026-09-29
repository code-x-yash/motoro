'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState, type FormEvent } from 'react';
import { Alert, Button, Card, CardContent, Field, Input, LoadingState } from '@rr/ui';
import { apiPost, errorMessage, fieldErrors } from '@/lib/api';
import { LandingNav } from '@/components/landing-nav';

function ResetPasswordForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const token = searchParams.get('token') ?? '';
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
      setTimeout(() => router.replace('/login'), 1500);
    } catch (err) {
      setFields(fieldErrors(err));
      setError(errorMessage(err));
      setBusy(false);
    }
  };

  if (!token) {
    return (
      <Card className="mt-6">
        <CardContent className="py-5">
          <Alert tone="danger">
            This reset link is missing its token. Request a new link from the
            <Link href="/forgot-password" className="font-medium underline"> forgot password </Link>
            page.
          </Alert>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="mt-6">
      <CardContent className="py-5">
        {done ? (
          <Alert tone="success">Password updated. Redirecting you to login…</Alert>
        ) : (
          <>
            {error ? (
              <Alert tone="danger" className="mb-4">
                {error}
              </Alert>
            ) : null}
            <form onSubmit={submit} className="space-y-4">
              <Field label="New password" htmlFor="password" error={fields.password}>
                <Input
                  id="password"
                  type="password"
                  autoComplete="new-password"
                  required
                  minLength={8}
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
                  minLength={8}
                  value={confirm}
                  onChange={(event) => setConfirm(event.target.value)}
                  placeholder="••••••••"
                />
              </Field>
              <Button type="submit" loading={busy} fullWidth>
                Set new password
              </Button>
            </form>
          </>
        )}
      </CardContent>
    </Card>
  );
}

export default function ResetPasswordPage() {
  return (
    <div className="min-h-screen bg-slate-50">
      <LandingNav />
      <div className="mx-auto flex max-w-md flex-col px-4 py-10">
        <h1 className="text-xl font-semibold tracking-tight">Choose a new password</h1>
        <p className="mt-1 text-sm text-slate-500">
          Your reset link expires 1 hour after it was issued.
        </p>
        <Suspense fallback={<LoadingState label="Checking your reset link…" />}>
          <ResetPasswordForm />
        </Suspense>
        <p className="mt-4 text-center text-sm text-slate-500">
          <Link href="/login" className="font-medium text-brand-700 hover:underline">
            Back to login
          </Link>
        </p>
      </div>
    </div>
  );
}
