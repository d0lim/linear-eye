import { D1Client } from '@effect/sql-d1';
import { Context, Effect, Layer } from 'effect';
import { SqlClient } from 'effect/sql';
import { DatabaseError } from '../errors';

export type SqlValue = string | number | null;
export interface Statement { sql: string; params?: ReadonlyArray<SqlValue> }

export class Database extends Context.Service<Database, {
  readonly all: <A extends object>(sql: string, params?: ReadonlyArray<SqlValue>) => Effect.Effect<ReadonlyArray<A>, DatabaseError>;
  readonly first: <A extends object>(sql: string, params?: ReadonlyArray<SqlValue>) => Effect.Effect<A | null, DatabaseError>;
  readonly batch: (statements: ReadonlyArray<Statement>) => Effect.Effect<ReadonlyArray<ReadonlyArray<Record<string, unknown>>>, DatabaseError>;
}>()('linear-eye/Database') {}

// SQL identifiers come exclusively from internal allowlists; values are bound.
// D1's atomic batch replaces BEGIN, which the D1 driver does not support.
const repositoryLayer = Layer.effect(Database, Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const d1 = yield* D1Client.D1Client;
  const all = <A extends object>(text: string, params: ReadonlyArray<SqlValue> = []) =>
    sql.unsafe<A>(text, params).pipe(Effect.mapError(() => new DatabaseError({ operation: 'query' })));
  return Database.of({
    all,
    first: <A extends object>(text: string, params: ReadonlyArray<SqlValue> = []): Effect.Effect<A | null, DatabaseError> =>
      all<A>(text, params).pipe(Effect.map((rows): A | null => rows[0] ?? null)),
    batch: (statements) => d1.batch(statements.map((s) => sql.unsafe<Record<string, unknown>>(s.sql, s.params ?? [])))
      .pipe(Effect.mapError(() => new DatabaseError({ operation: 'batch' }))),
  });
}));

export const databaseLayer = (db: D1Database) => repositoryLayer.pipe(Layer.provide(D1Client.layer({ db })));
