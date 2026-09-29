import { Clock, Effect } from 'effect';
import { Database } from '../db/database';
import { AppError } from '../errors';
import { AppConfig } from '../services';

export interface Member { id: string; name: string; display_name: string | null; email: string | null }
export interface Project { id: string; name: string; url: string | null; start_date: string | null; target_date: string | null }
export interface Milestone { id: string; name: string; project_id: string; target_date: string | null }
export interface Period { from: string; to: string; start: string; endExclusive: string; timezone: string }
export const invalid = (message: string) => new AppError({ code: 'INVALID_DATE_RANGE', message });

export function calendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
export function addDays(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}
const dateFormatters = new Map<string, Intl.DateTimeFormat>();
export function localDate(timestamp: number, timezone: string): string {
  let formatter = dateFormatters.get(timezone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' });
    if (dateFormatters.size >= 8) dateFormatters.delete(dateFormatters.keys().next().value!);
    dateFormatters.set(timezone, formatter);
  }
  const parts = formatter.formatToParts(timestamp);
  const part = (type: string) => parts.find((entry) => entry.type === type)!.value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}

// Find the first instant of the local calendar day. This also handles zones
// whose DST transition skips midnight; adding 24 hours to UTC would not.
function dayStart(date: string, timezone: string): string {
  const center = Date.parse(`${date}T00:00:00.000Z`);
  let lower = center - 36 * 3_600_000;
  let upper = center + 36 * 3_600_000;
  while (lower < upper) {
    const middle = Math.floor((lower + upper) / 2);
    if (localDate(middle, timezone) < date) lower = middle + 1;
    else upper = middle;
  }
  if (localDate(lower, timezone) !== date) throw invalid('Calendar date does not exist in the report timezone');
  return new Date(lower).toISOString();
}
export function periodFor(from: string, to: string, timezone: string) {
  return Effect.try({
    try: (): Period => {
      if (!calendarDate(from) || !calendarDate(to) || from > to) throw invalid('Use valid calendar dates with from on or before to');
      return { from, to, start: dayStart(from, timezone), endExclusive: dayStart(addDays(to, 1), timezone), timezone };
    },
    catch: (error) => error instanceof AppError ? error : invalid('Invalid report timezone or date range'),
  });
}

export const reportContext = (start?: string) => Effect.gen(function* () {
  const db = yield* Database;
  const now = yield* Clock.currentTimeMillis;
  const metadata = yield* db.all<{ key: string; value: string }>(
    "SELECT key,value FROM meta WHERE key IN ('tracking_started_at','last_full_sync_completed_at')");
  const values = new Map(metadata.map((item) => [item.key, item.value]));
  const lastFullSyncCompletedAt = values.get('last_full_sync_completed_at');
  if (!lastFullSyncCompletedAt) return yield* Effect.fail(new AppError({ code: 'SYNC_NOT_READY', message: 'Initial full sync has not completed' }));
  const generatedAt = new Date(now).toISOString();
  const trackingStartedAt = values.get('tracking_started_at') ?? null;
  return { now, generatedAt, lastFullSyncCompletedAt, coverage: {
    complete: trackingStartedAt !== null && (start ?? generatedAt) >= trackingStartedAt,
    trackingStartedAt,
  } };
});
export const inputPeriod = (input: { from: string; to: string }) => Effect.gen(function* () {
  const config = yield* AppConfig;
  return yield* periodFor(input.from, input.to, config.timezone);
});

