'use client';

import { useState, type ReactNode } from 'react';
import { cn } from './cn';

export function Avatar({ name, className }: { name: string; className?: string }) {
  const initials = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('');
  return (
    <span
      className={cn(
        'inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-brand-100 text-xs font-semibold text-brand-700',
        className,
      )}
    >
      {initials || '?'}
    </span>
  );
}

export function Rating({
  value,
  count,
  onChange,
  size = 'md',
}: {
  value: number;
  count?: number;
  onChange?: (value: number) => void;
  size?: 'sm' | 'md';
}) {
  const stars = [1, 2, 3, 4, 5];
  const px = size === 'sm' ? 'text-xs' : 'text-base';
  if (!onChange) {
    return (
      <span className={cn('inline-flex items-center gap-1 text-amber-500', px)}>
        <span aria-hidden>{'★'.repeat(Math.round(value))}{'☆'.repeat(5 - Math.round(value))}</span>
        <span className="text-xs font-medium text-slate-600">
          {value.toFixed(1)}
          {typeof count === 'number' ? ` (${count})` : ''}
        </span>
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1">
      {stars.map((star) => (
        <button
          key={star}
          type="button"
          aria-label={`${star} stars`}
          onClick={() => onChange(star)}
          className={cn('transition-colors', px, star <= value ? 'text-amber-500' : 'text-slate-300 hover:text-amber-400')}
        >
          ★
        </button>
      ))}
    </span>
  );
}

export function Stat({
  label,
  value,
  hint,
  tone = 'slate',
}: {
  label: string;
  value: ReactNode;
  hint?: string;
  tone?: 'slate' | 'blue' | 'amber' | 'emerald' | 'rose';
}) {
  const tones: Record<string, string> = {
    slate: 'text-slate-900',
    blue: 'text-blue-700',
    amber: 'text-amber-700',
    emerald: 'text-emerald-700',
    rose: 'text-rose-700',
  };
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4">
      <p className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</p>
      <p className={cn('mt-1 text-2xl font-semibold tabular-nums', tones[tone])}>{value}</p>
      {hint ? <p className="mt-0.5 text-xs text-slate-500">{hint}</p> : null}
    </div>
  );
}

export function Tabs({
  tabs,
  active,
  onChange,
  className,
}: {
  tabs: { id: string; label: ReactNode; badge?: ReactNode }[];
  active: string;
  onChange: (id: string) => void;
  className?: string;
}) {
  return (
    <div className={cn('flex gap-1 overflow-x-auto border-b border-slate-200', className)}>
      {tabs.map((tab) => {
        const isActive = tab.id === active;
        return (
          <button
            key={tab.id}
            type="button"
            onClick={() => onChange(tab.id)}
            className={cn(
              'relative whitespace-nowrap px-4 py-2.5 text-sm font-medium transition-colors',
              isActive ? 'text-brand-700' : 'text-slate-500 hover:text-slate-800',
            )}
          >
            <span className="inline-flex items-center gap-2">
              {tab.label}
              {tab.badge}
            </span>
            {isActive ? (
              <span className="absolute inset-x-2 -bottom-px h-0.5 rounded bg-brand-600" />
            ) : null}
          </button>
        );
      })}
    </div>
  );
}

export function Stepper({
  steps,
  current,
  className,
}: {
  steps: string[];
  current: number;
  className?: string;
}) {
  return (
    <ol className={cn('flex items-center gap-2', className)}>
      {steps.map((step, index) => {
        const done = index < current;
        const isCurrent = index === current;
        return (
          <li key={step} className="flex flex-1 items-center gap-2">
            <span
              className={cn(
                'flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold',
                done ? 'bg-brand-600 text-white' : isCurrent ? 'border-2 border-brand-600 text-brand-700' : 'border border-slate-300 text-slate-400',
              )}
            >
              {index + 1}
            </span>
            <span className={cn('hidden text-xs sm:block', isCurrent ? 'font-semibold text-slate-800' : 'text-slate-500')}>
              {step}
            </span>
            {index < steps.length - 1 ? <span className="h-px flex-1 bg-slate-200" /> : null}
          </li>
        );
      })}
    </ol>
  );
}

export function ProgressBar({ value, className, tone = 'brand' }: { value: number; className?: string; tone?: 'brand' | 'emerald' | 'rose' }) {
  const tones: Record<string, string> = {
    brand: 'bg-brand-600',
    emerald: 'bg-emerald-500',
    rose: 'bg-rose-500',
  };
  return (
    <div className={cn('h-2 w-full overflow-hidden rounded-full bg-slate-200', className)}>
      <div
        className={cn('h-full rounded-full transition-all', tones[tone])}
        style={{ width: `${Math.max(0, Math.min(100, value))}%` }}
      />
    </div>
  );
}

export function KeyValue({ label, value, className }: { label: ReactNode; value: ReactNode; className?: string }) {
  return (
    <div className={cn('flex items-start justify-between gap-4 py-1.5', className)}>
      <span className="text-xs text-slate-500">{label}</span>
      <span className="text-right text-sm font-medium text-slate-800">{value}</span>
    </div>
  );
}

export function CopyButton({ value, label = 'Copy' }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        if (!navigator.clipboard) return;
        void navigator.clipboard.writeText(value).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        });
      }}
      className="rounded border border-slate-200 px-2 py-0.5 text-[11px] text-slate-500 hover:bg-slate-50"
    >
      {copied ? 'Copied' : label}
    </button>
  );
}
