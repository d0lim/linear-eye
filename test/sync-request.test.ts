import { env } from 'cloudflare:test';
import { Effect, Layer } from 'effect';
import { describe, expect, it, vi } from 'vitest';
import worker from '../src';
import { Database } from '../src/db/database';
import { getSyncStatus } from '../src/db/sync-runs';
import type { Env } from '../src/env';
import { QueueOfferError } from '../src/errors';
import { LinearClient } from '../src/linear/client';
import { processSyncPage } from '../src/queue/sync-handler';
import type { QueueMessage, SyncQueueMessage } from '../src/queue/types';
import { AppConfig, QueuePublisher } from '../src/services';
import { RECONCILE_OVERLAP_MS, startRequestedSync } from '../src/sync/full-sync';
import { seed, testLayer } from './helpers';

const runId = 'dc2c26fe-9ce3-4d21-9ec0-ae60dac70b4c';
const timestamp = '2026-09-01T00:00:00.000Z';

function harness() {
  const sent: SyncQueueMessage[] = [];
  const fetchPage = vi.fn(() => Effect.succeed({ nodes: [], hasNextPage: false, endCursor: null }));
  let sendFails = false;
  const layer = Layer.mergeAll(testLayer,
    Layer.succeed(LinearClient, { fetchPage }),
    Layer.succeed(QueuePublisher, { send: (message) => Effect.gen(function* () {
      if (sendFails) return yield* Effect.fail(new QueueOfferError());
      if (message.kind === 'sync') sent.push(message);
    }) }),
  );
  return {
    sent, fetchPage,
    failSends: (fail: boolean) => { sendFails = fail; },
    run: <A, E>(program: Effect.Effect<A, E, Database | AppConfig | LinearClient | QueuePublisher>) =>
      Effect.runPromise(program.pipe(Effect.provide(layer))),
  };
}

function delivery(body: unknown, attempts = 1) {
  const ack = vi.fn(), retry = vi.fn();
  return {
    ack, retry,
    batch: { queue: 'linear-eye-events', messages: [{
      id: 'control-message', timestamp: new Date(), body, attempts, ack, retry,
    }], ackAll: vi.fn(), retryAll: vi.fn() } as unknown as MessageBatch<unknown>,
  };
}

