import { z } from 'zod';
import { changeFields } from '../domain/fields';

const name = z.string().min(1).max(300);
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a calendar date YYYY-MM-DD');
const optionalName = name.nullish();
export const teamInput = z.object({ team: optionalName, includeStale: z.boolean().optional() });
export const memberInput = z.object({ member: name, from: date, to: date });
export const projectInput = z.object({ project: name });
export const milestoneInput = z.object({ project: name, milestone: name });
export const changesInput = z.object({
  from: date, to: date, member: optionalName, project: optionalName, issue: optionalName,
  fields: z.array(z.enum(changeFields)).optional(),
  limit: z.number().int().min(1).max(500).optional(), cursor: z.string().max(1000).optional(),
});
export const weeklyInput = z.object({ member: name, week: z.enum(['current', 'previous']).optional(), weekStart: date.optional() });
