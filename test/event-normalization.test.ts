import { env } from 'cloudflare:test';
import { Effect, Schema } from 'effect';
import { describe, expect, it } from 'vitest';
import { projectEntity, projectWebhookData } from '../src/linear/projection';
import { Database, type Statement } from '../src/db/database';
import { DatabaseError } from '../src/errors';
import { QueueMessageSchema } from '../src/queue/schemas';
import { canonicalJson, ingestWebhook } from '../src/queue/webhook-handler';
import type { WebhookQueueMessage } from '../src/queue/types';
import { runDb, seed } from './helpers';

const initial = '2026-09-01T00:00:00.000Z';
const later = '2026-09-02T00:00:00.000Z';

function event(overrides: Partial<WebhookQueueMessage> = {}): WebhookQueueMessage {
  return {
    kind: 'webhook', deliveryId: 'delivery-1', webhookId: 'webhook-1', organizationId: 'org-1',
    eventType: 'Issue', action: 'update', occurredAt: initial, receivedAt: later,
    actor: { id: 'user-1', type: 'user', name: 'Dory' }, entityUrl: null,
    data: { id: 'issue-1', identifier: 'ENG-1', title: 'Implement ingestion', teamId: 'team-1', stateId: 'started', updatedAt: initial },
    updatedFrom: { stateId: 'todo' }, ...overrides,
  };
}

describe('Webhook history and snapshots in D1', () => {
  it('records a normalized transition exactly once on redelivery', async () => {
    const message = event();
    await runDb(ingestWebhook(message));
    await runDb(ingestWebhook(message));
    expect(await env.DB.prepare('SELECT count(*) AS count FROM events').first('count')).toBe(1);
    const changes = await env.DB.prepare('SELECT * FROM field_changes').all();
    expect(changes.results).toHaveLength(1);
    expect(changes.results[0]).toMatchObject({ id: 'delivery-1:state', field_name: 'state', old_value: '"todo"', new_value: '"started"' });
    expect(await env.DB.prepare('SELECT state_id FROM issues WHERE id=?').bind('issue-1').first('state_id')).toBe('started');
  });

  it('handles simultaneous duplicate deliveries atomically', async () => {
    await Promise.all([runDb(ingestWebhook(event())), runDb(ingestWebhook(event()))]);
    expect(await env.DB.prepare('SELECT count(*) AS count FROM events').first('count')).toBe(1);
    expect(await env.DB.prepare('SELECT count(*) AS count FROM field_changes').first('count')).toBe(1);
    expect(await env.DB.prepare('SELECT count(*) AS count FROM issues').first('count')).toBe(1);
  });

  it('stores many unknown changes with a bounded D1 statement count', async () => {
    const previous = Object.fromEntries(Array.from({ length: 47 }, (_, index) => [`future${index}`, index]));
    const current = Object.fromEntries(Array.from({ length: 47 }, (_, index) => [`future${index}`, index + 1]));
    let queries = 0;
    let historyBatch: ReadonlyArray<Statement> = [];
    const program = Effect.gen(function* () {
      const real = yield* Database;
      const limited = Database.of({ ...real,
        first: (sql, params) => { queries += 1; return real.first(sql, params); },
        batch: (statements) => {
          queries += statements.length;
          historyBatch = statements;
          return queries > 50 ? Effect.fail(new DatabaseError({ operation: 'test-statement-budget' })) : real.batch(statements);
        },
      });
      yield* ingestWebhook(event({ data: { ...event().data, ...current }, updatedFrom: previous }))
        .pipe(Effect.provideService(Database, limited));
    });
    await runDb(program);
    expect(queries).toBeLessThanOrEqual(5);
    expect(historyBatch).toHaveLength(4);
    const changes = await env.DB.prepare('SELECT * FROM field_changes ORDER BY field_name').all();
    expect(changes.results).toHaveLength(47);
    expect(changes.results.find((row) => row.field_name === 'linear.future46')).toMatchObject({
      id: 'delivery-1:linear.future46', event_id: 'delivery-1', entity_type: 'Issue', entity_id: 'issue-1',
      old_value: '46', new_value: '47', actor_id: 'user-1', occurred_at: initial,
    });
  });

  it('uses canonical names and preserves unknown values without private nested bodies', async () => {
    const message = event({
      data: { ...event().data, assigneeId: 'new', projectId: 'p', projectMilestoneId: 'm', dueDate: null, priority: 2,
        estimate: 3, cycleId: null, parentId: null, fooBar: { z: 2, a: true, nested: { description: 'private', safe: 'yes' } } },
      updatedFrom: { assigneeId: 'old', projectId: null, projectMilestoneId: null, dueDate: '2026-09-01', priority: 1,
        estimate: null, cycleId: 'cycle-old', parentId: 'parent-old', fooBar: { z: 1, a: false, body: 'private' }, description: 'private' },
    });
    await runDb(ingestWebhook(message));
    const { results } = await env.DB.prepare('SELECT field_name,old_value,new_value FROM field_changes ORDER BY field_name').all();
    expect(results.map((row) => row.field_name)).toEqual(['assignee', 'cycle', 'due_date', 'estimate', 'linear.fooBar', 'parent', 'priority', 'project', 'project_milestone']);
    expect(results.find((row) => row.field_name === 'linear.fooBar')).toMatchObject({
      old_value: '{"a":false,"z":1}', new_value: '{"a":true,"nested":{"safe":"yes"},"z":2}',
    });
    expect(JSON.stringify(results)).not.toContain('private');
    expect(canonicalJson({ z: 1, a: { c: 2, b: null } })).toBe('{"a":{"b":null,"c":2},"z":1}');
  });

  it('rolls back field history and the receipt if snapshot persistence fails', async () => {
    await seed("CREATE TRIGGER reject_test_issue BEFORE INSERT ON issues BEGIN SELECT RAISE(ABORT, 'forced failure'); END");
    try {
      await expect(runDb(ingestWebhook(event()))).rejects.toMatchObject({ _tag: 'DatabaseError' });
      for (const table of ['events', 'field_changes', 'issues', 'entity_versions']) {
        expect(await env.DB.prepare(`SELECT count(*) AS count FROM ${table}`).first('count')).toBe(0);
      }
    } finally {
      await seed('DROP TRIGGER reject_test_issue');
    }
    await runDb(ingestWebhook(event()));
    expect(await env.DB.prepare('SELECT count(*) AS count FROM events').first('count')).toBe(1);
  });

  it('retains late event history without overwriting a newer snapshot', async () => {
    await runDb(ingestWebhook(event({ deliveryId: 'newer', occurredAt: later,
      data: { ...event().data, title: 'Newest title', stateId: 'done', updatedAt: later }, updatedFrom: { stateId: 'started' } })));
    await runDb(ingestWebhook(event()));
    expect(await env.DB.prepare('SELECT title,state_id FROM issues').first()).toEqual({ title: 'Newest title', state_id: 'done' });
    expect(await env.DB.prepare('SELECT count(*) AS count FROM events').first('count')).toBe(2);
    expect(await env.DB.prepare('SELECT count(*) AS count FROM field_changes').first('count')).toBe(2);
  });

  it('soft-deletes a row and prevents equal/older updates from resurrecting it', async () => {
    await runDb(ingestWebhook(event()));
    await runDb(ingestWebhook(event({ deliveryId: 'remove', action: 'remove', occurredAt: later, data: { id: 'issue-1' }, updatedFrom: null })));
    await runDb(ingestWebhook(event({ deliveryId: 'equal', occurredAt: later, data: { ...event().data, updatedAt: later } })));
    expect(await env.DB.prepare('SELECT deleted_at FROM issues').first('deleted_at')).toBe(later);
  });

  it('remembers a remove that arrives before its original create', async () => {
    await runDb(ingestWebhook(event({ deliveryId: 'remove', action: 'remove', occurredAt: later, data: { id: 'issue-1' }, updatedFrom: null })));
    await runDb(ingestWebhook(event({ action: 'create', updatedFrom: null })));
    expect(await env.DB.prepare('SELECT count(*) AS count FROM issues').first('count')).toBe(0);
    expect(await env.DB.prepare('SELECT deleted_at FROM entity_versions').first('deleted_at')).toBe(later);
    expect(await env.DB.prepare('SELECT count(*) AS count FROM events').first('count')).toBe(2);
  });
});

