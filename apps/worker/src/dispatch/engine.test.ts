import { describe, expect, it } from 'vitest';
import {
  acceptanceRate,
  cancellationRate,
  estimateEtaMinutes,
  filterCandidates,
  rankCandidates,
  rankFit,
  scoreCandidate,
  type CandidateSignal,
  type DispatchRequirements,
} from './engine';

function candidate(overrides: Partial<CandidateSignal> = {}): CandidateSignal {
  return {
    userId: 'mech_1',
    fullName: 'Mech One',
    latitude: 19.076,
    longitude: 72.8777,
    serviceRadiusKm: 15,
    status: 'AVAILABLE',
    verificationStatus: 'VERIFIED',
    distanceKm: 2,
    skills: ['battery', 'electrical'],
    equipment: ['jumper_cables'],
    vehicleTypes: ['CAR'],
    reliabilityScore: 0.9,
    acceptanceRate: 0.95,
    cancellationRate: 0.05,
    activeJobs: 0,
    ratingAverage: 4.8,
    ratingCount: 120,
    workshopAffiliated: false,
    ...overrides,
  };
}

const requirements = (overrides: Partial<DispatchRequirements> = {}): DispatchRequirements => ({
  requiredSkills: ['battery'],
  requiredEquipment: ['jumper_cables'],
  vehicleType: 'CAR',
  radiusKm: 10,
  maxActiveJobs: 3,
  ...overrides,
});

describe('filterCandidates', () => {
  it('keeps verified, available mechanics inside both radii', () => {
    const result = filterCandidates(
      [
        candidate(),
        candidate({ userId: 'far', distanceKm: 12 }),
        candidate({ userId: 'self_radius', distanceKm: 16, serviceRadiusKm: 15 }),
        candidate({ userId: 'busy', activeJobs: 3 }),
        candidate({ userId: 'unverified', verificationStatus: 'PENDING' }),
        candidate({ userId: 'offline', status: 'OFFLINE' }),
        candidate({ userId: 'excluded' }),
      ],
      requirements({ excludeMechanicIds: ['excluded'] }),
    );
    expect(result.map((c) => c.userId)).toEqual(['mech_1']);
  });
});

describe('rankFit', () => {
  it('separates strict matches from skills-only (relaxed) matches', () => {
    const { strict, relaxed } = rankFit(
      [
        candidate({ userId: 'full', skills: ['battery'], equipment: ['jumper_cables'] }),
        candidate({ userId: 'skills_only', skills: ['battery'], equipment: ['winch'] }),
        candidate({ userId: 'no_skills', skills: ['tyre'], equipment: ['jumper_cables'] }),
      ],
      requirements(),
    );
    expect(strict.map((c) => c.userId)).toEqual(['full']);
    expect(relaxed.map((c) => c.userId)).toEqual(['skills_only']);
  });

  it('treats empty requirements as always matching', () => {
    const { strict, relaxed } = rankFit(
      [candidate({ skills: [], equipment: [] })],
      requirements({ requiredSkills: [], requiredEquipment: [] }),
    );
    expect(strict).toHaveLength(1);
    expect(relaxed).toHaveLength(0);
  });
});

describe('scoreCandidate / rankCandidates', () => {
  it('prefers the nearer, fully equipped mechanic', () => {
    const near = scoreCandidate(candidate({ userId: 'near', distanceKm: 1 }), requirements());
    const far = scoreCandidate(candidate({ userId: 'far', distanceKm: 9 }), requirements());
    expect(near.score).toBeGreaterThan(far.score);
    expect(near.etaMinutes).toBeLessThanOrEqual(far.etaMinutes);
    expect(near.missingSkills).toEqual([]);
    expect(near.supportsVehicleType).toBe(true);
  });

  it('penalises mechanics that do not support the vehicle type', () => {
    const unsupported = scoreCandidate(
      candidate({ userId: 'bike_only', vehicleTypes: ['TWO_WHEELER'] }),
      requirements(),
    );
    expect(unsupported.supportsVehicleType).toBe(false);
    expect(unsupported.score).toBeLessThan(
      scoreCandidate(candidate({ userId: 'car', vehicleTypes: ['CAR'] }), requirements()).score,
    );
  });

  it('relaxes equipment fit rather than returning nobody', () => {
    const result = rankCandidates(
      [candidate({ userId: 'skills_only', equipment: ['winch'] })],
      requirements(),
    );
    expect(result.usedRelaxedFit).toBe(true);
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]?.userId).toBe('skills_only');
  });

  it('sorts by score descending with distance as a tie-breaker', () => {
    const result = rankCandidates(
      [
        candidate({ userId: 'b', distanceKm: 4 }),
        candidate({ userId: 'a', distanceKm: 1 }),
        candidate({ userId: 'c', distanceKm: 7 }),
      ],
      requirements(),
    );
    expect(result.candidates.map((c) => c.userId)).toEqual(['a', 'b', 'c']);
    expect(result.usedRelaxedFit).toBe(false);
  });

  it('returns an empty pool when nobody is available', () => {
    const result = rankCandidates([candidate({ status: 'OFFLINE' })], requirements());
    expect(result.candidates).toEqual([]);
  });
});

describe('rate helpers', () => {
  it('computes cancellation rate', () => {
    expect(cancellationRate(1, 3)).toBe(0.25);
    expect(cancellationRate(0, 0)).toBe(0);
  });

  it('clamps acceptance rate and treats no offers as a perfect score', () => {
    expect(acceptanceRate(3, 4)).toBe(0.75);
    expect(acceptanceRate(10, 4)).toBe(1);
    expect(acceptanceRate(0, 0)).toBe(1);
  });

  it('estimates ETA with a 1 minute floor', () => {
    expect(estimateEtaMinutes(30)).toBe(60);
    expect(estimateEtaMinutes(0.1)).toBe(1);
  });
});
