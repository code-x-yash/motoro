'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState, type FormEvent } from 'react';
import type { Role } from '@rr/types';
import { Alert, Button, Card, CardContent, Field, Input, cn } from '@rr/ui';
import { ArrowLeft, Car, CheckCircle2, Eye, EyeOff, MessageSquare, Truck, Warehouse, Wrench, type LucideIcon } from 'lucide-react';
import { homePathFor, useAuth } from '@/lib/auth';
import { ApiError, apiPost, errorMessage, fieldErrors } from '@/lib/api';
import { LandingNav } from '@/components/landing-nav';
import { AuthLayout } from '@/components/auth-layout';
import { OtpInput } from '@/components/otp-input';

const ROLE_OPTIONS: { value: Role; label: string; desc: string; icon: LucideIcon }[] = [
  { value: 'DRIVER', label: 'Driver', desc: 'I need roadside help', icon: Car },
  { value: 'MECHANIC', label: 'Mechanic', desc: 'I fix vehicles', icon: Wrench },
  { value: 'WORKSHOP', label: 'Workshop', desc: 'I run a garage', icon: Warehouse },
  { value: 'TOWING_PARTNER', label: 'Towing', desc: 'I run tow trucks', icon: Truck },
];

interface SignupOtpResponse {
  phone: string;
  message: string;
  devOtp?: string;
}

