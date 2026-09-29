'use client';

import Link from 'next/link';
import { useState, type FormEvent } from 'react';
import { Alert, Button, Card, CardContent, Field, Input } from '@rr/ui';
import { apiPost, errorMessage, fieldErrors } from '@/lib/api';
import { LandingNav } from '@/components/landing-nav';

interface ForgotResponse {
  message: string;
  devToken?: string;
}

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState<ForgotResponse | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setFields({});
    try {
      const data = await apiPost<ForgotResponse>('/api/auth/forgot-password', { email: email.trim() });
      setSent(data);
    } catch (err) {
      setFields(fieldErrors(err));
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="min-h-screen bg-slate-50">
      <LandingNav />
      <div className="mx-auto flex max-w-md flex-col px-4 py-10">
        <h1 className="text-xl font-semibold tracking-tight">Forgot your password?</h1>
        <p className="mt-1 text-sm text-slate-500">
          Enter your account email and we&apos;ll send you a reset link.
        </p>

        <Card className="mt-6">
          <CardContent className="py-5">
            {sent ? (
              <div className="space-y-4">
                <Alert tone="success">{sent.message}</Alert>
                {sent.devToken ? (
                  <Alert tone="info">
                    <p className="font-medium">Development mode</p>
                    <p className="mt-1 text-xs">
                      No email provider is configured, so use this token:
                    </p>
                    <Link
                      href={`/reset-password?token=${encodeURIComponent(sent.devToken)}`}
                      className="mt-2 block break-all font-mono text-xs text-brand-700 underline"
                    >
                      {sent.devToken}
                    </Link>
                  </Alert>
                ) : null}
                <Button variant="secondary" onClick={() => setSent(null)}>
                  Try another email
                </Button>
              </div>
            ) : (
              <>
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
                  <Button type="submit" loading={busy} fullWidth>
                    Send reset link
                  </Button>
                </form>
              </>
            )}
          </CardContent>
        </Card>

        <p className="mt-4 text-center text-sm text-slate-500">
          Remembered it?{' '}
          <Link href="/login" className="font-medium text-brand-700 hover:underline">
            Back to login
          </Link>
        </p>
      </div>
    </div>
  );
}
