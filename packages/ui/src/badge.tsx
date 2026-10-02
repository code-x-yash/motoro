import type { ReactNode } from 'react';
import { cn } from './cn';

export type BadgeTone =
  | 'slate'
  | 'blue'
  | 'amber'
  | 'emerald'
  | 'rose'
  | 'violet'
  | 'cyan'
  | 'brand'
  | 'sun'
  | 'ink';

const TONES: Record<BadgeTone, string> = {
  slate: 'bg-slate-100 text-slate-700 ring-slate-200',
  blue: 'bg-blue-50 text-blue-700 ring-blue-200',
  amber: 'bg-amber-50 text-amber-800 ring-amber-200',
  emerald: 'bg-emerald-50 text-emerald-700 ring-emerald-200',
  rose: 'bg-rose-50 text-rose-700 ring-rose-200',
  violet: 'bg-violet-50 text-violet-700 ring-violet-200',
  cyan: 'bg-cyan-50 text-cyan-700 ring-cyan-200',
  brand: 'bg-brand-100 text-brand-700 ring-brand-200',
  sun: 'bg-sun-300 text-ink ring-sun-500',
  ink: 'bg-ink text-sun-300 ring-ink',
};

export function Badge({
  tone = 'slate',
  className,
  children,
  dot = false,
}: {
  tone?: BadgeTone;
  className?: string;
  children: ReactNode;
  dot?: boolean;
}) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[11px] font-medium ring-1 ring-inset',
        TONES[tone],
        className,
      )}
    >
      {dot ? <span className="h-1.5 w-1.5 rounded-full bg-current opacity-70" /> : null}
      {children}
    </span>
  );
}

export const REQUEST_STATUS_TONE: Record<string, BadgeTone> = {
  CREATED: 'slate',
  SEARCHING: 'amber',
  DISPATCHING: 'amber',
  ASSIGNED: 'blue',
  MECHANIC_EN_ROUTE: 'blue',
  MECHANIC_NEARBY: 'blue',
  ARRIVED: 'cyan',
  DIAGNOSING: 'cyan',
  QUOTE_PENDING: 'violet',
  QUOTE_APPROVED: 'violet',
  REPAIRING: 'violet',
  COMPLETED: 'emerald',
  PAYMENT_PENDING: 'amber',
  PAID: 'emerald',
  CANCELLED: 'slate',
  ESCALATED: 'rose',
  TOWING_REQUIRED: 'rose',
  FAILED: 'rose',
};

export const JOB_STATUS_TONE: Record<string, BadgeTone> = {
  ACCEPTED: 'blue',
  EN_ROUTE: 'blue',
  ARRIVED: 'cyan',
  VERIFIED: 'cyan',
  DIAGNOSING: 'violet',
  QUOTE_PENDING: 'amber',
  QUOTE_APPROVED: 'emerald',
  REPAIRING: 'violet',
  COMPLETED: 'emerald',
  CANCELLED: 'slate',
};

export const URGENCY_TONE: Record<string, BadgeTone> = {
  LOW: 'slate',
  NORMAL: 'blue',
  HIGH: 'amber',
  CRITICAL: 'rose',
};

function humanize(value: string): string {
  return value
    .split(/[_\s-]+/)
    .filter(Boolean)
    .map((part) => part[0]?.toUpperCase() + part.slice(1).toLowerCase())
    .join(' ');
}

export function StatusBadge({
  status,
  map = REQUEST_STATUS_TONE,
  className,
}: {
  status: string;
  map?: Record<string, BadgeTone>;
  className?: string;
}) {
  return (
    <Badge tone={map[status] ?? 'slate'} className={className}>
      {humanize(status)}
    </Badge>
  );
}

export function UrgencyBadge({ urgency, className }: { urgency: string; className?: string }) {
  return (
    <Badge tone={URGENCY_TONE[urgency] ?? 'slate'} className={className} dot>
      {humanize(urgency)}
    </Badge>
  );
}