describe('shared projections and queue validation', () => {
  it('preserves truncation markers and omission counts through HTTP and consumer projections', () => {
    const fields = Array.from({ length: 3000 }, (_, index) => [`future${index}`, '\uD55C'.repeat(20)]);
    const projected = projectWebhookData('Issue', { id: 'issue-1', title: 'New title', ...Object.fromEntries(fields) },
      { title: 'Old title', ...Object.fromEntries(fields) }, 8000);
    expect(projected.updatedFrom?.$linearEyeOmittedFields).toMatchObject({ $linearEyeTruncated: 'history_byte_budget' });
    expect(Object.values(projected.updatedFrom ?? {})).toContainEqual({ $linearEyeTruncated: 'history_byte_budget' });
    const summary = projected.updatedFrom?.$linearEyeOmittedFields as { omittedFields: number };
    expect(Object.keys(projected.updatedFrom ?? {}).filter((field) => field.startsWith('future')).length + summary.omittedFields).toBe(3000);
    expect(projectWebhookData('Issue', projected.data, projected.updatedFrom, 8000)).toEqual(projected);
  });

  it('flattens GraphQL relations and project status using only snapshot fields', () => {
    expect(projectEntity('Issue', { id: 'i', title: 'Title', team: { id: 't' }, assignee: null,
      state: { id: 's', name: 'Todo' }, description: 'private', future: true }, 8000)).toEqual({
      id: 'i', title: 'Title', teamId: 't', assigneeId: null, stateId: 's',
    });
    expect(projectEntity('Project', { id: 'p', name: 'Project', status: { id: 'status', name: 'Planned', type: 'planned' },
      lead: { id: 'u' }, description: 'private' }, 8000)).toEqual({
      id: 'p', name: 'Project', statusId: 'status', statusName: 'Planned', statusType: 'planned', leadId: 'u',
    });
    expect(projectEntity('ProjectUpdate', { id: 'u', project: { id: 'p' }, body: '123456789' }, 5)).toEqual({ id: 'u', projectId: 'p', body: '12345' });
  });

  it('validates discriminated queue messages while tolerating future fields', async () => {
    const decode = Schema.decodeUnknownEffect(QueueMessageSchema);
    expect(await Effect.runPromise(decode({ ...event(), addedFutureField: 'ignored' }))).toEqual(event());
    await expect(Effect.runPromise(decode({ ...event(), action: 'delete' }))).rejects.toMatchObject({ _tag: 'SchemaError' });
    await expect(Effect.runPromise(decode({ ...event(), data: { id: 42 } }))).rejects.toMatchObject({ _tag: 'SchemaError' });
    await expect(Effect.runPromise(decode({ ...event(), occurredAt: 'not-a-timestamp' }))).rejects.toMatchObject({ _tag: 'SchemaError' });
    await expect(Effect.runPromise(decode({ kind: 'sync', runId: 'r', mode: 'full', resource: 'comments', cursor: null, watermark: null })))
      .rejects.toMatchObject({ _tag: 'SchemaError' });
  });
});
