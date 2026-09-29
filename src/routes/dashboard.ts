import { Effect } from 'effect';
import { authenticateAccess } from '../auth/access';
import type { Env } from '../env';
import { AppError, errorResult } from '../errors';
import { getChanges } from '../intelligence/changes';
import { getDashboardBootstrap } from '../intelligence/dashboard';
import { ChangesInputSchema, decodeInput, MilestoneProgressInputSchema, ProjectProgressInputSchema, TeamCurrentWorkInputSchema } from '../intelligence/inputs';
import { getMilestoneProgress, getProjectProgress, getTeamCurrentWork } from '../intelligence/progress';
import { log } from '../log';
import { dataLayer } from '../runtime';

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return Response.json(body, { status, headers: { ...headers, 'Cache-Control': 'private, no-store' } });
}

function optionalBoolean(value: string | null): boolean | string | undefined {
  if (value === null) return undefined;
  if (value === 'true') return true;
  if (value === 'false') return false;
  return value;
}

function errorStatus(error: unknown): number {
  if (!(error instanceof AppError)) return 503;
  if (error.code === 'NOT_FOUND' || error.code.endsWith('_NOT_FOUND')) return 404;
  if (error.code === 'SYNC_NOT_READY' || error.code.startsWith('AMBIGUOUS_')) return 409;
  return 400;
}

export async function handleDashboard(request: Request, env: Env): Promise<Response> {
  const identity = await authenticateAccess(request, env);
  if (identity instanceof Response) return identity;
  if (request.method !== 'GET') {
    return json({ error: { code: 'METHOD_NOT_ALLOWED', message: 'Use GET for dashboard requests', details: {} } }, 405, { Allow: 'GET' });
  }
  const url = new URL(request.url);
  const query = url.searchParams;
  const optional = (name: string) => query.get(name) || undefined;
  const program = Effect.gen(function* () {
    switch (url.pathname) {
      case '/api/bootstrap': return yield* getDashboardBootstrap(identity.email);
      case '/api/team': {
        const input = yield* decodeInput(TeamCurrentWorkInputSchema, {
          team: optional('team'), includeStale: optionalBoolean(query.get('includeStale')),
        });
        return yield* getTeamCurrentWork(input);
      }
      case '/api/project': {
        const input = yield* decodeInput(ProjectProgressInputSchema, { project: optional('project') });
        return yield* getProjectProgress(input);
      }
      case '/api/milestone': {
        const input = yield* decodeInput(MilestoneProgressInputSchema, { project: optional('project'), milestone: optional('milestone') });
        return yield* getMilestoneProgress(input);
      }
      case '/api/changes': {
        const input = yield* decodeInput(ChangesInputSchema, {
          from: optional('from'), to: optional('to'), member: optional('member'), project: optional('project'), issue: optional('issue'),
          cursor: optional('cursor'), limit: query.has('limit') ? Number(query.get('limit')) : undefined,
        });
        return yield* getChanges(input);
      }
      default: return yield* Effect.fail(new AppError({ code: 'NOT_FOUND', message: 'Not found' }));
    }
  });
  try {
    const result = await Effect.runPromise(program.pipe(Effect.provide(dataLayer(env)), Effect.result));
    if (result._tag === 'Success') return json(result.success);
    const error = result.failure;
    const status = errorStatus(error);
    log('warn', 'dashboard_failed', { code: error instanceof AppError ? error.code : error._tag });
    return json(errorResult(error), status);
  } catch {
    log('error', 'dashboard_failed', { errorType: 'Defect' });
    return json(errorResult(null), 500);
  }
}
