import { describe, expect, it } from 'vitest';
import type { RequestStatus } from '@rr/types';
import {
  ACTIVE_REQUEST_STATUSES,
  JOB_TRANSITIONS,
  MECHANIC_TRANSITIONS,
  REQUEST_TRANSITIONS,
  assertJobTransition,
  assertMechanicTransition,
  assertRequestTransition,
  canTransition,
  isActiveStatus,
  isTerminalStatus,
} from './state-machine';

const HAPPY_PATH: Array<[RequestStatus, RequestStatus]> = [
  ['CREATED', 'SEARCHING'],
  ['SEARCHING', 'DISPATCHING'],
  ['DISPATCHING', 'ASSIGNED'],
  ['ASSIGNED', 'MECHANIC_EN_ROUTE'],
  ['MECHANIC_EN_ROUTE', 'ARRIVED'],
  ['ARRIVED', 'DIAGNOSING'],
  ['DIAGNOSING', 'QUOTE_PENDING'],
  ['QUOTE_PENDING', 'QUOTE_APPROVED'],
  ['QUOTE_APPROVED', 'REPAIRING'],
  ['REPAIRING', 'COMPLETED'],
  ['COMPLETED', 'PAYMENT_PENDING'],
  ['PAYMENT_PENDING', 'PAID'],
];

describe('request state machine', () => {
  it('allows the full happy path end to end', () => {
    for (const [from, to] of HAPPY_PATH) {
      expect(() => assertRequestTransition(from, to), `${from} -> ${to}`).not.toThrow();
    }
  });

  it('rejects skips and backwards jumps', () => {
    expect(() => assertRequestTransition('CREATED', 'PAID')).toThrow();
    expect(() => assertRequestTransition('DISPATCHING', 'CREATED')).toThrow();
    expect(() => assertRequestTransition('PAID', 'REPAIRING')).toThrow();
    expect(() => assertRequestTransition('CANCELLED', 'SEARCHING')).toThrow();
  });

  it('keeps PAID / CANCELLED / FAILED terminal', () => {
    expect(REQUEST_TRANSITIONS.PAID).toEqual([]);
    expect(REQUEST_TRANSITIONS.CANCELLED).toEqual([]);
    expect(REQUEST_TRANSITIONS.FAILED).toEqual([]);
    expect(isTerminalStatus('PAID')).toBe(true);
    expect(isTerminalStatus('CANCELLED')).toBe(true);
    expect(isTerminalStatus('FAILED')).toBe(true);
    expect(isTerminalStatus('COMPLETED')).toBe(false);
  });

  it('classifies active statuses', () => {
    expect(isActiveStatus('SEARCHING')).toBe(true);
    expect(isActiveStatus('REPAIRING')).toBe(true);
    expect(isActiveStatus('PAID')).toBe(false);
    expect(ACTIVE_REQUEST_STATUSES).not.toContain('COMPLETED');
  });

  it('lets an escalated request re-enter dispatch', () => {
    expect(() => assertRequestTransition('ESCALATED', 'DISPATCHING')).not.toThrow();
    expect(() => assertRequestTransition('ESCALATED', 'ASSIGNED')).not.toThrow();
    expect(() => assertRequestTransition('ESCALATED', 'REPAIRING')).toThrow();
  });
});

describe('job state machine', () => {
  it('walks a job from acceptance to completion', () => {
    expect(() => assertJobTransition('ACCEPTED', 'EN_ROUTE')).not.toThrow();
    expect(() => assertJobTransition('EN_ROUTE', 'ARRIVED')).not.toThrow();
    expect(() => assertJobTransition('ARRIVED', 'VERIFIED')).not.toThrow();
    expect(() => assertJobTransition('VERIFIED', 'DIAGNOSING')).not.toThrow();
    expect(() => assertJobTransition('DIAGNOSING', 'QUOTE_PENDING')).not.toThrow();
    expect(() => assertJobTransition('QUOTE_PENDING', 'QUOTE_APPROVED')).not.toThrow();
    expect(() => assertJobTransition('QUOTE_APPROVED', 'REPAIRING')).not.toThrow();
    expect(() => assertJobTransition('REPAIRING', 'COMPLETED')).not.toThrow();
  });

  it('rejects starting work before OTP verification', () => {
    expect(() => assertJobTransition('ACCEPTED', 'REPAIRING')).toThrow();
    expect(() => assertJobTransition('ARRIVED', 'COMPLETED')).toThrow();
    expect(() => assertJobTransition('COMPLETED', 'REPAIRING')).toThrow();
    expect(JOB_TRANSITIONS.COMPLETED).toEqual([]);
  });
});

describe('mechanic state machine', () => {
  it('allows going online and taking work', () => {
    expect(() => assertMechanicTransition('OFFLINE', 'AVAILABLE')).not.toThrow();
    expect(() => assertMechanicTransition('AVAILABLE', 'EN_ROUTE')).not.toThrow();
    expect(() => assertMechanicTransition('EN_ROUTE', 'ON_JOB')).not.toThrow();
    expect(() => assertMechanicTransition('ON_JOB', 'AVAILABLE')).not.toThrow();
  });

  it('keeps SUSPENDED mechanics off the road until reinstated', () => {
    expect(MECHANIC_TRANSITIONS.SUSPENDED).toEqual(['OFFLINE']);
    expect(() => assertMechanicTransition('SUSPENDED', 'AVAILABLE')).toThrow();
    expect(() => assertMechanicTransition('SUSPENDED', 'OFFLINE')).not.toThrow();
  });
});

describe('canTransition', () => {
  it('returns false for unknown source statuses', () => {
    expect(canTransition(REQUEST_TRANSITIONS, 'NOPE' as RequestStatus, 'PAID')).toBe(false);
  });
});
