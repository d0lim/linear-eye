import { Clock, Effect } from 'effect';
import { Database } from '../db/database';
import { AppConfig } from '../services';
import { addDays, calendarDate, inputPeriod, invalid, issueRef, issueSelect, localDate, memberRef, reportContext, resolveMember, type IssueRow } from './common';
import { hydrateChanges, queryChangeRows, referenceId, stateType, type Change, type ChangeValue } from './changes';

export interface MemberActivityInput { member: string; from: string; to: string }
export interface WeeklyReportInput { member: string; week?: 'current' | 'previous'; weekStart?: string }
const scopeFields = new Set(['project', 'project_milestone', 'priority', 'estimate', 'due_date']);
function categories(changes: ReadonlyArray<Change>, memberId: string) {
  const completed: Change[] = [], started: Change[] = [], reopened: Change[] = [], assigned: Change[] = [], unassigned: Change[] = [], scopeChanges: Change[] = [], otherChanges: Change[] = [];
  for (const change of changes) {
    const before = stateType(change.before), after = stateType(change.after);
    if (change.field === 'state') {
      if (after === 'completed' && before !== 'completed') completed.push(change);
      else if ((before === 'backlog' || before === 'unstarted') && after === 'started') started.push(change);
      else if ((before === 'completed' && (after === 'started' || after === 'unstarted')) || (before === 'canceled' && after === 'started')) reopened.push(change);
      else otherChanges.push(change);
    } else if (change.field === 'assignee') {
      if (referenceId(change.after) === memberId && referenceId(change.before) !== memberId) assigned.push(change);
      if (referenceId(change.before) === memberId && referenceId(change.after) !== memberId) unassigned.push(change);
    } else if (scopeFields.has(change.field)) scopeChanges.push(change);
    else otherChanges.push(change);
  }
  return { completed, started, reopened, assigned, unassigned, scopeChanges, otherChanges };
}
export const getMemberActivity = (input: MemberActivityInput) => Effect.gen(function* () {
  const period = yield* inputPeriod(input);
  const context = yield* reportContext(period.start);
  const member = yield* resolveMember(input.member);
  const rows = yield* queryChangeRows({ period, memberId: member.id });
  const changes = yield* hydrateChanges(rows);
  return { generatedAt: context.generatedAt, member: memberRef(member), period, coverage: context.coverage,
    lastFullSyncCompletedAt: context.lastFullSyncCompletedAt, ...categories(changes, member.id) };
});

function uniqueIssues(changes: ReadonlyArray<Change>) { return [...new Map(changes.map((change) => [change.issue.id, change])).values()]; }
function markdownText(value: string): string { return value.replace(/[\r\n]+/g, ' ').replace(/[\\`*_{}\[\]<>#|]/g, '\\$&'); }
function valueText(value: ChangeValue): string {
  if (value === null) return 'None';
  return markdownText(typeof value === 'object' ? value.name ?? value.id : String(value));
}
function draft(completed: Change[], started: Change[], reopened: Change[], scopeChanges: Change[], current: ReturnType<typeof issueRef>[]): string {
  const issueLine = (issue: { id: string; identifier: string | null; title: string | null }) => `- ${markdownText(issue.identifier ?? issue.id)} — ${markdownText(issue.title ?? '')}`;
  const sections: string[] = [];
  const section = (title: string, lines: string[]) => { if (lines.length) sections.push(`## ${title}\n\n${lines.join('\n')}`); };
  section('Completed', uniqueIssues(completed).map((change) => issueLine(change.issue)));
  section('Started', uniqueIssues(started).map((change) => issueLine(change.issue)));
  section('Reopened', uniqueIssues(reopened).map((change) => issueLine(change.issue)));
  section('In progress', current.map(issueLine));
  section('Scope changes', scopeChanges.map((change) => `- ${markdownText(change.issue.identifier ?? change.issue.id)} — ${change.field}: ${valueText(change.before)} → ${valueText(change.after)}`));
  return sections.join('\n\n');
}
export const getWeeklyReport = (input: WeeklyReportInput) => Effect.gen(function* () {
  const config = yield* AppConfig;
  const now = yield* Clock.currentTimeMillis;
  const weekStart = yield* Effect.try({ try: () => {
    if (input.weekStart !== undefined) {
      if (input.week !== undefined || !calendarDate(input.weekStart) || new Date(`${input.weekStart}T00:00:00.000Z`).getUTCDay() !== 1) throw invalid('weekStart must be a Monday and cannot be combined with week');
      return input.weekStart;
    }
    if (input.week !== undefined && input.week !== 'current' && input.week !== 'previous') throw invalid('week must be current or previous');
    const today = localDate(now, config.timezone);
    const day = new Date(`${today}T00:00:00.000Z`).getUTCDay();
    return addDays(today, -((day + 6) % 7) - (input.week === 'previous' ? 7 : 0));
  }, catch: (error) => error instanceof Error && '_tag' in error ? error as ReturnType<typeof invalid> : invalid('Invalid report timezone or week') });
  const activity = yield* getMemberActivity({ member: input.member, from: weekStart, to: addDays(weekStart, 6) });
  const db = yield* Database;
  const rows = yield* db.all<IssueRow>(`${issueSelect()} WHERE i.assignee_id=? AND s.type='started' AND i.deleted_at IS NULL AND i.archived_at IS NULL ORDER BY i.identifier`, [activity.member.id]);
  const currentlyInProgress = rows.map(issueRef);
  return { ...activity, summary: { completedCount: uniqueIssues(activity.completed).length, startedCount: uniqueIssues(activity.started).length,
    reopenedCount: uniqueIssues(activity.reopened).length, scopeChangeCount: uniqueIssues(activity.scopeChanges).length },
    currentlyInProgress, currentlyInProgressAsOf: activity.generatedAt,
    draftMarkdown: draft(activity.completed, activity.started, activity.reopened, activity.scopeChanges, currentlyInProgress) };
});