describe('durable sync requests', () => {
  it('creates a run with the supplied ID and queues its first page without fetching Linear', async () => {
    const h = harness();
    await h.run(startRequestedSync(runId, 'full'));
    expect(await h.run(getSyncStatus(runId))).toMatchObject({ id: runId, mode: 'full', status: 'running', pagesProcessed: 0 });
    expect(h.sent).toEqual([{ kind: 'sync', runId, mode: 'full', resource: 'users', cursor: null, watermark: null }]);
    expect(h.fetchPage).not.toHaveBeenCalled();
    expect(await env.DB.prepare("SELECT value FROM meta WHERE key='tracking_started_at'").first('value')).toBeTruthy();
  });

  it('recovers an initial enqueue failure with the same run and tracking start', async () => {
    const h = harness();
    h.failSends(true);
    expect(await h.run(startRequestedSync(runId, 'full').pipe(Effect.flip))).toBeInstanceOf(QueueOfferError);
    const initial = await h.run(getSyncStatus(runId));
    const tracking = await env.DB.prepare("SELECT value FROM meta WHERE key='tracking_started_at'").first();
    expect(initial).toMatchObject({ status: 'running', pagesProcessed: 0, error: null });
    h.failSends(false);
    await h.run(startRequestedSync(runId, 'full'));
    expect(await h.run(getSyncStatus(runId))).toEqual(initial);
    expect(await env.DB.prepare('SELECT COUNT(*) n FROM sync_runs').first('n')).toBe(1);
    expect(await env.DB.prepare("SELECT value FROM meta WHERE key='tracking_started_at'").first()).toEqual(tracking);
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0].runId).toBe(runId);
  });

  it('accepts racing duplicate requests as one run', async () => {
    const h = harness();
    await Promise.all([h.run(startRequestedSync(runId, 'full')), h.run(startRequestedSync(runId, 'full'))]);
    expect(await env.DB.prepare('SELECT COUNT(*) n FROM sync_runs').first('n')).toBe(1);
    expect(await h.run(getSyncStatus(runId))).toMatchObject({ status: 'running', pagesProcessed: 0, error: null });
    // Duplicate first-page deliveries are safe; each must refer to the same run.
    expect(h.sent.length).toBeGreaterThan(0);
    expect(h.sent.every((message) => message.runId === runId && message.resource === 'users')).toBe(true);
  });

  it.each([
    { status: 'running', pages: 1 },
    { status: 'completed', pages: 0 },
    { status: 'failed', pages: 0 },
  ])('does not restart a $status run with $pages processed pages', async ({ status, pages }) => {
    const h = harness();
    await seed('INSERT INTO sync_runs(id,mode,status,started_at,pages_processed) VALUES(?,?,?,?,?)', [runId, 'full', status, timestamp, pages]);
    const initial = await h.run(getSyncStatus(runId));
    await h.run(startRequestedSync(runId, 'full'));
    expect(await h.run(getSyncStatus(runId))).toEqual(initial);
    expect(h.sent).toHaveLength(0);
  });

  it('requires a full sync before creating a reconcile run and preserves its cutoff on retry', async () => {
    const h = harness();
    expect(await h.run(startRequestedSync(runId, 'reconcile').pipe(Effect.flip))).toMatchObject({ code: 'SYNC_NOT_READY' });
    expect(await env.DB.prepare('SELECT COUNT(*) n FROM sync_runs').first('n')).toBe(0);
    await seed("INSERT INTO meta(key,value,updated_at) VALUES('last_full_sync_completed_at',?,?),('last_full_sync_watermark',?,?)", [timestamp, timestamp, timestamp, timestamp]);
    h.failSends(true);
    expect(await h.run(startRequestedSync(runId, 'reconcile').pipe(Effect.flip))).toBeInstanceOf(QueueOfferError);
    await seed("INSERT INTO meta(key,value,updated_at) VALUES('last_reconcile_watermark',?,?)", ['2026-09-20T00:00:00.000Z', timestamp]);
    h.failSends(false);
    await h.run(startRequestedSync(runId, 'reconcile'));
    const watermark = new Date(Date.parse(timestamp) - RECONCILE_OVERLAP_MS).toISOString();
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]).toMatchObject({ runId, mode: 'reconcile', watermark });
    expect(await env.DB.prepare('SELECT watermark FROM sync_runs WHERE id=?').bind(runId).first('watermark')).toBe(watermark);
  });

  it('rejects a different mode for the same ID without poisoning the existing run', async () => {
    const h = harness();
    await h.run(startRequestedSync(runId, 'full'));
    const initial = await h.run(getSyncStatus(runId));
    expect(await h.run(startRequestedSync(runId, 'reconcile').pipe(Effect.flip))).toMatchObject({ code: 'INVALID_SYNC_MESSAGE' });
    expect(await h.run(getSyncStatus(runId))).toEqual(initial);
    expect(h.sent).toHaveLength(1);
  });
});

