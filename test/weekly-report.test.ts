import { expect, test } from 'vitest';
import { Effect } from 'effect';
import { TestClock } from 'effect/testing';
import { getWeeklyReport } from '../src/intelligence';
import { runDb, seed } from './helpers';

async function fixture() {
  await seed("INSERT INTO meta(key,value,updated_at) VALUES ('tracking_started_at','2026-09-01T00:00:00.000Z','2026-09-01T00:00:00.000Z'),('last_full_sync_completed_at','2026-09-01T01:00:00.000Z','2026-09-01T01:00:00.000Z')");
  await seed("INSERT INTO users(id,name,email) VALUES ('alice','Alice','alice@example.com'),('bob','Bob','bob@example.com')");
  await seed("INSERT INTO projects(id,name) VALUES ('p','Storefront')");
  await seed("INSERT INTO project_milestones(id,project_id,name) VALUES ('catalog','p','Catalog'),('checkout','p','Checkout')");
  for (const state of ['unstarted', 'started', 'completed', 'canceled']) await seed('INSERT INTO workflow_states(id,team_id,name,type) VALUES (?,?,?,?)', [state, 't', state, state]);
  for (const [id, state] of [['A', 'started'], ['B', 'completed'], ['C', 'started'], ['D', 'unstarted']]) {
    await seed('INSERT INTO issues(id,identifier,title,team_id,state_id,assignee_id,project_id,last_synced_at) VALUES (?,?,?,?,?,?,?,?)', [id, `SHOP-${id}`, `Checkout task ${id}`, 't', state, 'alice', 'p', '2026-09-01T00:00:00.000Z']);
  }
  for (const [id, field, before, after] of [['A', 'state', 'unstarted', 'started'], ['B', 'state', 'started', 'completed'], ['C', 'state', 'completed', 'started'], ['D', 'project_milestone', 'catalog', 'checkout']]) {
    await seed('INSERT INTO events(id,entity_type,entity_id,actor_id,actor_name,action,occurred_at,received_at,source) VALUES (?,?,?,?,?,?,?,?,?)', [id, 'Issue', id, 'bob', 'Bob', 'update', '2026-09-22T01:00:00.000Z', '2026-09-22T01:00:00.000Z', 'webhook']);
    await seed('INSERT INTO field_changes(id,event_id,entity_type,entity_id,field_name,old_value,new_value,occurred_at) VALUES (?,?,?,?,?,?,?,?)', [`${id}:${field}`, id, 'Issue', id, field, JSON.stringify(before), JSON.stringify(after), '2026-09-22T01:00:00.000Z']);
  }
}
test('weekly report classifies deterministic transition fixtures without confusing actor and assignee', async () => {
  await fixture();
  const result = await runDb(getWeeklyReport({ member: 'alice@example.com', weekStart: '2026-09-21' }));
  expect(result.summary).toEqual({ completedCount: 1, startedCount: 1, reopenedCount: 1, scopeChangeCount: 1 });
  expect(result.started[0].issue.id).toBe('A');
  expect(result.completed[0].issue.id).toBe('B');
  expect(result.reopened[0].issue.id).toBe('C');
  expect(result.scopeChanges[0]).toMatchObject({ issue: { id: 'D' }, before: { name: 'Catalog' }, after: { name: 'Checkout' } });
  expect(result.completed[0]).toMatchObject({ actor: { id: 'bob' }, affectedAssignee: { after: { id: 'alice' }, inferred: true } });
  expect(result.currentlyInProgress.map((issue) => issue.id)).toEqual(['A', 'C']);
  expect(result.currentlyInProgressAsOf).toBe(result.generatedAt);
  expect(result.draftMarkdown).toBe([
    '## Completed\n\n- SHOP-B — Checkout task B',
    '## Started\n\n- SHOP-A — Checkout task A',
    '## Reopened\n\n- SHOP-C — Checkout task C',
    '## In progress\n\n- SHOP-A — Checkout task A\n- SHOP-C — Checkout task C',
    '## Scope changes\n\n- SHOP-D — project_milestone: Catalog → Checkout',
  ].join('\n\n'));
  expect(result.period).toMatchObject({ start: '2026-09-20T15:00:00.000Z', endExclusive: '2026-09-27T15:00:00.000Z' });
  const bob = await runDb(getWeeklyReport({ member: 'bob', weekStart: '2026-09-21' }));
  expect(bob.summary.completedCount).toBe(0);
  expect(bob.draftMarkdown).toBe('');
});
test('weekly draft renders missing change values in English and escapes Markdown', async () => {
  await fixture();
  await seed('UPDATE field_changes SET old_value=? WHERE id=?', ['null', 'D:project_milestone']);
  await seed('UPDATE project_milestones SET name=? WHERE id=?', ['Checkout [draft]\n*updated*', 'checkout']);
  const result = await runDb(getWeeklyReport({ member: 'alice', weekStart: '2026-09-21' }));
  expect(result.draftMarkdown).toContain('project_milestone: None → Checkout \\[draft\\] \\*updated\\*');
});
test('weekly default and previous use injected Effect clock and Monday in report timezone', async () => {
  await fixture();
  const program = Effect.gen(function* () {
    yield* TestClock.setTime(Date.parse('2026-09-27T15:05:00.000Z'));
    return { current: yield* getWeeklyReport({ member: 'alice', week: 'current' }), previous: yield* getWeeklyReport({ member: 'alice', week: 'previous' }) };
  }).pipe(Effect.provide(TestClock.layer()));
  const result = await runDb(program);
  expect(result.current.period.from).toBe('2026-09-28');
  expect(result.previous.period.from).toBe('2026-09-21');
});
test('rejects non-Monday and conflicting weekly inputs', async () => {
  await fixture();
  for (const input of [{ member: 'alice', weekStart: '2026-09-22' }, { member: 'alice', week: 'current' as const, weekStart: '2026-09-21' }]) {
    expect(await runDb(getWeeklyReport(input).pipe(Effect.result))).toMatchObject({ _tag: 'Failure', failure: { code: 'INVALID_DATE_RANGE' } });
  }
});
