import { expect, test } from 'vitest';
import { Effect } from 'effect';
import { getChanges, getMemberActivity } from '../src/intelligence';
import { periodFor } from '../src/intelligence/common';
import { runDb, seed } from './helpers';

async function fixture() {
  await seed("INSERT INTO meta(key,value,updated_at) VALUES ('tracking_started_at','2026-09-01T00:00:00.000Z','2026-09-01T00:00:00.000Z'),('last_full_sync_completed_at','2026-09-01T01:00:00.000Z','2026-09-01T01:00:00.000Z')");
  await seed("INSERT INTO users(id,name,display_name,email) VALUES ('alice','Alice Kim','alice','alice@example.com'),('bob','Bob Kim','bob','bob@example.com')");
  await seed("INSERT INTO projects(id,name) VALUES ('p','Original'),('p2','New')");
  for (const state of ['unstarted', 'started', 'completed']) await seed('INSERT INTO workflow_states(id,team_id,name,type) VALUES (?,?,?,?)', [state, 't', state, state]);
  await seed("INSERT INTO issues(id,identifier,title,team_id,state_id,assignee_id,project_id,last_synced_at) VALUES ('i','PAY-123','Payments','t','completed','bob','p2','2026-09-01T00:00:00.000Z')");
}
async function event(id: string, time: string, changes: [string, unknown, unknown][]) {
  await seed('INSERT INTO events(id,entity_type,entity_id,actor_id,actor_name,action,occurred_at,received_at,source) VALUES (?,?,?,?,?,?,?,?,?)', [id, 'Issue', 'i', 'bob', 'Bob Kim', 'update', time, time, 'webhook']);
  for (const [field, before, after] of changes) await seed('INSERT INTO field_changes(id,event_id,entity_type,entity_id,field_name,old_value,new_value,actor_id,occurred_at) VALUES (?,?,?,?,?,?,?,?,?)', [`${id}:${field}`, id, 'Issue', 'i', field, JSON.stringify(before), JSON.stringify(after), 'bob', time]);
}
test('uses prior assignee and same-event before/after; actor stays independent', async () => {
  await fixture();
  await event('baseline', '2026-09-20T00:00:00.000Z', [['assignee', null, 'alice']]);
  await event('start', '2026-09-21T01:00:00.000Z', [['state', 'unstarted', 'started']]);
  await event('transfer', '2026-09-22T01:00:00.000Z', [['assignee', 'alice', 'bob'], ['state', 'started', 'completed']]);
  await event('reopen', '2026-09-23T01:00:00.000Z', [['state', 'completed', 'started']]);
  const alice = await runDb(getMemberActivity({ member: 'alice@example.com', from: '2026-09-21', to: '2026-09-27' }));
  expect(alice.started).toHaveLength(1);
  expect(alice.completed).toHaveLength(1);
  expect(alice.unassigned).toHaveLength(1);
  expect(alice.reopened).toHaveLength(0);
  expect(alice.started[0]).toMatchObject({ actor: { id: 'bob' }, affectedAssignee: { after: { id: 'alice' }, inferred: false } });
  expect(alice.completed[0].affectedAssignee).toMatchObject({ before: { id: 'alice' }, after: { id: 'bob' }, inferred: false });
  const bob = await runDb(getMemberActivity({ member: 'bob', from: '2026-09-21', to: '2026-09-27' }));
  expect(bob.started).toHaveLength(0);
  expect(bob.assigned).toHaveLength(1);
  expect(bob.completed).toHaveLength(1);
  expect(bob.reopened).toHaveLength(1);
});
test('project scope follows project history and includes transfers on both sides', async () => {
  await fixture();
  await event('baseline', '2026-09-20T00:00:00.000Z', [['project', null, 'p']]);
  await event('start', '2026-09-21T01:00:00.000Z', [['state', 'unstarted', 'started']]);
  await event('transfer', '2026-09-22T01:00:00.000Z', [['project', 'p', 'p2']]);
  await event('done', '2026-09-23T01:00:00.000Z', [['state', 'started', 'completed']]);
  const original = await runDb(getChanges({ project: 'Original', from: '2026-09-21', to: '2026-09-27' }));
  expect(original.changes.map((change) => change.eventId)).toEqual(['start', 'transfer']);
  const moved = await runDb(getChanges({ project: 'New', from: '2026-09-21', to: '2026-09-27' }));
  expect(moved.changes.map((change) => change.eventId)).toEqual(['transfer', 'done']);
  expect(original.changes[0].projectAtEvent).toMatchObject({ after: { id: 'p', name: 'Original' }, inferred: false });
});
test('issue changes are chronological and pagination excludes the next local midnight', async () => {
  await fixture();
  await event('monday', '2026-09-20T15:00:00.000Z', [['state', 'unstarted', 'started']]);
  await event('wednesday', '2026-09-23T01:00:00.000Z', [['assignee', 'alice', 'bob']]);
  await event('friday', '2026-09-25T01:00:00.000Z', [['project_milestone', 'beta', 'ga']]);
  await event('nextweek', '2026-09-27T15:00:00.000Z', [['priority', 3, 2]]);
  await seed("UPDATE issues SET deleted_at='2026-09-28T00:00:00.000Z' WHERE id='i'");
  const first = await runDb(getChanges({ issue: 'PAY-123', from: '2026-09-21', to: '2026-09-27', limit: 2 }));
  expect(first.changes.map((change) => change.eventId)).toEqual(['monday', 'wednesday']);
  expect(first.truncated).toBe(true);
  expect(first.nextCursor).not.toBeNull();
  const second = await runDb(getChanges({ issue: 'i', from: '2026-09-21', to: '2026-09-27', limit: 2, cursor: first.nextCursor! }));
  expect(second.changes.map((change) => change.eventId)).toEqual(['friday']);
  expect(second.truncated).toBe(false);
  expect(second.nextCursor).toBeNull();
  const filtered = await runDb(getChanges({ issue: 'i', from: '2026-09-21', to: '2026-09-27', fields: ['assignee'] }));
  expect(filtered.changes).toHaveLength(1);
  expect(filtered.changes[0]).toMatchObject({ before: { name: 'Alice Kim' }, after: { name: 'Bob Kim' } });
});
test('tracking coverage and strict exact-name ambiguity remain visible', async () => {
  await fixture();
  await seed("INSERT INTO users(id,name,display_name,email) VALUES ('other','Other','alice','other@example.com')");
  expect((await runDb(getMemberActivity({ member: 'alice', from: '2026-08-01', to: '2026-08-07' }))).coverage).toEqual({ complete: false, trackingStartedAt: '2026-09-01T00:00:00.000Z' });
  await seed("UPDATE users SET display_name='shared' WHERE id IN ('alice','other')");
  const ambiguous = await runDb(getMemberActivity({ member: 'shared', from: '2026-09-21', to: '2026-09-27' }).pipe(Effect.result));
  expect(ambiguous).toMatchObject({ _tag: 'Failure', failure: { code: 'AMBIGUOUS_MEMBER' } });
  const absent = await runDb(getMemberActivity({ member: 'Ali', from: '2026-09-21', to: '2026-09-27' }).pipe(Effect.result));
  expect(absent).toMatchObject({ _tag: 'Failure', failure: { code: 'MEMBER_NOT_FOUND' } });
});
test('calendar boundaries honor DST and reject impossible dates', async () => {
  const spring = await Effect.runPromise(periodFor('2026-03-08', '2026-03-08', 'America/New_York'));
  expect(spring).toMatchObject({ start: '2026-03-08T05:00:00.000Z', endExclusive: '2026-03-09T04:00:00.000Z' });
  const fall = await Effect.runPromise(periodFor('2026-11-01', '2026-11-01', 'America/New_York'));
  expect(fall).toMatchObject({ start: '2026-11-01T04:00:00.000Z', endExclusive: '2026-11-02T05:00:00.000Z' });
  for (const [from, to] of [['2026-02-30', '2026-03-01'], ['2026-09-27', '2026-09-21']]) {
    expect(await Effect.runPromise(periodFor(from, to, 'Asia/Seoul').pipe(Effect.result))).toMatchObject({ _tag: 'Failure', failure: { code: 'INVALID_DATE_RANGE' } });
  }
});
