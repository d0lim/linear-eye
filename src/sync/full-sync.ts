import { Effect } from 'effect';
import { Database, type Statement } from '../db/database';
import { markSyncFailed, nowIso } from '../db/sync-runs';
import { AppError } from '../errors';
import { log } from '../log';
import type { SyncMode, SyncQueueMessage } from '../queue/types';
import { QueuePublisher } from '../services';

export const RECONCILE_OVERLAP_MS = 5 * 60 * 1000;

export const startSync = (mode: SyncMode) => Effect.gen(function* () {
  const db = yield* Database;
  const queue = yield* QueuePublisher;
  const startedAt = yield* nowIso;
  let watermark: string | null = null;
  if (mode === 'reconcile') {
    const ready = yield* db.first<{ value: string }>("SELECT value FROM meta WHERE key = 'last_full_sync_completed_at'");
    if (!ready) return yield* Effect.fail(new AppError({ code: 'SYNC_NOT_READY', message: 'A full sync must complete before reconciliation' }));
    const previous = yield* db.first<{ value: string | null }>(
      "SELECT MAX(value) AS value FROM meta WHERE key IN ('last_full_sync_watermark','last_reconcile_watermark')",
    );
    // If watermark metadata is absent, scan all pages rather than invent a cutoff.
    if (previous?.value && Number.isFinite(Date.parse(previous.value))) {
      watermark = new Date(Date.parse(previous.value) - RECONCILE_OVERLAP_MS).toISOString();
    }
  }
  const runId = yield* Effect.sync(() => crypto.randomUUID());
  const statements: Statement[] = [{
    sql: "INSERT INTO sync_runs(id,mode,status,started_at,watermark) VALUES(?,?,'running',?,?)",
    params: [runId, mode, startedAt, watermark],
  }];
  if (mode === 'full') statements.push({
    sql: "INSERT INTO meta(key,value,updated_at) VALUES('tracking_started_at',?,?) ON CONFLICT(key) DO NOTHING",
    params: [startedAt, startedAt],
  });
  yield* db.batch(statements);
  const message: SyncQueueMessage = { kind: 'sync', runId, mode, resource: 'users', cursor: null, watermark };
  yield* queue.send(message).pipe(Effect.tapError(() => markSyncFailed(runId, 'QUEUE_OFFER_FAILED')));
  log('info', 'sync.started', { runId, mode });
  return { runId };
});
