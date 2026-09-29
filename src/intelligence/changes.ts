import { Effect } from 'effect';
import { Database, type SqlValue } from '../db/database';
import { AppError } from '../errors';
import { inputPeriod, reportContext, resolveIssue, resolveMember, resolveProject, type Period } from './common';

import { changeFields, type ChangeField } from '../domain/fields';
export { changeFields, type ChangeField } from '../domain/fields';
export interface ChangesInput { from: string; to: string; member?: string; project?: string; issue?: string; fields?: ReadonlyArray<ChangeField>; limit?: number; cursor?: string }
export interface ChangeRow {
  id: string; event_id: string; entity_id: string; field_name: string; old_value: string | null; new_value: string | null; occurred_at: string;
  actor_id: string | null; actor_name: string | null; actor_type: string | null;
  identifier: string | null; title: string | null; url: string | null;
  assignee_before: string; assignee_after: string; assignee_inferred: number;
  project_before: string; project_after: string; project_inferred: number;
}
export interface Reference { id: string; name?: string; type?: string; identifier?: string }
export type ChangeValue = string | number | boolean | null | Reference;
export interface Change {
  id: string; eventId: string; occurredAt: string; issue: { id: string; identifier: string | null; title: string | null; url: string | null };
  actor: { id: string | null; name: string | null; type: string | null };
  field: string; before: ChangeValue; after: ChangeValue;
  affectedAssignee: { before: ChangeValue; after: ChangeValue; inferred: boolean };
  projectAtEvent: { before: ChangeValue; after: ChangeValue; inferred: boolean };
}
function decode(value: string | null): ChangeValue {
  if (value === null) return null;
  try { return JSON.parse(value) as ChangeValue; } catch { return value; }
}
const historyValue = (field: string, value: 'old_value' | 'new_value', sameEvent: boolean) =>
  `(SELECT h.${value} FROM field_changes h WHERE h.entity_type='Issue' AND h.entity_id=f.entity_id AND h.field_name='${field}' AND ${sameEvent ? 'h.event_id=f.event_id' : 'h.occurred_at<f.occurred_at'} ORDER BY h.occurred_at DESC,h.id DESC LIMIT 1)`;

export const queryChangeRows = (input: { period: Period; memberId?: string; projectId?: string; issueId?: string; fields?: ReadonlyArray<string>; limit?: number; cursor?: { time: string; id: string } }) => Effect.gen(function* () {
  const db = yield* Database;
  const params: SqlValue[] = [input.period.start, input.period.endExclusive];
  let where = "f.entity_type='Issue' AND f.occurred_at>=? AND f.occurred_at<?";
  if (input.issueId) { where += ' AND f.entity_id=?'; params.push(input.issueId); }
  if (input.fields?.length) { where += ` AND f.field_name IN (${input.fields.map(() => '?').join(',')})`; params.push(...input.fields); }
  if (input.cursor) { where += ' AND (f.occurred_at>? OR (f.occurred_at=? AND f.id>?))'; params.push(input.cursor.time, input.cursor.time, input.cursor.id); }
  const scope: string[] = [];
  if (input.memberId) { scope.push('(json_extract(assignee_before,\'$\')=? OR json_extract(assignee_after,\'$\')=?)'); params.push(input.memberId, input.memberId); }
  if (input.projectId) { scope.push('(json_extract(project_before,\'$\')=? OR json_extract(project_after,\'$\')=?)'); params.push(input.projectId, input.projectId); }
  if (input.limit) params.push(input.limit);
  return yield* db.all<ChangeRow>(`WITH history AS (
    SELECT f.id,f.event_id,f.entity_id,f.field_name,f.old_value,f.new_value,f.occurred_at,
      COALESCE(e.actor_id,f.actor_id) AS actor_id,COALESCE(e.actor_name,u.name) AS actor_name,e.actor_type,
      i.identifier,i.title,COALESCE(i.url,e.entity_url) AS url,i.assignee_id,i.project_id,
      ${historyValue('assignee', 'old_value', true)} AS same_assignee_before,
      ${historyValue('assignee', 'new_value', true)} AS same_assignee_after,
      ${historyValue('assignee', 'new_value', false)} AS prior_assignee,
      ${historyValue('project', 'old_value', true)} AS same_project_before,
      ${historyValue('project', 'new_value', true)} AS same_project_after,
      ${historyValue('project', 'new_value', false)} AS prior_project
    FROM field_changes f LEFT JOIN events e ON e.id=f.event_id LEFT JOIN issues i ON i.id=f.entity_id
    LEFT JOIN users u ON u.id=COALESCE(e.actor_id,f.actor_id) WHERE ${where}
  ), attributed AS (
    SELECT *,COALESCE(same_assignee_before,prior_assignee,json_quote(assignee_id)) AS assignee_before,
      COALESCE(same_assignee_after,prior_assignee,json_quote(assignee_id)) AS assignee_after,
      CASE WHEN same_assignee_after IS NULL AND prior_assignee IS NULL THEN 1 ELSE 0 END AS assignee_inferred,
      COALESCE(same_project_before,prior_project,json_quote(project_id)) AS project_before,
      COALESCE(same_project_after,prior_project,json_quote(project_id)) AS project_after,
      CASE WHEN same_project_after IS NULL AND prior_project IS NULL THEN 1 ELSE 0 END AS project_inferred
    FROM history
  ) SELECT * FROM attributed${scope.length ? ` WHERE ${scope.join(' AND ')}` : ''}
    ORDER BY occurred_at,id${input.limit ? ' LIMIT ?' : ''}`, params);
});

