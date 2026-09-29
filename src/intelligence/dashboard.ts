import { Effect } from 'effect';
import { Database } from '../db/database';
import type { SyncRun } from '../db/sync-runs';
import { AppConfig } from '../services';
import { type Member, memberRef } from './common';

/** Selectors and sync state remain available while an initial sync is still running. */
export const getDashboardBootstrap = (email: string) => Effect.gen(function* () {
  const db = yield* Database;
  const config = yield* AppConfig;
  const metadata = yield* db.all<{ key: string; value: string }>(
    "SELECT key,value FROM meta WHERE key IN ('tracking_started_at','last_full_sync_completed_at','last_reconcile_completed_at')");
  const values = new Map(metadata.map((item) => [item.key, item.value]));
  const run = yield* db.first<SyncRun>('SELECT * FROM sync_runs ORDER BY started_at DESC,id DESC LIMIT 1');
  const teams = yield* db.all<{ id: string; name: string; key: string }>(
    'SELECT id,name,key FROM teams WHERE deleted_at IS NULL AND archived_at IS NULL ORDER BY name,id');
  const projects = yield* db.all<{ id: string; name: string }>(
    'SELECT id,name FROM projects WHERE deleted_at IS NULL AND archived_at IS NULL ORDER BY name,id');
  const members = yield* db.all<Member>(
    'SELECT id,name,display_name,email FROM users WHERE deleted_at IS NULL AND active=1 ORDER BY name,id');
  return {
    viewer: { email }, timezone: config.timezone,
    trackingStartedAt: values.get('tracking_started_at') ?? null,
    lastFullSyncCompletedAt: values.get('last_full_sync_completed_at') ?? null,
    lastReconcileCompletedAt: values.get('last_reconcile_completed_at') ?? null,
    latestSync: run ? {
      id: run.id, mode: run.mode, status: run.status, startedAt: run.started_at,
      completedAt: run.completed_at, pagesProcessed: run.pages_processed,
      entitiesProcessed: run.entities_processed, error: run.error,
    } : null,
    teams, projects, members: members.map(memberRef),
  };
});
