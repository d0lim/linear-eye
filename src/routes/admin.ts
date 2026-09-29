import { Effect, Schema } from 'effect';
import { unauthorized, verifyBearer } from '../auth/bearer';
import type { Env } from '../env';
import { AppError, errorResult } from '../errors';
import { log } from '../log';
import { getSyncStatus, startSync } from '../queue/sync-handler';
import { applicationLayer } from '../runtime';

const fullSyncBody = Schema.Struct({ mode: Schema.Literal('full') });
const reconcileBody = Schema.Struct({});

export async function handleAdmin(request: Request, env: Env): Promise<Response> {
  if (!await verifyBearer(request, env.ADMIN_AUTH_TOKEN)) return unauthorized();
  const path = new URL(request.url).pathname;
  const program = Effect.gen(function* () {
    if (request.method === 'GET' && /^\/admin\/sync\/[^/]+$/.test(path)) {
      const status = yield* getSyncStatus(path.slice('/admin/sync/'.length));
      return Response.json(status, { headers: { 'Cache-Control': 'no-store' } });
    }
    if (request.method !== 'POST' || (path !== '/admin/sync' && path !== '/admin/reconcile')) {
      return Response.json({ error: { code: 'NOT_FOUND', message: 'Not found', details: {} } }, { status: 404 });
    }
    const raw = yield* Effect.tryPromise({
      try: () => request.json(),
      catch: () => new AppError({ code: 'INVALID_INPUT', message: 'A JSON request body is required' }),
    });
    yield* Schema.decodeUnknownEffect(path === '/admin/sync' ? fullSyncBody : reconcileBody)(raw).pipe(
      Effect.mapError(() => new AppError({ code: 'INVALID_INPUT', message: 'Invalid admin request' })),
    );
    const { runId } = yield* startSync(path === '/admin/sync' ? 'full' : 'reconcile');
    return Response.json({ accepted: true, runId }, { status: 202 });
  });
  const result = await Effect.runPromise(program.pipe(Effect.provide(applicationLayer(env)), Effect.result));
  if (result._tag === 'Success') return result.success;
  const error = result.failure;
  log('warn', 'admin_failed', { code: error instanceof AppError ? error.code : error._tag });
  const status = error instanceof AppError
    ? error.code === 'SYNC_RUN_NOT_FOUND' ? 404 : error.code === 'SYNC_NOT_READY' ? 409 : 400 : 503;
  return Response.json(errorResult(error), { status });
}