const referenceTables: Record<string, string> = { assignee: 'users', state: 'workflow_states', project: 'projects', project_milestone: 'project_milestones', parent: 'issues' };
export const hydrateChanges = (rows: ReadonlyArray<ChangeRow>) => Effect.gen(function* () {
  const db = yield* Database;
  const references = new Map<string, Map<string, Reference>>();
  const ids = new Map<string, Set<string>>();
  function collect(field: string, value: ChangeValue) {
    const table = referenceTables[field];
    if (!table || typeof value !== 'string') return;
    if (!ids.has(table)) ids.set(table, new Set());
    ids.get(table)!.add(value);
  }
  for (const row of rows) {
    collect(row.field_name, decode(row.old_value)); collect(row.field_name, decode(row.new_value));
    collect('assignee', decode(row.assignee_before)); collect('assignee', decode(row.assignee_after));
    collect('project', decode(row.project_before)); collect('project', decode(row.project_after));
  }
  for (const [table, set] of ids) {
    const values = [...set];
    const refs = new Map<string, Reference>();
    const columns = table === 'issues' ? 'id,title AS name,identifier' : table === 'workflow_states' ? 'id,name,type' : 'id,name';
    // A single JSON parameter keeps bindings and query count bounded for large reports.
    const items = yield* db.all<Reference>(`SELECT ${columns} FROM ${table} WHERE id IN (SELECT value FROM json_each(?))`, [JSON.stringify(values)]);
    for (const item of items) refs.set(item.id, item);
    references.set(table, refs);
  }
  function human(field: string, value: ChangeValue): ChangeValue {
    if (typeof value !== 'string') return value;
    const table = referenceTables[field];
    if (!table) return field === 'cycle' ? { id: value } : value;
    return references.get(table)?.get(value) ?? { id: value };
  }
  return rows.map((row): Change => ({ id: row.id, eventId: row.event_id, occurredAt: row.occurred_at,
    issue: { id: row.entity_id, identifier: row.identifier, title: row.title, url: row.url },
    actor: { id: row.actor_id, name: row.actor_name, type: row.actor_type },
    field: row.field_name, before: human(row.field_name, decode(row.old_value)), after: human(row.field_name, decode(row.new_value)),
    affectedAssignee: { before: human('assignee', decode(row.assignee_before)), after: human('assignee', decode(row.assignee_after)), inferred: !!row.assignee_inferred },
    projectAtEvent: { before: human('project', decode(row.project_before)), after: human('project', decode(row.project_after)), inferred: !!row.project_inferred },
  }));
});

export const getChanges = (input: ChangesInput) => Effect.gen(function* () {
  const period = yield* inputPeriod(input);
  const context = yield* reportContext(period.start);
  const member = input.member ? yield* resolveMember(input.member) : null;
  const project = input.project ? yield* resolveProject(input.project) : null;
  const issue = input.issue ? yield* resolveIssue(input.issue) : null;
  const limit = input.limit ?? 100;
  if (!Number.isInteger(limit) || limit < 1 || limit > 500 || input.fields?.some((field) => !changeFields.includes(field))) {
    return yield* Effect.fail(new AppError({ code: 'INVALID_INPUT', message: 'Use supported fields and a limit between 1 and 500' }));
  }
  const cursor = yield* Effect.try({ try: () => {
    if (!input.cursor) return undefined;
    const parsed: unknown = JSON.parse(input.cursor);
    if (!Array.isArray(parsed) || parsed.length !== 2 || typeof parsed[0] !== 'string' || typeof parsed[1] !== 'string' || !Number.isFinite(Date.parse(parsed[0]))) throw new Error('invalid');
    return { time: parsed[0], id: parsed[1] };
  }, catch: () => new AppError({ code: 'INVALID_INPUT', message: 'Invalid changes cursor' }) });
  const rows = yield* queryChangeRows({ period, memberId: member?.id, projectId: project?.id, issueId: issue?.id, fields: input.fields, limit: limit + 1, cursor });
  const truncated = rows.length > limit;
  const page = rows.slice(0, limit);
  const changes = yield* hydrateChanges(page);
  const last = page.at(-1);
  return { generatedAt: context.generatedAt, period, coverage: context.coverage, lastFullSyncCompletedAt: context.lastFullSyncCompletedAt,
    changes, truncated, nextCursor: truncated && last ? JSON.stringify([last.occurred_at, last.id]) : null };
});

export function referenceId(value: ChangeValue): string | null { return typeof value === 'string' ? value : value && typeof value === 'object' ? value.id : null; }
export function stateType(value: ChangeValue): string | undefined { return value && typeof value === 'object' ? value.type : undefined; }
