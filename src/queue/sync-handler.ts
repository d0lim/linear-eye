import { Effect } from 'effect';
import { Database, type Statement } from '../db/database';
import { snapshotPageStatements } from '../db/snapshots';
import { advanceMeta, getPageReceipt, getRun, nowIso, pageId, readContinuation } from '../db/sync-runs';
import { AppError } from '../errors';
import { LinearClient } from '../linear/client';
import { projectEntity } from '../linear/projection';
import { reconcileResources, resourceDefinitions, resources } from '../linear/queries';
import { log } from '../log';
import { AppConfig, QueuePublisher } from '../services';
import type { SyncQueueMessage } from './types';

export { getSyncStatus, markSyncFailed } from '../db/sync-runs';
export { startSync } from '../sync/full-sync';

export const processSyncPage = (message: SyncQueueMessage) => Effect.gen(function* () {
  const db = yield* Database;
  const queue = yield* QueuePublisher;
  const config = yield* AppConfig;
  const run = yield* getRun(message.runId);
  if (run.status !== 'running') return;
  const sequence = message.mode === 'full' ? resources : reconcileResources;
  if (run.mode !== message.mode || run.watermark !== message.watermark || !sequence.includes(message.resource)) {
    return yield* Effect.fail(new AppError({ code: 'INVALID_SYNC_MESSAGE', message: 'Sync message does not match its run' }));
  }
  const id = pageId(message);
  const receipt = yield* getPageReceipt(id);
  if (receipt) {
    const continuation = yield* readContinuation(receipt);
    if (continuation) yield* queue.send(continuation);
    return;
  }
  const client = yield* LinearClient;
  const page = yield* client.fetchPage({ resource: message.resource, cursor: message.cursor, watermark: message.watermark });
  if (page.hasNextPage && (!page.endCursor || page.endCursor === message.cursor)) {
    return yield* Effect.fail(new AppError({ code: 'INVALID_SYNC_PAGE', message: 'Linear returned an invalid pagination cursor' }));
  }
  const observedAt = yield* nowIso;
  const nextResource = sequence[sequence.indexOf(message.resource) + 1];
  const continuation: SyncQueueMessage | null = page.hasNextPage
    ? { ...message, cursor: page.endCursor }
    : nextResource ? { ...message, resource: nextResource, cursor: null } : null;
  const entityType = resourceDefinitions[message.resource].entityType;
  const statements: Statement[] = snapshotPageStatements(entityType,
    page.nodes.map((node) => projectEntity(entityType, node, config.projectUpdateBodyLimit)), { observedAt });
  // The receipt's unique key deliberately fails the whole atomic batch if two
  // deliveries race. D1 rolls back snapshots and counters together on conflict.
  statements.push({
    sql: 'INSERT INTO sync_pages(id,run_id,next_message,processed_at) VALUES(?,?,?,?)',
    params: [id, run.id, continuation ? JSON.stringify(continuation) : null, observedAt],
  }, {
    sql: 'UPDATE sync_runs SET pages_processed = pages_processed + 1, entities_processed = entities_processed + ? WHERE id = ?',
    params: [page.nodes.length, run.id],
  });
  if (!continuation) {
    statements.push({ sql: "UPDATE sync_runs SET status = 'completed', completed_at = ? WHERE id = ? AND status = 'running'", params: [observedAt, run.id] },
      advanceMeta(run.mode === 'full' ? 'last_full_sync_completed_at' : 'last_reconcile_completed_at', observedAt, observedAt),
      // Advancing to run start ensures updates made during pagination are seen
      // again by the next reconcile, regardless of total run duration.
      advanceMeta(run.mode === 'full' ? 'last_full_sync_watermark' : 'last_reconcile_watermark', run.started_at, observedAt));
  }
  const next = yield* db.batch(statements).pipe(
    Effect.map(() => continuation),
    Effect.catchTag('DatabaseError', (error) => Effect.gen(function* () {
      const racedReceipt = yield* getPageReceipt(id);
      if (!racedReceipt) return yield* Effect.fail(error);
      return yield* readContinuation(racedReceipt);
    })),
  );
  if (next) yield* queue.send(next);
  else log('info', 'sync.completed', { runId: run.id, mode: run.mode });
});
