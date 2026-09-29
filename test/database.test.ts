import { env } from 'cloudflare:test';
import { Effect } from 'effect';
import { describe, expect, it } from 'vitest';
import { Database } from '../src/db/database';
import { snapshotPageStatements, snapshotStatements } from '../src/db/snapshots';
import { runDb } from './helpers';

describe('Effect SQL D1 repository', () => {
  it('atomically bulk upserts fifty rows in two statements without regressing a newer webhook', async () => {
    await runDb(Effect.gen(function* () {
      const db = yield* Database;
      yield* db.batch(snapshotStatements('User', { id: 'u0', name: 'Newest', updatedAt: '2026-09-29T00:00:00Z' }, { observedAt: '2026-09-29T00:00:00.000Z' }));
      const statements = snapshotPageStatements('User', Array.from({ length: 50 }, (_, i) => ({ id: `u${i}`, name: `User ${i}`, updatedAt: '2026-09-28T00:00:00Z' })), { observedAt: '2026-09-29T00:00:00.000Z' });
      expect(statements).toHaveLength(2);
      yield* db.batch(statements);
    }));
    expect(await env.DB.prepare('SELECT COUNT(*) n FROM users').first('n')).toBe(50);
    expect(await env.DB.prepare("SELECT name FROM users WHERE id='u0'").first('name')).toBe('Newest');
  });
  it('rolls an entire D1 batch back on a constraint error', async () => {
    const result = await runDb(Effect.gen(function* () {
      const db = yield* Database;
      return yield* db.batch([
        { sql: 'INSERT INTO users(id,name) VALUES(?,?)', params: ['alice', 'Alice'] },
        { sql: 'INSERT INTO users(id,name) VALUES(?,?)', params: ['broken', null] },
      ]).pipe(Effect.result);
    }));
    expect(result._tag).toBe('Failure');
    expect(await env.DB.prepare('SELECT COUNT(*) n FROM users').first('n')).toBe(0);
  });

  it('preserves latest snapshot and tombstone when older records arrive', async () => {
    await runDb(Effect.gen(function* () {
      const db = yield* Database;
      yield* db.batch(snapshotStatements('User', { id: 'alice', name: 'New', updatedAt: '2026-09-28T00:00:00Z' }, { observedAt: '2026-09-29T00:00:00.000Z' }));
      yield* db.batch(snapshotStatements('User', { id: 'alice', name: 'Old', updatedAt: '2026-09-27T00:00:00Z' }, { observedAt: '2026-09-29T00:00:00.000Z' }));
    }));
    expect(await env.DB.prepare('SELECT name FROM users WHERE id=?').bind('alice').first('name')).toBe('New');
    await runDb(Effect.gen(function* () {
      const db = yield* Database;
      yield* db.batch(snapshotStatements('User', { id: 'bob' }, { observedAt: '2026-09-29T00:00:00.000Z', remove: true }));
      yield* db.batch(snapshotStatements('User', { id: 'bob', name: 'Bob', updatedAt: '2026-09-28T00:00:00Z' }, { observedAt: '2026-09-29T00:00:00.000Z' }));
    }));
    expect(await env.DB.prepare('SELECT id FROM users WHERE id=?').bind('bob').first()).toBeNull();
  });
});
