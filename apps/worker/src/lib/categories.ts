import type { Env } from '../env';
import { ISSUE_REQUIRED_EQUIPMENT, ISSUE_REQUIRED_SKILLS, ISSUE_TYPES, type IssueType } from '@rr/config';

/**
 * Service categories are admin-managed (service_categories table) and take
 * effect at runtime: an active row overrides the built-in config defaults for
 * request creation and dispatch matching.
 */

interface CategoryRow {
  required_skills: string;
  required_equipment: string;
  active: number;
}

export function parseJsonArray(raw: string | null | undefined): string[] | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map((v) => String(v)) : null;
  } catch {
    return null;
  }
}

export async function getActiveCategory(
  env: Env,
  code: string,
): Promise<{ requiredSkills: string[]; requiredEquipment: string[] } | null> {
  const row = await env.DB.prepare(
    'SELECT required_skills, required_equipment, active FROM service_categories WHERE code = ?',
  )
    .bind(code)
    .first<CategoryRow>();
  if (!row || !row.active) return null;
  return {
    requiredSkills: parseJsonArray(row.required_skills) ?? [],
    requiredEquipment: parseJsonArray(row.required_equipment) ?? [],
  };
}

export function configRequirements(issueType: string): {
  requiredSkills: string[];
  requiredEquipment: string[];
} {
  if ((ISSUE_TYPES as readonly string[]).includes(issueType)) {
    return {
      requiredSkills: [...ISSUE_REQUIRED_SKILLS[issueType as IssueType]],
      requiredEquipment: [...ISSUE_REQUIRED_EQUIPMENT[issueType as IssueType]],
    };
  }
  return {
    requiredSkills: [...ISSUE_REQUIRED_SKILLS.GENERAL_BREAKDOWN],
    requiredEquipment: [...ISSUE_REQUIRED_EQUIPMENT.GENERAL_BREAKDOWN],
  };
}

/** Active DB category first, built-in config as the fallback. */
export async function requirementsForIssue(
  env: Env,
  issueType: string,
): Promise<{ requiredSkills: string[]; requiredEquipment: string[] }> {
  return (await getActiveCategory(env, issueType)) ?? configRequirements(issueType);
}
