export const PROGRESS_STEPS = ['Requested', 'Assigned', 'En route', 'Arrived', 'Repair', 'Payment', 'Done'] as const;

const STEP_BY_STATUS: Record<string, number> = {
  CREATED: 0,
  SEARCHING: 0,
  DISPATCHING: 0,
  ESCALATED: 0,
  ASSIGNED: 1,
  MECHANIC_EN_ROUTE: 2,
  MECHANIC_NEARBY: 2,
  TOWING_REQUIRED: 2,
  ARRIVED: 3,
  DIAGNOSING: 4,
  QUOTE_PENDING: 4,
  QUOTE_APPROVED: 4,
  REPAIRING: 4,
  COMPLETED: 5,
  PAYMENT_PENDING: 5,
  PAID: 6,
};

export const TERMINAL_REQUEST_STATUSES = ['CANCELLED', 'FAILED'];

export function progressStepIndex(status: string): number {
  if (TERMINAL_REQUEST_STATUSES.includes(status)) return -1;
  return STEP_BY_STATUS[status] ?? 0;
}

export function progressStepLabel(status: string): string {
  if (status === 'CANCELLED') return 'Cancelled';
  if (status === 'FAILED') return 'Failed';
  return PROGRESS_STEPS[progressStepIndex(status)] ?? PROGRESS_STEPS[0];
}

export function nextProgressStepLabel(status: string): string | null {
  const index = progressStepIndex(status);
  if (index < 0) return null;
  const next = PROGRESS_STEPS[index + 1];
  return next ?? null;
}
