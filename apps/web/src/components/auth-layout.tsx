import type { ReactNode } from 'react';
import { BRAND } from '@rr/config';
import { Clock, Receipt, ShieldCheck, Wrench } from 'lucide-react';

const TRUST: { icon: typeof Clock; label: string }[] = [
  { icon: Clock, label: '15 minute average arrival time' },
  { icon: ShieldCheck, label: 'Verified mechanics & towing partners' },
  { icon: Receipt, label: 'Upfront pricing, GST-ready invoices' },
];

export function AuthLayout({
  headline,
  blurb,
  children,
  footer,
}: {
  headline: string;
  blurb: string;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <div className="min-h-[calc(100vh-4rem)] bg-canvas lg:grid lg:grid-cols-[1.05fr_1fr]">
      <aside className="relative hidden overflow-hidden bg-ink px-6 py-7 text-white sm:px-10 lg:flex lg:flex-col lg:justify-between lg:px-14 lg:py-12">
        <div aria-hidden className="pointer-events-none absolute inset-0">
          <div className="absolute -right-28 -top-24 h-80 w-80 rounded-full bg-sun-400/25 blur-3xl" />
          <div className="absolute -bottom-36 -left-24 h-96 w-96 rounded-full bg-brand-500/20 blur-3xl" />
          <div
            className="absolute inset-x-0 bottom-0 h-32 opacity-[0.12]"
            style={{
              backgroundImage:
                'repeating-linear-gradient(90deg, #ffd100 0 32px, transparent 32px 64px)',
              backgroundPosition: 'center bottom',
              backgroundSize: 'auto 6px',
              backgroundRepeat: 'repeat-x',
            }}
          />
        </div>

        <div className="relative mt-10 hidden max-w-lg lg:block">
          <span className="inline-flex rounded-full bg-sun-400 px-3 py-1 text-[11px] font-bold uppercase tracking-widest text-ink">
            Roadside, sorted
          </span>
          <h1 className="mt-5 text-4xl font-black leading-[1.06] tracking-tight xl:text-5xl">
            {headline}
          </h1>
          <p className="mt-4 max-w-md text-sm leading-relaxed text-slate-300">{blurb}</p>

          <ul className="mt-8 space-y-3.5">
            {TRUST.map(({ icon: Icon, label }) => (
              <li key={label} className="flex items-center gap-3 text-sm font-medium text-slate-200">
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-white/10 ring-1 ring-white/15">
                  <Icon className="h-4 w-4 text-sun-400" />
                </span>
                {label}
              </li>
            ))}
          </ul>

          <div className="mt-9 w-72 animate-fade-up rounded-2xl border border-white/10 bg-white/[0.06] p-4 backdrop-blur">
            <div className="flex items-center gap-2">
              <span className="relative flex h-2 w-2">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
                <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-400" />
              </span>
              <span className="text-[11px] font-bold uppercase tracking-wider text-emerald-300">
                Help is on the way
              </span>
            </div>
            <div className="mt-3 flex items-center gap-3">
              <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-sun-400 text-ink">
                <Wrench className="h-5 w-5" />
              </span>
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold">Rahul · Mechanic</p>
                <p className="text-xs text-slate-400">4.9★ · 212 jobs completed</p>
              </div>
            </div>
            <div className="mt-3 rounded-xl bg-black/30 px-3 py-2 text-xs font-semibold text-sun-300">
              2.4 km away · ETA 12 min
            </div>
          </div>
        </div>

        <p className="relative mt-10 hidden text-xs text-slate-400 lg:block">
          © {new Date().getFullYear()} {BRAND.name} · Help, wherever the road takes you.
        </p>
      </aside>

      <main className="flex flex-col px-5 py-8 sm:px-10 lg:justify-center lg:px-14">
        <div className="mx-auto w-full max-w-md">
          {children}
          {footer ? <div className="mt-6 text-center text-sm text-slate-500">{footer}</div> : null}
        </div>
      </main>
    </div>
  );
}
