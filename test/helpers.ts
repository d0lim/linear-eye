import { env } from 'cloudflare:test';
import { Effect, Layer } from 'effect';
import { Database, databaseLayer } from '../src/db/database';
import { AppConfig, configLayer } from '../src/services';

export const testLayer = Layer.merge(databaseLayer(env.DB), configLayer(env));
export const runDb = <A, E>(program: Effect.Effect<A, E, Database | AppConfig>): Promise<A> =>
  Effect.runPromise(program.pipe(Effect.provide(testLayer)));
export async function seed(sql: string, params: (string | number | null)[] = []) {
  return env.DB.prepare(sql).bind(...params).run();
}