describe('sync request queue delivery', () => {
  it('dispatches a valid control message and acknowledges after publishing the first page', async () => {
    const send = vi.fn(async (_body: QueueMessage) => {});
    const bindings = { ...env, LINEAR_EYE_QUEUE: { send } } as unknown as Env;
    const queued = delivery({ kind: 'sync-request', runId, mode: 'full' });
    await worker.queue(queued.batch, bindings);
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ kind: 'sync', runId, mode: 'full', resource: 'users' }));
    expect(queued.ack).toHaveBeenCalledOnce();
    expect(queued.retry).not.toHaveBeenCalled();
  });

  it('leaves an unstarted run resumable after control delivery retries are exhausted', async () => {
    const bindings = { ...env, LINEAR_EYE_QUEUE: { send: async () => { throw new Error('queue unavailable'); } } } as unknown as Env;
    const queued = delivery({ kind: 'sync-request', runId, mode: 'full' }, 6);
    await worker.queue(queued.batch, bindings);
    expect(queued.retry).toHaveBeenCalled();
    expect(queued.ack).not.toHaveBeenCalled();
    expect(await env.DB.prepare('SELECT status,error FROM sync_runs WHERE id=?').bind(runId).first()).toEqual({ status: 'running', error: null });
  });

  it('keeps an already queued first page valid when a duplicate control exhausts its retries', async () => {
    const pages: SyncQueueMessage[] = [];
    const bindings = { ...env, LINEAR_EYE_QUEUE: { send: async (body: QueueMessage) => {
      if (body.kind === 'sync') pages.push(body);
    } } } as unknown as Env;
    const control = { kind: 'sync-request', runId, mode: 'full' };
    const accepted = delivery(control);
    await worker.queue(accepted.batch, bindings);
    expect(accepted.ack).toHaveBeenCalledOnce();
    expect(pages).toHaveLength(1);

    const duplicate = delivery(control, 6);
    const unavailable = { ...env, LINEAR_EYE_QUEUE: { send: async () => { throw new Error('queue unavailable'); } } } as unknown as Env;
    await worker.queue(duplicate.batch, unavailable);
    expect(duplicate.retry).toHaveBeenCalled();
    expect(duplicate.ack).not.toHaveBeenCalled();
    expect(await env.DB.prepare('SELECT status,pages_processed,error FROM sync_runs WHERE id=?').bind(runId).first()).toEqual({ status: 'running', pages_processed: 0, error: null });

    const h = harness();
    await h.run(processSyncPage(pages[0]));
    expect(h.fetchPage).toHaveBeenCalledOnce();
    expect(await h.run(getSyncStatus(runId))).toMatchObject({ status: 'running', pagesProcessed: 1, error: null });
    expect(h.sent).toEqual([{ ...pages[0], resource: 'teams' }]);
  });

  it('does not fail a run that progresses while a duplicate start is being retried', async () => {
    const bindings = { ...env, LINEAR_EYE_QUEUE: { send: async () => {
      await seed('UPDATE sync_runs SET pages_processed=1 WHERE id=?', [runId]);
      throw new Error('queue unavailable');
    } } } as unknown as Env;
    const queued = delivery({ kind: 'sync-request', runId, mode: 'full' }, 6);
    await worker.queue(queued.batch, bindings);
    expect(queued.retry).toHaveBeenCalled();
    expect(await env.DB.prepare('SELECT status,pages_processed,error FROM sync_runs WHERE id=?').bind(runId).first()).toEqual({ status: 'running', pages_processed: 1, error: null });
  });

  it('does not fail an existing run for an exhausted request with a different mode', async () => {
    await seed('INSERT INTO sync_runs(id,mode,status,started_at) VALUES(?,?,?,?)', [runId, 'full', 'running', timestamp]);
    const send = vi.fn(async () => {});
    const bindings = { ...env, LINEAR_EYE_QUEUE: { send } } as unknown as Env;
    const queued = delivery({ kind: 'sync-request', runId, mode: 'reconcile' }, 6);
    await worker.queue(queued.batch, bindings);
    expect(queued.retry).toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    expect(await env.DB.prepare('SELECT status,error FROM sync_runs WHERE id=?').bind(runId).first()).toEqual({ status: 'running', error: null });
  });

  it('rejects malformed control IDs before touching sync state', async () => {
    const send = vi.fn(async () => {});
    const bindings = { ...env, LINEAR_EYE_QUEUE: { send } } as unknown as Env;
    const queued = delivery({ kind: 'sync-request', runId: 'not-a-uuid', mode: 'full' });
    await worker.queue(queued.batch, bindings);
    expect(queued.retry).toHaveBeenCalled();
    expect(queued.ack).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    expect(await env.DB.prepare('SELECT COUNT(*) n FROM sync_runs').first('n')).toBe(0);
  });
});
