import { Hono } from 'hono';
import type { Env } from '../env';
import { ok } from '../lib/response';
import { parseJsonArray } from '../lib/categories';

const routes = new Hono<{ Bindings: Env }>();

/**
 * Public catalog — active service categories that power request creation.
 * Keeps the request form and third-party channels in sync with admin edits.
 */
routes.get('/service-categories', async (c) => {
  const rows = await c.env.DB.prepare(
    `SELECT code, name_en, name_hi, icon, required_skills, required_equipment, sort
     FROM service_categories WHERE active = 1 ORDER BY sort ASC, name_en ASC`,
  ).all<{
    code: string;
    name_en: string;
    name_hi: string;
    icon: string;
    required_skills: string;
    required_equipment: string;
    sort: number;
  }>();
  return ok(
    {
      items: rows.results.map((row) => ({
        code: row.code,
        nameEn: row.name_en,
        nameHi: row.name_hi,
        icon: row.icon,
        requiredSkills: parseJsonArray(row.required_skills) ?? [],
        requiredEquipment: parseJsonArray(row.required_equipment) ?? [],
        sort: row.sort,
      })),
    },
    c.get('requestId'),
  );
});

export default routes;
