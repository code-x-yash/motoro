import { describe, expect, it } from 'vitest';
import { AVG_SPEED_KMH, bearingDeg, distanceKm, etaMinutes, roundKm, toRad } from './geo';

const MUMBAI = [19.076, 72.8777] as const;
const DELHI = [28.6139, 77.209] as const;

describe('distanceKm', () => {
  it('is zero for identical points', () => {
    expect(distanceKm(MUMBAI[0], MUMBAI[1], MUMBAI[0], MUMBAI[1])).toBe(0);
  });

  it('is symmetric', () => {
    const a = distanceKm(MUMBAI[0], MUMBAI[1], DELHI[0], DELHI[1]);
    const b = distanceKm(DELHI[0], DELHI[1], MUMBAI[0], MUMBAI[1]);
    expect(a).toBeCloseTo(b, 6);
    expect(a).toBeGreaterThan(1000);
    expect(a).toBeLessThan(1300);
  });

  it('matches a known short distance (1 degree latitude ~ 111 km)', () => {
    expect(distanceKm(19, 72.8, 20, 72.8)).toBeCloseTo(111, 0);
  });
});

describe('etaMinutes', () => {
  it('uses the average urban speed', () => {
    expect(AVG_SPEED_KMH).toBe(30);
    expect(etaMinutes(5)).toBe(10);
    expect(etaMinutes(30)).toBe(60);
  });

  it('clamps to a 1 minute minimum and rejects bad input', () => {
    expect(etaMinutes(0.01)).toBe(1);
    expect(etaMinutes(0)).toBe(1);
    expect(etaMinutes(-4)).toBe(0);
    expect(etaMinutes(Number.NaN)).toBe(0);
  });
});

describe('bearingDeg', () => {
  it('points north for a due-north target', () => {
    expect(bearingDeg(19, 72.8, 20, 72.8)).toBeCloseTo(0, 1);
  });

  it('points east for a due-east target', () => {
    const east = bearingDeg(19, 72.8, 19, 73.8);
    expect(Math.abs(east - 90)).toBeLessThan(1);
  });

  it('stays within 0..360', () => {
    const bearing = bearingDeg(DELHI[0], DELHI[1], MUMBAI[0], MUMBAI[1]);
    expect(bearing).toBeGreaterThanOrEqual(0);
    expect(bearing).toBeLessThan(360);
  });
});

describe('helpers', () => {
  it('converts degrees to radians', () => {
    expect(toRad(180)).toBeCloseTo(Math.PI, 10);
  });

  it('rounds to one decimal', () => {
    expect(roundKm(4.44)).toBe(4.4);
    expect(roundKm(4.46)).toBe(4.5);
  });
});
