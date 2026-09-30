'use client';

import Link from 'next/link';
import { useEffect, useState, type FormEvent } from 'react';
import { Alert, Button, Card, CardContent, Field, Input, cn } from '@rr/ui';
import { ArrowLeft, Mail, MessageSquare, Phone } from 'lucide-react';
import { ApiError, apiPost, errorMessage, fieldErrors } from '@/lib/api';
import { LandingNav } from '@/components/landing-nav';
import { AuthLayout } from '@/components/auth-layout';
import { OtpInput } from '@/components/otp-input';

interface ForgotEmailResponse {
  message: string;
  devToken?: string;
}

interface ForgotPhoneResponse {
  message: string;
  devOtp?: string;
}

type PhoneStep = 'request' | 'verify' | 'done';

export default function ForgotPasswordPage() {
  const [mode, setMode] = useState<'email' | 'phone'>('email');

  const [email, setEmail] = useState('');
  const [emailBusy, setEmailBusy] = useState(false);
  const [emailError, setEmailError] = useState<string | null>(null);
  const [emailFields, setEmailFields] = useState<Record<string, string>>({});
  const [sent, setSent] = useState<ForgotEmailResponse | null>(null);

  const [phone, setPhone] = useState('');
  const [phoneStep, setPhoneStep] = useState<PhoneStep>('request');
  const [sentPhone, setSentPhone] = useState('');
  const [devOtp, setDevOtp] = useState<string | null>(null);
  const [otp, setOtp] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [accountEmail, setAccountEmail] = useState('');
  const [needEmail, setNeedEmail] = useState(false);
  const [resendIn, setResendIn] = useState(0);
  const [phoneBusy, setPhoneBusy] = useState(false);
  const [phoneError, setPhoneError] = useState<string | null>(null);
  const [phoneFields, setPhoneFields] = useState<Record<string, string>>({});

  useEffect(() => {
    if (resendIn <= 0) return;
    const timer = setInterval(() => setResendIn((value) => Math.max(0, value - 1)), 1000);
    return () => clearInterval(timer);
  }, [resendIn > 0]);

  const submitEmail = async (event: FormEvent) => {
    event.preventDefault();
    setEmailBusy(true);
    setEmailError(null);
    setEmailFields({});
    try {
      const data = await apiPost<ForgotEmailResponse>('/api/auth/forgot-password', {
        email: email.trim(),
      });
      setSent(data);
    } catch (err) {
      setEmailFields(fieldErrors(err));
      setEmailError(errorMessage(err));
    } finally {
      setEmailBusy(false);
    }
  };

  const requestOtp = async (): Promise<void> => {
    const data = await apiPost<ForgotPhoneResponse>('/api/auth/forgot-password', {
      phone: phone.trim(),
    });
    setSentPhone(phone.trim());
    setDevOtp(data.devOtp ?? null);
    setOtp('');
    setResendIn(60);
    setPhoneStep('verify');
  };

  const submitPhone = async (event: FormEvent) => {
    event.preventDefault();
    setPhoneBusy(true);
    setPhoneError(null);
    setPhoneFields({});
    try {
      await requestOtp();
    } catch (err) {
      setPhoneFields(fieldErrors(err));
      if (err instanceof ApiError && err.code === 'SMS_NOT_CONFIGURED') {
        setPhoneError(
          "SMS codes aren't enabled on this deployment yet — switch to the Email tab to reset your password.",
        );
      } else {
        setPhoneError(errorMessage(err));
      }
    } finally {
      setPhoneBusy(false);
    }
  };

  const submitReset = async (event: FormEvent) => {
    event.preventDefault();
    if (otp.length < 6) {
      setPhoneError('Enter the 6-digit code.');
      return;
    }
    if (password !== confirm) {
      setPhoneFields({ confirm: 'Passwords do not match.' });
      return;
    }
    setPhoneBusy(true);
    setPhoneError(null);
    setPhoneFields({});
    try {
      await apiPost('/api/auth/reset-password/otp', {
        phone: sentPhone,
        otp,
        password,
        ...(accountEmail.trim() ? { email: accountEmail.trim() } : {}),
      });
      setPhoneStep('done');
    } catch (err) {
      const message = errorMessage(err);
      if (message.includes('Multiple accounts')) setNeedEmail(true);
      setPhoneFields(fieldErrors(err));
      setPhoneError(message);
    } finally {
      setPhoneBusy(false);
    }
  };

  const tabs: { key: 'email' | 'phone'; label: string; icon: typeof Mail }[] = [
    { key: 'email', label: 'Email link', icon: Mail },
    { key: 'phone', label: 'SMS code', icon: Phone },
  ];

  return (
    <>
      <LandingNav />
      <AuthLayout
        headline="Locked out? That's a two-minute fix."
        blurb="Reset by email link or a one-time SMS code — whichever you still have access to."
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
          Forgot your password?
        </h1>

        <div className="mt-4 grid grid-cols-2 gap-2 rounded-xl bg-slate-100 p-1">
          {tabs.map(({ key, label, icon: Icon }) => (
            <button
              key={key}
              type="button"
              onClick={() => setMode(key)}
              className={cn(
                'flex items-center justify-center gap-2 rounded-lg px-3 py-2 text-sm font-semibold transition',
                mode === key ? 'bg-white text-ink shadow-sm' : 'text-slate-500 hover:text-ink',
              )}
            >
              <Icon className="h-4 w-4" />
              {label}
            </button>
          ))}
        </div>

        <Card className="mt-5">
          <CardContent className="py-5">
            {mode === 'email' ? (
              sent ? (
                <div className="space-y-4">
                  <Alert tone="success" title="Check your inbox">
                    {sent.message}
                  </Alert>
                  {sent.devToken ? (
                    <div className="rounded-xl border border-amber-200 bg-amber-50 p-3">
                      <p className="text-xs font-semibold text-amber-900">
                        Development mode — reset link without SMTP:
                      </p>
                      <Link
                        href={`/reset-password?token=${encodeURIComponent(sent.devToken)}`}
                        className="mt-1 block break-all font-mono text-xs font-medium text-brand-700 hover:underline"
                      >
                        Open reset link
                      </Link>
                    </div>
                  ) : null}
                  <Button variant="secondary" fullWidth onClick={() => setSent(null)}>
                    Use a different email
                  </Button>
                </div>
              ) : (
                <>
                  {emailError ? (
                    <Alert tone="danger" className="mb-4">
                      {emailError}
                    </Alert>
                  ) : null}
                  <form onSubmit={submitEmail} className="space-y-4">
                    <p className="text-sm text-slate-500">
                      We'll email you a secure reset link, valid for one hour.
                    </p>
                    <Field label="Email" htmlFor="email" error={emailFields.email}>
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
                    <Button type="submit" loading={emailBusy} fullWidth>
                      Send reset link
                    </Button>
                  </form>
                </>
              )
            ) : phoneStep === 'request' ? (
              <>
                {phoneError ? (
                  <Alert tone="danger" className="mb-4">
                    {phoneError}
                  </Alert>
                ) : null}
                <form onSubmit={submitPhone} className="space-y-4">
                  <p className="text-sm text-slate-500">
                    Enter your registered mobile number — we'll text a 6-digit code.
                  </p>
                  <Field label="Mobile number" htmlFor="phone" error={phoneFields.phone}>
                    <Input
                      id="phone"
                      type="tel"
                      autoComplete="tel"
                      required
                      value={phone}
                      onChange={(event) => setPhone(event.target.value)}
                      placeholder="98765 43210"
                    />
                  </Field>
                  <Button type="submit" loading={phoneBusy} fullWidth>
                    Send code
                  </Button>
                </form>
              </>
            ) : phoneStep === 'verify' ? (
              <>
                {phoneError ? (
                  <Alert tone="danger" className="mb-4">
                    {phoneError}
                  </Alert>
                ) : null}
                {devOtp ? (
                  <Alert tone="info" className="mb-4" title="Development mode">
                    Code without SMS: <span className="font-mono font-bold">{devOtp}</span>
                  </Alert>
                ) : null}
                <form onSubmit={submitReset} className="space-y-4">
                  <p className="flex items-center gap-2 text-sm text-slate-500">
                    <MessageSquare className="h-4 w-4 text-brand-600" />
                    Code sent to <span className="font-semibold text-ink">{sentPhone}</span>
                  </p>
                  <OtpInput value={otp} onChange={setOtp} disabled={phoneBusy} autoFocus />
                  <Field
                    label="New password"
                    htmlFor="newPassword"
                    error={phoneFields.password}
                    hint="At least 8 characters with a number and a symbol."
                  >
                    <Input
                      id="newPassword"
                      type="password"
                      autoComplete="new-password"
                      required
                      value={password}
                      onChange={(event) => setPassword(event.target.value)}
                      placeholder="••••••••"
                    />
                  </Field>
                  <Field label="Confirm password" htmlFor="confirm" error={phoneFields.confirm}>
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
                  {needEmail ? (
                    <Field
                      label="Account email"
                      htmlFor="accountEmail"
                      error={phoneFields.email}
                      hint="This number has multiple accounts — pick one by email."
                    >
                      <Input
                        id="accountEmail"
                        type="email"
                        value={accountEmail}
                        onChange={(event) => setAccountEmail(event.target.value)}
                        placeholder="you@example.com"
                      />
                    </Field>
                  ) : null}
                  <Button type="submit" loading={phoneBusy} fullWidth>
                    Reset password
                  </Button>
                </form>

                <div className="mt-4 flex items-center justify-between border-t border-slate-100 pt-4 text-xs">
                  <button
                    type="button"
                    onClick={() => {
                      setPhoneStep('request');
                      setPhoneError(null);
                    }}
                    className="inline-flex items-center gap-1 font-medium text-slate-500 hover:text-ink"
                  >
                    <ArrowLeft className="h-3.5 w-3.5" /> Change number
                  </button>
                  <button
                    type="button"
                    onClick={async () => {
                      if (resendIn > 0 || phoneBusy) return;
                      setPhoneBusy(true);
                      try {
                        await requestOtp();
                      } catch (err) {
                        setPhoneError(errorMessage(err));
                      } finally {
                        setPhoneBusy(false);
                      }
                    }}
                    disabled={resendIn > 0 || phoneBusy}
                    className="font-medium text-brand-700 disabled:text-slate-400"
                  >
                    {resendIn > 0 ? `Resend in ${resendIn}s` : 'Resend code'}
                  </button>
                </div>
              </>
            ) : (
              <div className="space-y-4 text-center">
                <Alert tone="success" title="Password updated">
                  Your password has been changed. Sign in with your new password.
                </Alert>
                <Link href="/login">
                  <Button fullWidth>Go to log in</Button>
                </Link>
              </div>
            )}
          </CardContent>
        </Card>
      </AuthLayout>
    </>
  );
}
