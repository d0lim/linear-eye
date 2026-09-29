import { describe, expect, test } from 'vitest';
import { Effect } from 'effect';
import { getMilestoneProgress, getProjectProgress, getTeamCurrentWork } from '../src/intelligence';
import { runDb, seed } from './helpers';

async function base() {
  await seed("INSERT INTO meta(key,value,updated_at) VALUES ('tracking_started_at','2026-09-01T00:00:00.000Z','2026-09-01T00:00:00.000Z'),('last_full_sync_completed_at','2026-09-01T01:00:00.000Z','2026-09-01T01:00:00.000Z')");
  await seed("INSERT INTO projects(id,name) VALUES ('p','Custody'),('p2','Other')");
  await seed("INSERT INTO project_milestones(id,project_id,name) VALUES ('m','p','Beta'),('m2','p2','Beta')");
  await seed("INSERT INTO users(id,name) VALUES ('alice','Alice'),('bob','Bob')");
  for (const state of ['completed', 'started', 'unstarted', 'backlog', 'canceled']) await seed('INSERT INTO workflow_states(id,team_id,name,type) VALUES (?,?,?,?)', [state, 'team', state, state]);
}
async function issue(id: string, state: string, estimate: number | null = null, extra: { archived?: boolean; deleted?: boolean; assignee?: string } = {}) {
  await seed('INSERT INTO issues(id,identifier,title,team_id,state_id,project_id,project_milestone_id,assignee_id,estimate,last_synced_at,updated_at,archived_at,deleted_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
    [id, `PAY-${id}`, `Issue ${id}`, 'team', state, 'p', 'm', extra.assignee ?? 'alice', estimate, '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z', extra.archived ? '2026-09-02T00:00:00.000Z' : null, extra.deleted ? '2026-09-02T00:00:00.000Z' : null]);
}
describe('progress intelligence', () => {
  test('requires completed bootstrap and preserves error contract', async () => {
    const result = await runDb(getProjectProgress({ project: 'p' }).pipe(Effect.result));
    expect(result).toMatchObject({ _tag: 'Failure', failure: { code: 'SYNC_NOT_READY' } });
  });
  test('excludes canceled, archived and deleted from denominator and preserves null estimates', async () => {
    await base();
    for (let index = 0; index < 6; index++) await issue(`done${index}`, 'completed', index === 0 ? 3 : index === 1 ? 5 : null);
    for (let index = 0; index < 2; index++) await issue(`started${index}`, 'started', index === 0 ? 5 : null);
    for (let index = 0; index < 2; index++) await issue(`todo${index}`, 'unstarted', index === 0 ? 3 : null);
    await issue('canceled', 'canceled', 100);
    await issue('archived', 'completed', 100, { archived: true });
    await issue('deleted', 'completed', 100, { deleted: true });
    const result = await runDb(getProjectProgress({ project: 'Custody' }));
    expect(result.issueCount).toMatchObject({ total: 10, completed: 6, started: 2, unstarted: 2, canceled: 1 });
    expect(result.progress).toEqual({ byCount: 0.6, byEstimate: 0.5 });
    expect(result.milestones).toHaveLength(1);
    const milestone = await runDb(getMilestoneProgress({ project: 'p', milestone: 'Beta' }));
    expect(milestone.milestone.id).toBe('m');
    expect(milestone.issues.remaining).toHaveLength(2);
    expect(milestone.issues.completed).toHaveLength(6);
  });
  test('returns null progress for empty projects and null estimate progress without points', async () => {
    await base();
    await issue('1', 'completed');
    expect((await runDb(getProjectProgress({ project: 'p' }))).progress).toEqual({ byCount: 1, byEstimate: null });
    expect((await runDb(getProjectProgress({ project: 'p2' }))).progress).toEqual({ byCount: null, byEstimate: null });
  });
  test('missing workflow-state data is reported without inventing eligible work', async () => {
    await base();
    await issue('known', 'completed', 3);
    await issue('unknown', 'missing', 100);
    const result = await runDb(getProjectProgress({ project: 'p' }));
    expect(result.issueCount).toMatchObject({ total: 1, completed: 1, unknown: 1 });
    expect(result.progress).toEqual({ byCount: 1, byEstimate: 1 });
  });
  test('current work includes assigned started issues and uses latest event for activity', async () => {
    await base();
    await issue('10', 'started');
    await issue('11', 'unstarted');
    await issue('20', 'started', null, { assignee: 'bob' });
    await seed("INSERT INTO events(id,entity_type,entity_id,action,occurred_at,received_at,source) VALUES ('recent','Issue','10','update','2099-01-01T00:00:00.000Z','2099-01-01T00:00:00.000Z','webhook')");
    const report = await runDb(getTeamCurrentWork({}));
    expect(report.members.map((member) => [member.user.id, member.issues.map((item) => item.identifier)])).toEqual([['alice', ['PAY-10']], ['bob', ['PAY-20']]]);
    expect(report.members[0].issues[0]).toMatchObject({ stale: false, daysSinceActivity: 0, lastActivityAt: '2099-01-01T00:00:00.000Z' });
    const withoutStale = await runDb(getTeamCurrentWork({ includeStale: false }));
    expect(withoutStale.members.flatMap((member) => member.issues).every((item) => !item.stale)).toBe(true);
  });
});
