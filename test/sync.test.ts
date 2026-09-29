import { env } from 'cloudflare:test';
import { Effect, Layer } from 'effect';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Database } from '../src/db/database';
import { getSyncStatus, markSyncFailed } from '../src/db/sync-runs';
import { LinearApiError, QueueOfferError } from '../src/errors';
import { LinearClient, linearClientLayer, type LinearPage, type LinearPageRequest } from '../src/linear/client';
import { reconcileResources, resources } from '../src/linear/queries';
import { processSyncPage } from '../src/queue/sync-handler';
import type { SyncQueueMessage } from '../src/queue/types';
import { AppConfig, QueuePublisher } from '../src/services';
import { RECONCILE_OVERLAP_MS, startSync } from '../src/sync/full-sync';
import { seed, testLayer } from './helpers';

const emptyPage: LinearPage = { nodes: [], hasNextPage: false, endCursor: null };
const timestamp = '2026-09-01T00:00:00.000Z';
const userNode = { id: 'user-1', name: 'Member', active: true, createdAt: timestamp, updatedAt: timestamp };

function harness(fetchPage: (request: LinearPageRequest) => Effect.Effect<LinearPage, LinearApiError> = () => Effect.succeed(emptyPage)) {
  const sent: SyncQueueMessage[] = [];
  let sendFails = false;
  const calls: LinearPageRequest[] = [];
  const layer = Layer.mergeAll(testLayer,
    Layer.succeed(LinearClient, { fetchPage: (request) => {
      calls.push(request);
      return fetchPage(request);
    } }),
    Layer.succeed(QueuePublisher, { send: (message) => Effect.gen(function* () {
      if (sendFails) return yield* Effect.fail(new QueueOfferError());
      if (message.kind === 'sync') sent.push(message);
    }) }),
  );
  return {
    sent, calls,
    failSends: (fail: boolean) => { sendFails = fail; },
    run: <A, E>(program: Effect.Effect<A, E, Database | AppConfig | LinearClient | QueuePublisher>) =>
      Effect.runPromise(program.pipe(Effect.provide(layer))),
  };
}

async function drain(h: ReturnType<typeof harness>) {
  for (let index = 0; index < h.sent.length; index++) {
    expect(index).toBeLessThan(30);
    await h.run(processSyncPage(h.sent[index]));
  }
}

afterEach(() => { vi.unstubAllGlobals(); });

