/**
 * Dispatch engine — candidate filtering + ranking.
 *
 * Pure functions are exported separately so they can be unit tested without a
 * database. Ranking weights are internal and intentionally NOT exposed to
 * customers.
 */

export interface CandidateSignal {
  userId: string;
  fullName: string;
  latitude: number;
  longitude: number;
  serviceRadiusKm: number;
  status: string;
  verificationStatus: string;
  /** km from the emergency location */
  distanceKm: number;
  skills: string[];
  equipment: string[];
  vehicleTypes: string[];
  reliabilityScore: number;
  /** 0..1 */
  acceptanceRate: number;
  /** 0..1 */
  cancellationRate: number;
  activeJobs: number;
  ratingAverage: number;
  ratingCount: number;
  /** true when the mechanic belongs to a verified workshop */
  workshopAffiliated: boolean;
}

export interface DispatchRequirements {
  requiredSkills: string[];
  requiredEquipment: string[];
  vehicleType?: string | null;
  radiusKm: number;
  excludeMechanicIds?: string[];
  maxActiveJobs: number;
}

export interface ScoredCandidate extends CandidateSignal {
  score: number;
  etaMinutes: number;
  matchedSkills: string[];
  missingSkills: string[];
  matchedEquipment: string[];
  missingEquipment: string[];
  supportsVehicleType: boolean;
}

export const RANKING_WEIGHTS = {
  distance: 0.3,
  skill: 0.18,
  equipment: 0.08,
  reliability: 0.14,
  acceptance: 0.1,
  cancellation: 0.08,
  workload: 0.06,
  rating: 0.06,
} as const;

/** Average urban speed used for ETA (km/h). */
const AVG_SPEED_KMH = 30;

export function estimateEtaMinutes(distanceKm: number): number {
  return Math.max(1, Math.round((distanceKm / AVG_SPEED_KMH) * 60));
}

function overlap(a: string[], b: string[]): string[] {
  const set = new Set(b);
  return a.filter((v) => set.has(v));
}

/**
 * Hard availability filters (verified, available, in radius, not overloaded,
 * not already attempted).
 */
export function filterCandidates(
  signals: CandidateSignal[],
  req: DispatchRequirements,
): CandidateSignal[] {
  const excluded = new Set(req.excludeMechanicIds ?? []);
  return signals.filter((c) => {
    if (excluded.has(c.userId)) return false;
    if (c.verificationStatus !== 'VERIFIED') return false;
    if (c.status !== 'AVAILABLE') return false;
    if (c.distanceKm > req.radiusKm) return false;
    if (c.distanceKm > c.serviceRadiusKm) return false;
    if (c.activeJobs >= req.maxActiveJobs) return false;
    return true;
  });
}

/**
 * Fit filters: at least one required skill, and at least one required piece of
 * equipment. Two passes: strict (skills + equipment) then relaxed (skills only)
 * so the platform keeps looking instead of leaving the driver stranded.
 */
export function rankFit(
  candidates: CandidateSignal[],
  req: DispatchRequirements,
): { strict: CandidateSignal[]; relaxed: CandidateSignal[] } {
  const strict: CandidateSignal[] = [];
  const relaxed: CandidateSignal[] = [];
  for (const c of candidates) {
    const skillMatch = req.requiredSkills.length === 0 || overlap(req.requiredSkills, c.skills).length > 0;
    const equipmentMatch =
      req.requiredEquipment.length === 0 || overlap(req.requiredEquipment, c.equipment).length > 0;
    if (skillMatch && equipmentMatch) strict.push(c);
    else if (skillMatch) relaxed.push(c);
  }
  return { strict, relaxed };
}

/** Score a single candidate. Higher is better. Internal formula. */
export function scoreCandidate(
  candidate: CandidateSignal,
  req: DispatchRequirements,
): ScoredCandidate {
  const matchedSkills = overlap(req.requiredSkills, candidate.skills);
  const missingSkills = req.requiredSkills.filter((s) => !candidate.skills.includes(s));
  const matchedEquipment = overlap(req.requiredEquipment, candidate.equipment);
  const missingEquipment = req.requiredEquipment.filter((e) => !candidate.equipment.includes(e));

  const skillMatchRatio =
    req.requiredSkills.length === 0 ? 1 : matchedSkills.length / req.requiredSkills.length;
  const equipmentMatchRatio =
    req.requiredEquipment.length === 0 ? 1 : matchedEquipment.length / req.requiredEquipment.length;

  const distanceRatio = Math.min(1, candidate.distanceKm / Math.max(1, req.radiusKm));
  const distanceScore = 1 - distanceRatio;

  const workloadScore = 1 - Math.min(1, candidate.activeJobs / Math.max(1, req.maxActiveJobs));
  const ratingScore =
    candidate.ratingCount === 0
      ? 0.6
      : Math.min(1, candidate.ratingAverage / 5) * (0.7 + 0.3 * Math.min(1, candidate.ratingCount / 50));

  const supportsVehicleType = req.vehicleType
    ? candidate.vehicleTypes.length === 0 || candidate.vehicleTypes.includes(req.vehicleType)
    : true;
  const vehicleScore = supportsVehicleType ? 1 : 0.3;

  const raw =
    RANKING_WEIGHTS.distance * distanceScore +
    RANKING_WEIGHTS.skill * skillMatchRatio +
    RANKING_WEIGHTS.equipment * equipmentMatchRatio +
    RANKING_WEIGHTS.reliability * clamp01(candidate.reliabilityScore) +
    RANKING_WEIGHTS.acceptance * clamp01(candidate.acceptanceRate) +
    RANKING_WEIGHTS.cancellation * (1 - clamp01(candidate.cancellationRate)) +
    RANKING_WEIGHTS.workload * workloadScore +
    RANKING_WEIGHTS.rating * ratingScore;

  const score = Math.round(raw * vehicleScore * 10000) / 10000;

  return {
    ...candidate,
    score,
    etaMinutes: estimateEtaMinutes(candidate.distanceKm),
    matchedSkills,
    missingSkills,
    matchedEquipment,
    missingEquipment,
    supportsVehicleType,
  };
}

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(1, v));
}

export interface RankResult {
  candidates: ScoredCandidate[];
  usedRelaxedFit: boolean;
  radiusUsedKm: number;
}

/**
 * Full ranking pipeline for a single radius: filter -> fit -> score -> sort.
 */
export function rankCandidates(
  signals: CandidateSignal[],
  req: DispatchRequirements,
): RankResult {
  const available = filterCandidates(signals, req);
  const { strict, relaxed } = rankFit(available, req);
  const usedRelaxedFit = strict.length === 0 && relaxed.length > 0;
  const pool = strict.length > 0 ? strict : relaxed;
  const scored = pool.map((c) => scoreCandidate(c, req));
  scored.sort((a, b) => b.score - a.score || a.distanceKm - b.distanceKm);
  return { candidates: scored, usedRelaxedFit, radiusUsedKm: req.radiusKm };
}

export function cancellationRate(jobsCancelled: number, jobsCompleted: number): number {
  const total = jobsCancelled + jobsCompleted;
  if (total === 0) return 0;
  return jobsCancelled / total;
}

export function acceptanceRate(accepted: number, received: number): number {
  if (received <= 0) return 1;
  return Math.max(0, Math.min(1, accepted / received));
}
