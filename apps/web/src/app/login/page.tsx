'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { Alert, Button, Card, CardContent, Field, Input } from '@rr/ui';
import { Eye, EyeOff } from 'lucide-react';
import { homePathFor, useAuth } from '@/lib/auth';
import { errorMessage, fieldErrors } from '@/lib/api';
import { LandingNav } from '@/components/landing-nav';
import { AuthLayout } from '@/components/auth-layout';

export default function LoginPage() {
  const router = useRouter();
  const { login } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
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
    <>
      <LandingNav />
      <AuthLayout
        headline="Stranded? Back on the road in minutes."
        blurb="24/7 roadside help with verified mechanics, live tracking and pricing you can see before you say yes."
        footer={
          <>
            New to Motoro?{' '}
            <Link href="/register" className="font-medium text-brand-700 hover:underline">
              Create an account
            </Link>
          </>
        }
      >
        <h1 className="text-2xl font-bold tracking-tight text-ink sm:text-3xl">Welcome back</h1>
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
                <div className="relative">
                  <Input
                    id="password"
                    type={showPassword ? 'text' : 'password'}
                    autoComplete="current-password"
                    required
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                    placeholder="••••••••"
                    className="pr-11"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword((value) => !value)}
                    aria-label={showPassword ? 'Hide password' : 'Show password'}
                    className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded-md p-1.5 text-slate-400 transition hover:text-slate-600"
                  >
                    {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </button>
                </div>
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
          </CardContent>
        </Card>
      </AuthLayout>
    </>
  );
}