describe('sync queue', () => {
  it('fetches one page per delivery, follows full dependency order, and creates no history', async () => {
    const h = harness((request) => Effect.succeed(request.resource === 'users' && request.cursor === null
      ? { nodes: [userNode], hasNextPage: true, endCursor: 'cursor-1' } : emptyPage));
    const { runId } = await h.run(startSync('full'));
    expect(h.calls).toHaveLength(0);
    expect(h.sent).toHaveLength(1);
    await h.run(processSyncPage(h.sent[0]));
    expect(h.calls).toHaveLength(1);
    expect(h.sent[1]).toMatchObject({ resource: 'users', cursor: 'cursor-1' });
    for (let index = 1; index < h.sent.length; index++) await h.run(processSyncPage(h.sent[index]));
    expect(h.calls.map((call) => call.resource)).toEqual(['users', ...resources]);
    expect(await h.run(getSyncStatus(runId))).toMatchObject({ status: 'completed', pagesProcessed: 8, entitiesProcessed: 1 });
    expect(await env.DB.prepare('SELECT name FROM users WHERE id = ?').bind('user-1').first()).toEqual({ name: 'Member' });
    expect(await env.DB.prepare('SELECT COUNT(*) AS count FROM events').first()).toEqual({ count: 0 });
    expect(await env.DB.prepare('SELECT COUNT(*) AS count FROM field_changes').first()).toEqual({ count: 0 });
  });

  it('recovers a failed continuation send without refetching or incrementing counters', async () => {
    const h = harness(() => Effect.succeed({ ...emptyPage, nodes: [userNode] }));
    const { runId } = await h.run(startSync('full'));
    const first = h.sent[0];
    h.failSends(true);
    expect(await h.run(processSyncPage(first).pipe(Effect.flip))).toBeInstanceOf(QueueOfferError);
    expect(await h.run(getSyncStatus(runId))).toMatchObject({ status: 'running', pagesProcessed: 1, entitiesProcessed: 1 });
    h.failSends(false);
    await h.run(processSyncPage(first));
    await h.run(processSyncPage(first));
    expect(h.calls).toHaveLength(1);
    expect(h.sent.slice(1).map((message) => message.resource)).toEqual(['teams', 'teams']);
    expect(await h.run(getSyncStatus(runId))).toMatchObject({ pagesProcessed: 1, entitiesProcessed: 1 });
  });

  it('atomically rejects a racing duplicate receipt and rolls back its counters', async () => {
    let fetched = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const h = harness(() => Effect.promise(async () => {
      fetched += 1;
      if (fetched === 2) release();
      await gate;
      return { ...emptyPage, nodes: [userNode] };
    }));
    const { runId } = await h.run(startSync('full'));
    await Promise.all([h.run(processSyncPage(h.sent[0])), h.run(processSyncPage(h.sent[0]))]);
    expect(fetched).toBe(2);
    expect(await h.run(getSyncStatus(runId))).toMatchObject({ pagesProcessed: 1, entitiesProcessed: 1 });
    expect(await env.DB.prepare('SELECT COUNT(*) AS count FROM sync_pages').first()).toEqual({ count: 1 });
    expect(await env.DB.prepare('SELECT COUNT(*) AS count FROM users').first()).toEqual({ count: 1 });
  });

  it('rolls back a bad page without a receipt or partial snapshots', async () => {
    const h = harness(() => Effect.succeed({ ...emptyPage, nodes: [userNode, { id: 'bad', updatedAt: timestamp }] }));
    const { runId } = await h.run(startSync('full'));
    expect(await h.run(processSyncPage(h.sent[0]).pipe(Effect.flip))).toMatchObject({ _tag: 'DatabaseError' });
    expect(await h.run(getSyncStatus(runId))).toMatchObject({ status: 'running', pagesProcessed: 0, entitiesProcessed: 0 });
    expect(await env.DB.prepare('SELECT COUNT(*) AS count FROM sync_pages').first()).toEqual({ count: 0 });
    expect(await env.DB.prepare('SELECT COUNT(*) AS count FROM users').first()).toEqual({ count: 0 });
  });

  it('retains an API failure for the queue to retry, then records terminal failure explicitly', async () => {
    const h = harness(() => Effect.fail(new LinearApiError({ status: 429, retryable: true, retryAfterSeconds: 30 })));
    const { runId } = await h.run(startSync('full'));
    expect(await h.run(processSyncPage(h.sent[0]).pipe(Effect.flip))).toMatchObject({ status: 429, retryAfterSeconds: 30 });
    expect(await h.run(getSyncStatus(runId))).toMatchObject({ status: 'running', pagesProcessed: 0 });
    await h.run(markSyncFailed(runId, 'LINEAR_API_ERROR'));
    expect(await h.run(getSyncStatus(runId))).toMatchObject({ status: 'failed', error: 'LINEAR_API_ERROR' });
    await h.run(processSyncPage(h.sent[0]));
    expect(h.calls).toHaveLength(1);
  });

  it('requires a completed full sync, preserves tracking start, and reconciles from run start with overlap', async () => {
    const h = harness();
    expect(await h.run(startSync('reconcile').pipe(Effect.flip))).toMatchObject({ code: 'SYNC_NOT_READY' });
    const { runId } = await h.run(startSync('full'));
    const tracking = await env.DB.prepare("SELECT value FROM meta WHERE key='tracking_started_at'").first();
    expect(await h.run(startSync('reconcile').pipe(Effect.flip))).toMatchObject({ code: 'SYNC_NOT_READY' });
    await seed('UPDATE sync_runs SET started_at=? WHERE id=?', [timestamp, runId]);
    await drain(h);
    const { runId: reconcileId } = await h.run(startSync('reconcile'));
    const reconcile = h.sent[h.sent.length - 1];
    expect(reconcile.watermark).toBe(new Date(Date.parse(timestamp) - RECONCILE_OVERLAP_MS).toISOString());
    const offset = h.calls.length;
    for (let index = h.sent.length - 1; index < h.sent.length; index++) await h.run(processSyncPage(h.sent[index]));
    expect(h.calls.slice(offset).map((request) => request.resource)).toEqual(reconcileResources);
    expect(await h.run(getSyncStatus(reconcileId))).toMatchObject({ status: 'completed', pagesProcessed: 5 });
    await h.run(startSync('full'));
    expect(await env.DB.prepare("SELECT value FROM meta WHERE key='tracking_started_at'").first()).toEqual(tracking);
  });

  it('never rewinds watermarks when an older run finishes after a newer one', async () => {
    const h = harness();
    const newer = await h.run(startSync('full'));
    const older = await h.run(startSync('full'));
    await seed('UPDATE sync_runs SET started_at=? WHERE id=?', ['2026-09-20T00:00:00.000Z', newer.runId]);
    await seed('UPDATE sync_runs SET started_at=? WHERE id=?', [timestamp, older.runId]);
    await h.run(processSyncPage({ ...h.sent[0], resource: 'project_updates' }));
    await h.run(processSyncPage({ ...h.sent[1], resource: 'project_updates' }));
    expect(await env.DB.prepare("SELECT value FROM meta WHERE key='last_full_sync_watermark'").first()).toEqual({ value: '2026-09-20T00:00:00.000Z' });
    await h.run(markSyncFailed(newer.runId, 'LINEAR_API_ERROR'));
    expect(await h.run(getSyncStatus(newer.runId))).toMatchObject({ status: 'completed', error: null });
  });

  it('uses archived API snapshots to repair current state without fake events', async () => {
    const h = harness(() => Effect.succeed({ ...emptyPage, nodes: [{ id: 'issue-1', identifier: 'ENG-1', title: 'Archived issue', team: { id: 'team-1' }, state: { id: 'state-1' }, archivedAt: '2026-09-02T00:00:00.000Z', updatedAt: '2026-09-02T00:00:00.000Z' }] }));
    await h.run(startSync('full'));
    await h.run(processSyncPage({ ...h.sent[0], resource: 'issues' }));
    expect(await env.DB.prepare('SELECT archived_at,team_id,state_id FROM issues').first()).toEqual({ archived_at: '2026-09-02T00:00:00.000Z', team_id: 'team-1', state_id: 'state-1' });
    expect(await env.DB.prepare('SELECT COUNT(*) AS count FROM events').first()).toEqual({ count: 0 });
  });

  it('marks an initial enqueue failure visible in sync status', async () => {
    const h = harness();
    h.failSends(true);
    expect(await h.run(startSync('full').pipe(Effect.flip))).toBeInstanceOf(QueueOfferError);
    expect(await env.DB.prepare('SELECT status,error FROM sync_runs').first()).toEqual({ status: 'failed', error: 'QUEUE_OFFER_FAILED' });
  });
});

