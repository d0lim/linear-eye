import { Effect } from 'effect';
import { Database } from '../db/database';
import { AppConfig } from '../services';
import { type IssueRow, type Milestone, issueRef, issueSelect, memberRef, milestoneRef, projectRef, reportContext, resolveMilestone, resolveProject, resolveTeam, staleInfo } from './common';

export interface TeamCurrentWorkInput { team?: string; includeStale?: boolean }
export const getTeamCurrentWork = (input: TeamCurrentWorkInput) => Effect.gen(function* () {
  const context = yield* reportContext();
  const db = yield* Database;
  const config = yield* AppConfig;
  const team = input.team ? yield* resolveTeam(input.team) : null;
  const rows = yield* db.all<IssueRow>(`${issueSelect(true)} WHERE s.type='started' AND i.deleted_at IS NULL AND i.archived_at IS NULL AND i.assignee_id IS NOT NULL${team ? ' AND i.team_id=?' : ''} ORDER BY COALESCE(u.name,i.assignee_id),i.identifier`, team ? [team.id] : []);
  const members = new Map<string, { user: ReturnType<typeof memberRef>; issues: Array<ReturnType<typeof issueRef> & ReturnType<typeof staleInfo>> }>();
  for (const row of rows) {
    const stale = staleInfo(row, context.now, config.staleIssueDays);
    if (input.includeStale === false && stale.stale) continue;
    const id = row.assignee_id!;
    let member = members.get(id);
    if (!member) { member = { user: memberRef({ id, name: row.assignee_name ?? id, display_name: row.assignee_display_name, email: row.assignee_email }), issues: [] }; members.set(id, member); }
    member.issues.push({ ...issueRef(row), ...stale });
  }
  return { generatedAt: context.generatedAt, coverage: context.coverage, lastFullSyncCompletedAt: context.lastFullSyncCompletedAt, members: [...members.values()] };
});

function progress(rows: ReadonlyArray<IssueRow>) {
  const issueCount = { total: 0, completed: 0, started: 0, unstarted: 0, backlog: 0, canceled: 0, unknown: 0 };
  let totalEstimate = 0;
  let completedEstimate = 0;
  for (const issue of rows) {
    const state = issue.state_type;
    if (state === 'canceled') { issueCount.canceled++; continue; }
    // A missing workflow-state snapshot cannot establish eligibility.
    if (state === null) { issueCount.unknown++; continue; }
    issueCount.total++;
    if (state === 'completed' || state === 'started' || state === 'unstarted' || state === 'backlog') issueCount[state]++;
    else issueCount.unknown++;
    const estimate = issue.estimate ?? 0;
    totalEstimate += estimate;
    if (state === 'completed') completedEstimate += estimate;
  }
  return { issueCount, progress: { byCount: issueCount.total ? issueCount.completed / issueCount.total : null,
    byEstimate: totalEstimate > 0 ? completedEstimate / totalEstimate : null }, estimates: { total: totalEstimate, completed: completedEstimate } };
}
export const getProjectProgress = (input: { project: string }) => Effect.gen(function* () {
  const context = yield* reportContext();
  const db = yield* Database;
  const project = yield* resolveProject(input.project);
  const rows = yield* db.all<IssueRow>(`${issueSelect()} WHERE i.project_id=? AND i.deleted_at IS NULL AND i.archived_at IS NULL ORDER BY i.identifier`, [project.id]);
  const milestones = yield* db.all<Milestone>('SELECT * FROM project_milestones WHERE project_id=? AND deleted_at IS NULL ORDER BY name,id', [project.id]);
  const milestoneIssues = new Map<string, IssueRow[]>();
  for (const issue of rows) {
    if (!issue.project_milestone_id) continue;
    const group = milestoneIssues.get(issue.project_milestone_id) ?? [];
    group.push(issue);
    milestoneIssues.set(issue.project_milestone_id, group);
  }
  return { generatedAt: context.generatedAt, coverage: context.coverage, lastFullSyncCompletedAt: context.lastFullSyncCompletedAt,
    project: projectRef(project), ...progress(rows), milestones: milestones.map((milestone) => ({ milestone: milestoneRef(milestone), ...progress(milestoneIssues.get(milestone.id) ?? []) })) };
});
export const getMilestoneProgress = (input: { project: string; milestone: string }) => Effect.gen(function* () {
  const context = yield* reportContext();
  const db = yield* Database;
  const project = yield* resolveProject(input.project);
  const milestone = yield* resolveMilestone(input.milestone, project.id);
  const rows = yield* db.all<IssueRow>(`${issueSelect()} WHERE i.project_id=? AND i.project_milestone_id=? AND i.deleted_at IS NULL AND i.archived_at IS NULL ORDER BY i.identifier`, [project.id, milestone.id]);
  return { generatedAt: context.generatedAt, coverage: context.coverage, lastFullSyncCompletedAt: context.lastFullSyncCompletedAt,
    project: projectRef(project), milestone: milestoneRef(milestone), ...progress(rows), issues: {
      completed: rows.filter((issue) => issue.state_type === 'completed').map(issueRef),
      started: rows.filter((issue) => issue.state_type === 'started').map(issueRef),
      remaining: rows.filter((issue) => !['completed', 'started', 'canceled'].includes(issue.state_type ?? '')).map(issueRef),
    } };
});
