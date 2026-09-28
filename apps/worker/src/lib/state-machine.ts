import type { JobStatus, MechanicStatus, RequestStatus } from '@rr/types';
import { errors } from './errors';

/**
 * Server-authoritative state machines. Every transition is validated before it
 * is persisted; illegal transitions throw INVALID_STATUS_TRANSITION.
 */

export const REQUEST_TRANSITIONS: Record<RequestStatus, RequestStatus[]> = {
  CREATED: ['SEARCHING', 'CANCELLED', 'FAILED'],
  SEARCHING: ['DISPATCHING', 'ESCALATED', 'CANCELLED', 'FAILED', 'TOWING_REQUIRED'],
  DISPATCHING: ['ASSIGNED', 'SEARCHING', 'ESCALATED', 'CANCELLED', 'FAILED', 'TOWING_REQUIRED'],
  ASSIGNED: ['MECHANIC_EN_ROUTE', 'ARRIVED', 'DISPATCHING', 'ESCALATED', 'CANCELLED', 'TOWING_REQUIRED'],
  MECHANIC_EN_ROUTE: ['MECHANIC_NEARBY', 'ARRIVED', 'DISPATCHING', 'ESCALATED', 'CANCELLED', 'TOWING_REQUIRED'],
  MECHANIC_NEARBY: ['ARRIVED', 'DISPATCHING', 'ESCALATED', 'CANCELLED'],
  ARRIVED: ['DIAGNOSING', 'DISPATCHING', 'ESCALATED', 'CANCELLED', 'TOWING_REQUIRED'],
  DIAGNOSING: ['QUOTE_PENDING', 'DISPATCHING', 'TOWING_REQUIRED', 'ESCALATED', 'CANCELLED'],
  QUOTE_PENDING: ['QUOTE_APPROVED', 'DIAGNOSING', 'DISPATCHING', 'CANCELLED', 'ESCALATED', 'FAILED'],
  QUOTE_APPROVED: ['REPAIRING', 'DISPATCHING', 'ESCALATED', 'CANCELLED', 'TOWING_REQUIRED'],
  REPAIRING: ['COMPLETED', 'DISPATCHING', 'ESCALATED', 'TOWING_REQUIRED'],
  COMPLETED: ['PAYMENT_PENDING', 'PAID'],
  PAYMENT_PENDING: ['PAID', 'ESCALATED'],
  PAID: [],
  CANCELLED: [],
  ESCALATED: ['DISPATCHING', 'ASSIGNED', 'CANCELLED', 'TOWING_REQUIRED', 'FAILED', 'SEARCHING'],
  TOWING_REQUIRED: ['ASSIGNED', 'DISPATCHING', 'COMPLETED', 'ESCALATED', 'CANCELLED'],
  FAILED: [],
};

export const JOB_TRANSITIONS: Record<JobStatus, JobStatus[]> = {
  ACCEPTED: ['EN_ROUTE', 'CANCELLED'],
  EN_ROUTE: ['ARRIVED', 'CANCELLED'],
  ARRIVED: ['VERIFIED', 'CANCELLED'],
  VERIFIED: ['DIAGNOSING', 'CANCELLED'],
  DIAGNOSING: ['QUOTE_PENDING', 'CANCELLED'],
  QUOTE_PENDING: ['QUOTE_APPROVED', 'DIAGNOSING', 'CANCELLED'],
  QUOTE_APPROVED: ['REPAIRING', 'CANCELLED'],
  REPAIRING: ['COMPLETED', 'CANCELLED'],
  COMPLETED: [],
  CANCELLED: [],
};

export const MECHANIC_TRANSITIONS: Record<MechanicStatus, MechanicStatus[]> = {
  OFFLINE: ['AVAILABLE', 'PAUSED', 'SUSPENDED'],
  AVAILABLE: ['OFFLINE', 'PAUSED', 'BUSY', 'EN_ROUTE', 'ON_JOB', 'SUSPENDED'],
  BUSY: ['AVAILABLE', 'OFFLINE', 'PAUSED', 'EN_ROUTE', 'ON_JOB', 'SUSPENDED'],
  EN_ROUTE: ['ON_JOB', 'BUSY', 'AVAILABLE', 'PAUSED', 'OFFLINE', 'SUSPENDED'],
  ON_JOB: ['BUSY', 'EN_ROUTE', 'AVAILABLE', 'PAUSED', 'OFFLINE', 'SUSPENDED'],
  PAUSED: ['AVAILABLE', 'OFFLINE', 'SUSPENDED'],
  SUSPENDED: ['OFFLINE'],
};

export function canTransition<T extends string>(
  map: Record<T, T[]>,
  from: T,
  to: T,
): boolean {
  const allowed = map[from];
  if (!allowed) return false;
  return allowed.includes(to);
}

export function assertRequestTransition(from: RequestStatus, to: RequestStatus): void {
  if (!canTransition(REQUEST_TRANSITIONS, from, to)) {
    throw errors.invalidTransition(from, to);
  }
}

export function assertJobTransition(from: JobStatus, to: JobStatus): void {
  if (!canTransition(JOB_TRANSITIONS, from, to)) {
    throw errors.invalidTransition(from, to);
  }
}

export function assertMechanicTransition(from: MechanicStatus, to: MechanicStatus): void {
  if (!canTransition(MECHANIC_TRANSITIONS, from, to)) {
    throw errors.invalidTransition(from, to);
  }
}

/** Statuses that mean the request is still being worked on. */
export const ACTIVE_REQUEST_STATUSES: RequestStatus[] = [
  'CREATED',
  'SEARCHING',
  'DISPATCHING',
  'ASSIGNED',
  'MECHANIC_EN_ROUTE',
  'MECHANIC_NEARBY',
  'ARRIVED',
  'DIAGNOSING',
  'QUOTE_PENDING',
  'QUOTE_APPROVED',
  'REPAIRING',
  'ESCALATED',
  'TOWING_REQUIRED',
];

export const OPEN_REQUEST_STATUSES: RequestStatus[] = [...ACTIVE_REQUEST_STATUSES, 'COMPLETED', 'PAYMENT_PENDING'];

export function isActiveStatus(status: RequestStatus): boolean {
  return ACTIVE_REQUEST_STATUSES.includes(status);
}

export function isTerminalStatus(status: RequestStatus): boolean {
  return status === 'PAID' || status === 'CANCELLED' || status === 'FAILED';
}