function resolve<A extends { id: string }>(table: string, columns: ReadonlyArray<string>, value: string, kind: string, scope?: { column: string; value: string }, includeDeleted = false) {
  return Effect.gen(function* () {
    const db = yield* Database;
    for (const column of columns) {
      const rows = yield* db.all<A>(`SELECT * FROM ${table} WHERE ${column} = ?${includeDeleted ? '' : ' AND deleted_at IS NULL'}${scope ? ` AND ${scope.column} = ?` : ''} ORDER BY id`, scope ? [value, scope.value] : [value]);
      if (rows.length === 1) return rows[0];
      if (rows.length > 1) return yield* Effect.fail(new AppError({ code: `AMBIGUOUS_${kind}`, message: `${kind[0]}${kind.slice(1).toLowerCase()} matches multiple records`, details: { candidates: rows } }));
    }
    return yield* Effect.fail(new AppError({ code: `${kind}_NOT_FOUND`, message: `${kind[0]}${kind.slice(1).toLowerCase()} not found` }));
  });
}
export const resolveMember = (value: string) => resolve<Member>('users', ['id', 'email', 'display_name', 'name'], value, 'MEMBER');
export const resolveProject = (value: string) => resolve<Project>('projects', ['id', 'name'], value, 'PROJECT');
export const resolveMilestone = (value: string, projectId: string) => resolve<Milestone>('project_milestones', ['id', 'name'], value, 'MILESTONE', { column: 'project_id', value: projectId });
export const resolveTeam = (value: string) => resolve<{ id: string; name: string; key: string }>('teams', ['id', 'key', 'name'], value, 'TEAM');
export const resolveIssue = (value: string) => resolve<{ id: string; identifier: string }>('issues', ['id', 'identifier'], value, 'ISSUE', undefined, true);
export const memberRef = (member: Member) => ({ id: member.id, name: member.name, displayName: member.display_name, email: member.email });
export const projectRef = (project: Project) => ({ id: project.id, name: project.name, url: project.url, startDate: project.start_date, targetDate: project.target_date });
export const milestoneRef = (milestone: Milestone) => ({ id: milestone.id, name: milestone.name, targetDate: milestone.target_date });

export interface IssueRow {
  id: string; identifier: string; title: string; state_id: string; state_name: string | null; state_type: string | null;
  assignee_id: string | null; assignee_name: string | null; assignee_display_name: string | null; assignee_email: string | null;
  project_id: string | null; project_name: string | null; project_milestone_id: string | null; milestone_name: string | null;
  priority: number | null; estimate: number | null; updated_at: string | null; latest_event_at: string | null; url: string | null;
}
export const issueSelect = (withActivity = false) => `SELECT i.id,i.identifier,i.title,i.state_id,s.name AS state_name,s.type AS state_type,
  i.assignee_id,u.name AS assignee_name,u.display_name AS assignee_display_name,u.email AS assignee_email,
  i.project_id,p.name AS project_name,i.project_milestone_id,m.name AS milestone_name,
  i.priority,i.estimate,i.updated_at,i.url,
  ${withActivity ? "(SELECT MAX(e.occurred_at) FROM events e WHERE e.entity_type='Issue' AND e.entity_id=i.id)" : 'NULL'} AS latest_event_at
  FROM issues i LEFT JOIN workflow_states s ON s.id=i.state_id
  LEFT JOIN users u ON u.id=i.assignee_id LEFT JOIN projects p ON p.id=i.project_id
  LEFT JOIN project_milestones m ON m.id=i.project_milestone_id`;
export function issueRef(issue: IssueRow) {
  return { id: issue.id, identifier: issue.identifier, title: issue.title, state: issue.state_name,
    stateType: issue.state_type, project: issue.project_name, milestone: issue.milestone_name,
    priority: issue.priority, estimate: issue.estimate, updatedAt: issue.updated_at, url: issue.url };
}
export function staleInfo(issue: IssueRow, now: number, threshold: number) {
  const timestamps = [issue.updated_at, issue.latest_event_at].filter((value): value is string => value !== null).map(Date.parse).filter(Number.isFinite);
  if (!timestamps.length) return { stale: false, daysSinceActivity: null, lastActivityAt: null };
  const last = Math.max(...timestamps);
  const daysSinceActivity = Math.max(0, Math.floor((now - last) / 86_400_000));
  return { stale: issue.state_type === 'started' && daysSinceActivity >= threshold, daysSinceActivity, lastActivityAt: new Date(last).toISOString() };
}