describe('Linear GraphQL boundary', () => {
  function runClient(resource: LinearPageRequest['resource'] = 'users', cursor: string | null = null) {
    return Effect.gen(function* () {
      const client = yield* LinearClient;
      return yield* client.fetchPage({ resource, cursor, watermark: timestamp });
    }).pipe(Effect.provide(linearClientLayer('test-api-key')));
  }

  it.each(['headers', 'body'])('aborts a stalled %s phase within the page deadline', async (phase) => {
    vi.useFakeTimers();
    const cancel = new AbortController();
    let upstreamSignal: AbortSignal | undefined;
    let outcome: unknown;
    vi.stubGlobal('fetch', vi.fn((_url: string, options: RequestInit) => {
      upstreamSignal = options.signal as AbortSignal;
      return phase === 'headers' ? new Promise<Response>(() => {})
        : Promise.resolve({ ok: true, json: () => new Promise<unknown>(() => {}) } as Response);
    }));
    const pending = Effect.runPromise(runClient().pipe(Effect.flip), { signal: cancel.signal })
      .then((result) => { outcome = result; }, () => {});
    try {
      await vi.advanceTimersByTimeAsync(20_001);
      expect(outcome).toMatchObject({ _tag: 'LinearApiError', status: 408, retryable: true });
      expect(upstreamSignal?.aborted).toBe(true);
    } finally {
      cancel.abort();
      await pending;
      vi.useRealTimers();
    }
  });

  it('uses API key auth, server filtering, archived pages, and disabled users', async () => {
    const mock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: { users: { nodes: [{ ...userNode, displayName: null, email: null, avatarUrl: null }], pageInfo: { hasNextPage: false, endCursor: null } } } })));
    vi.stubGlobal('fetch', mock);
    expect(await Effect.runPromise(runClient())).toMatchObject({ nodes: [userNode] });
    const [, request] = mock.mock.calls[0];
    expect(request.headers.Authorization).toBe('test-api-key');
    const body = JSON.parse(request.body);
    expect(body.query).toContain('includeArchived: true');
    expect(body.query).toContain('includeDisabled: true');
    expect(body.query).toContain('first: 50');
    expect(body.variables.filter).toEqual({ updatedAt: { gte: timestamp } });
  });

  it.each([429, 503, 401])('classifies HTTP %s without leaking response bodies', async (status) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('secret upstream body', { status, headers: { 'retry-after': '12' } })));
    expect(await Effect.runPromise(runClient().pipe(Effect.flip))).toMatchObject({ _tag: 'LinearApiError', status, retryable: status !== 401, retryAfterSeconds: 12 });
  });

  it('classifies rate limits returned as GraphQL errors with HTTP 200', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ errors: [{ message: 'private error', extensions: { code: 'RATELIMITED' } }] }))));
    expect(await Effect.runPromise(runClient().pipe(Effect.flip))).toMatchObject({ status: 429, retryable: true });
  });

  it.each([
    { nodes: [{ id: 'missing-fields' }], pageInfo: { hasNextPage: false, endCursor: null } },
    { nodes: [], pageInfo: { hasNextPage: true, endCursor: null } },
    { nodes: [], pageInfo: { hasNextPage: true, endCursor: 'same-cursor' } },
  ])('rejects incomplete records or unusable pagination before applying a page', async (users) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: { users } }))));
    expect(await Effect.runPromise(runClient('users', 'same-cursor').pipe(Effect.flip))).toMatchObject({ status: 502, retryable: false });
  });
});
