import { Clock, Effect, Schema } from 'effect';
import { AppError, DatabaseError } from '../errors';
import { log } from '../log';
import type { SyncMode, SyncQueueMessage } from '../queue/types';
import { Database, type Statement } from './database';
import { SyncQueueMessageSchema } from '../queue/schemas';

export interface SyncRun {
  id: string;
  mode: SyncMode;
  status: 'running' | 'completed' | 'failed';
  started_at: string;
  completed_at: string | null;
  pages_processed: number;
  entities_processed: number;
  error: string | null;
  watermark: string | null;
}
export interface PageReceipt { next_message: string | null }

export const nowIso = Clock.currentTimeMillis.pipe(Effect.map((time) => new Date(time).toISOString()));

export const getRun = (runId: string) => Effect.gen(function* () {
  const db = yield* Database;
  const run = yield* db.first<SyncRun>('SELECT * FROM sync_runs WHERE id = ?', [runId]);
  if (!run) return yield* Effect.fail(new AppError({ code: 'SYNC_RUN_NOT_FOUND', message: 'Sync run not found' }));
  return run;
});

export const getSyncStatus = (runId: string) => Effect.gen(function* () {
  const run = yield* getRun(runId);
  return {
    id: run.id, mode: run.mode, status: run.status, startedAt: run.started_at,
    completedAt: run.completed_at, pagesProcessed: run.pages_processed,
    entitiesProcessed: run.entities_processed, error: run.error,
  };
});

export const markSyncFailed = (runId: string, errorCode: string) => Effect.gen(function* () {
  const db = yield* Database;
  const now = yield* nowIso;
  // Only bounded diagnostic codes are retained, never upstream error bodies.
  const code = /^[A-Z0-9_]{1,80}$/.test(errorCode) ? errorCode : 'SYNC_FAILED';
  const changed = yield* db.batch([{ sql: "UPDATE sync_runs SET status = 'failed', completed_at = ?, error = ? WHERE id = ? AND status = 'running' RETURNING id", params: [now, code, runId] }]);
  if (changed[0]?.length) log('error', 'sync.failed', { runId, errorCode: code });
});

export const pageId = (message: SyncQueueMessage): string => JSON.stringify([message.runId, message.resource, message.cursor]);

export const getPageReceipt = (id: string) => Effect.gen(function* () {
  const db = yield* Database;
  return yield* db.first<PageReceipt>('SELECT next_message FROM sync_pages WHERE id = ?', [id]);
});

export const readContinuation = (receipt: PageReceipt) => Effect.gen(function* () {
  if (receipt.next_message === null) return null;
  const parsed: unknown = yield* Effect.try({ try: () => JSON.parse(receipt.next_message!), catch: () => new DatabaseError({ operation: 'sync_continuation' }) });
  return yield* Schema.decodeUnknownEffect(SyncQueueMessageSchema)(parsed).pipe(
    Effect.mapError(() => new DatabaseError({ operation: 'sync_continuation' })),
  );
});

/** ISO timestamps sort lexically; late completion of an older run cannot rewind metadata. */
export function advanceMeta(key: string, value: string, updatedAt: string): Statement {
  return {
    sql: `INSERT INTO meta(key,value,updated_at) VALUES(?,?,?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at
      WHERE excluded.value > meta.value`,
    params: [key, value, updatedAt],
  };
}