function RegisterForm() {
  const router = useRouter();
  const search = useSearchParams();
  const { register, registerWithOtp } = useAuth();
  const [smsUnavailable, setSmsUnavailable] = useState(false);
  const initialRole = search.get('role');
  const [role, setRole] = useState<Role>(
    ROLE_OPTIONS.some((option) => option.value === initialRole) ? (initialRole as Role) : 'DRIVER',
  );
  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);

  const [step, setStep] = useState<'details' | 'verify'>('details');
  const [sentPhone, setSentPhone] = useState('');
  const [devOtp, setDevOtp] = useState<string | null>(null);
  const [otp, setOtp] = useState('');
  const [resendIn, setResendIn] = useState(0);

  const [error, setError] = useState<string | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (resendIn <= 0) return;
    const timer = setInterval(() => setResendIn((value) => Math.max(0, value - 1)), 1000);
    return () => clearInterval(timer);
  }, [resendIn > 0]);

  const requestOtp = async (): Promise<SignupOtpResponse> => {
    const data = await apiPost<SignupOtpResponse>('/api/auth/signup/otp', {
      fullName: fullName.trim(),
      email: email.trim(),
      phone: phone.trim(),
      role,
    });
    setSentPhone(data.phone);
    setDevOtp(data.devOtp ?? null);
    setOtp('');
    setResendIn(60);
    return data;
  };

  const submitDetails = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setFields({});
    try {
      if (smsUnavailable) {
        // SMS provider not connected on this deployment — fall back to the
        // password signup path (same backend, phone stored unverified).
        const user = await register({
          fullName: fullName.trim(),
          email: email.trim(),
          phone: phone.trim(),
          password,
          role,
        });
        router.replace(homePathFor(user.role));
        return;
      }
      await requestOtp();
      setStep('verify');
    } catch (err) {
      setFields(fieldErrors(err));
      if (
        err instanceof ApiError &&
        (err.code === 'SMS_NOT_CONFIGURED' || err.code === 'SMS_SEND_FAILED')
      ) {
        setSmsUnavailable(true);
        setError(null);
      } else {
        setError(errorMessage(err));
      }
    } finally {
      setBusy(false);
    }
  };

  const resend = async () => {
    if (resendIn > 0 || busy) return;
    setBusy(true);
    setError(null);
    try {
      await requestOtp();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const submitOtp = async (event: FormEvent) => {
    event.preventDefault();
    if (otp.length < 6) {
      setError('Enter the 6-digit code.');
      return;
    }
    setBusy(true);
    setError(null);
    setFields({});
    try {
      const user = await registerWithOtp({ phone: sentPhone, otp, password });
      router.replace(homePathFor(user.role));
    } catch (err) {
      setFields(fieldErrors(err));
      setError(errorMessage(err));
      setBusy(false);
    }
  };

  return (
    <AuthLayout
      headline="Join the network that keeps the road moving."
      blurb="One account for roadside requests, job dispatch, workshop bookings and towing — pick how you'll use Motoro below."
      footer={
        <>
          Already have an account?{' '}
          <Link href="/login" className="font-medium text-brand-700 hover:underline">
            Log in
          </Link>
        </>
      }
    >
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold tracking-tight text-ink sm:text-3xl">
          {step === 'details' ? 'Create your account' : 'Verify your number'}
        </h1>
        <span className="text-xs font-bold uppercase tracking-widest text-slate-400">
          {step === 'details' ? 'Step 1 of 2' : 'Step 2 of 2'}
        </span>
      </div>
      <div className="mt-3 flex gap-2" aria-hidden>
        <span className={cn('h-1.5 flex-1 rounded-full transition', step === 'verify' ? 'bg-brand-500' : 'bg-slate-200')} />
        <span className={cn('h-1.5 flex-1 rounded-full transition', step === 'verify' ? 'bg-brand-500' : 'bg-slate-200')} />
      </div>

      {step === 'details' ? (
        <>
          <p className="mt-3 text-sm text-slate-500">
            Drivers, mechanics, workshops and towing partners.
          </p>
          <Card className="mt-5">
            <CardContent className="py-5">
              {error ? (
                <Alert tone="danger" className="mb-4">
                  {error}
                </Alert>
              ) : null}
              {smsUnavailable ? (
                <Alert tone="info" className="mb-4" title="Password signup">
                  SMS verification isn&apos;t working on this deployment right now. Create
                  your account with your password below — it will go back to phone codes
                  automatically once SMS is available.
                </Alert>
              ) : null}
              <form onSubmit={submitDetails} className="space-y-4">
                <div>
                  <span className="input-label">I am a</span>
                  <div className="grid grid-cols-2 gap-2.5" role="radiogroup" aria-label="Account type">
                    {ROLE_OPTIONS.map((option) => {
                      const selected = role === option.value;
                      return (
                        <label
                          key={option.value}
                          className={cn(
                            'group relative flex cursor-pointer flex-col gap-1.5 rounded-xl border p-3 transition focus-within:ring-2',
                            selected
                              ? 'border-brand-500 bg-brand-50/70 ring-2 ring-brand-500/25'
                              : 'border-slate-200 bg-white hover:border-brand-300 hover:bg-slate-50 focus-within:ring-slate-300',
                          )}
                        >
                          <input
                            type="radio"
                            name="role"
                            value={option.value}
                            checked={selected}
                            onChange={() => setRole(option.value)}
                            className="sr-only"
                          />
                          <option.icon
                            className={cn(
                              'h-5 w-5 transition',
                              selected ? 'text-brand-600' : 'text-slate-400 group-hover:text-brand-500',
                            )}
                          />
                          <span className="text-sm font-semibold leading-tight text-ink">
                            {option.label}
                          </span>
                          <span className="text-[11px] leading-tight text-slate-500">
                            {option.desc}
                          </span>
                          {selected ? (
                            <CheckCircle2 className="absolute right-2 top-2 h-4 w-4 text-brand-600" />
                          ) : null}
                        </label>
                      );
                    })}
                  </div>
                  {fields.role ? (
                    <p className="mt-1 text-xs text-rose-600">{fields.role}</p>
                  ) : null}
                </div>

                <Field label="Full name" htmlFor="fullName" error={fields.fullName}>
                  <Input
                    id="fullName"
                    required
                    value={fullName}
                    onChange={(event) => setFullName(event.target.value)}
                    placeholder="Full name"
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
                <Field
                  label="Mobile number"
                  htmlFor="phone"
                  error={fields.phone}
                  hint={
                    smsUnavailable
                      ? 'Stored for your profile — SMS codes are not active yet.'
                      : "We'll text a 6-digit code to verify it."
                  }
                >
                  <Input
                    id="phone"
                    type="tel"
                    required
                    value={phone}
                    onChange={(event) => setPhone(event.target.value)}
                    placeholder="98765 43210"
                  />
                </Field>
                <Field
                  label="Password"
                  htmlFor="password"
                  error={fields.password}
                  hint="At least 8 characters with a number and a symbol."
                >
                  <div className="relative">
                    <Input
                      id="password"
                      type={showPassword ? 'text' : 'password'}
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
                <Button type="submit" loading={busy} fullWidth>
                  {smsUnavailable ? 'Create account' : 'Send verification code'}
                </Button>
                <p className="text-center text-xs leading-relaxed text-slate-500">
                  By creating an account you agree to our{' '}
                  <Link href="/terms" className="font-medium text-brand-700 hover:underline">
                    Terms
                  </Link>{' '}
                  and{' '}
                  <Link href="/privacy" className="font-medium text-brand-700 hover:underline">
                    Privacy Policy
                  </Link>
                  .
                </p>
              </form>
            </CardContent>
          </Card>
        </>
      ) : (
        <>
          <p className="mt-3 flex items-center gap-2 text-sm text-slate-500">
            <MessageSquare className="h-4 w-4 text-brand-600" />
            Code sent to <span className="font-semibold text-ink">{sentPhone}</span>
          </p>
          <Card className="mt-5">
            <CardContent className="py-5">
              {error ? (
                <Alert tone="danger" className="mb-4">
                  {error}
                </Alert>
              ) : null}
              {devOtp ? (
                <Alert tone="info" className="mb-4" title="Development mode">
                  Code without SMS: <span className="font-mono font-bold">{devOtp}</span>
                </Alert>
              ) : null}
              <form onSubmit={submitOtp} className="space-y-5">
                <OtpInput value={otp} onChange={setOtp} disabled={busy} autoFocus />
                <p className="text-xs text-slate-500">
                  Signing up <span className="font-semibold text-slate-700">{email}</span> as{' '}
                  <span className="font-semibold text-slate-700">
                    {ROLE_OPTIONS.find((option) => option.value === role)?.label}
                  </span>
                  .
                </p>
                <Button type="submit" loading={busy} fullWidth disabled={otp.length < 6}>
                  Create account
                </Button>
                <p className="text-center text-xs leading-relaxed text-slate-500">
                  By creating an account you agree to our{' '}
                  <Link href="/terms" className="font-medium text-brand-700 hover:underline">
                    Terms
                  </Link>{' '}
                  and{' '}
                  <Link href="/privacy" className="font-medium text-brand-700 hover:underline">
                    Privacy Policy
                  </Link>
                  .
                </p>
              </form>

              <div className="mt-4 flex items-center justify-between border-t border-slate-100 pt-4 text-xs">
                <button
                  type="button"
                  onClick={() => {
                    setStep('details');
                    setError(null);
                  }}
                  className="inline-flex items-center gap-1 font-medium text-slate-500 hover:text-ink"
                >
                  <ArrowLeft className="h-3.5 w-3.5" /> Edit details
                </button>
                <button
                  type="button"
                  onClick={resend}
                  disabled={resendIn > 0 || busy}
                  className="font-medium text-brand-700 disabled:text-slate-400"
                >
                  {resendIn > 0 ? `Resend in ${resendIn}s` : 'Resend code'}
                </button>
              </div>
            </CardContent>
          </Card>
        </>
      )}
    </AuthLayout>
  );
}

export default function RegisterPage() {
  return (
    <div className="min-h-screen bg-canvas">
      <LandingNav />
      <Suspense>
        <RegisterForm />
      </Suspense>
    </div>
  );
}
