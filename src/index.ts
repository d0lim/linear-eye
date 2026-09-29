import { Effect } from 'effect';
import { unauthorized, verifyBearer } from './auth/bearer';
import type { Env } from './env';
import { log } from './log';
import { handleMcp } from './mcp/server';
import { consume } from './queue/consumer';
import { startSync } from './queue/sync-handler';
import { handleAdmin } from './routes/admin';
import { handleAssets } from './routes/assets';
import { handleDashboard } from './routes/dashboard';
import { health } from './routes/health';
import { handleWebhook } from './routes/webhook';
import { applicationLayer } from './runtime';

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    try {
      const path = new URL(request.url).pathname;
      if (path === '/health' && request.method === 'GET') return health();
      if (path === '/webhooks/linear' && request.method === 'POST') return handleWebhook(request, env);
      if (path === '/mcp') {
        if (!await verifyBearer(request, env.MCP_AUTH_TOKEN)) return unauthorized();
        return await handleMcp(request, env, ctx);
      }
      if (path.startsWith('/admin/')) return await handleAdmin(request, env);
      if (path === '/api' || path.startsWith('/api/')) return await handleDashboard(request, env);
      if (path === '/' || path === '/app' || path.startsWith('/app/')) return await handleAssets(request, env);
      return Response.json({ error: { code: 'NOT_FOUND', message: 'Not found', details: {} } }, { status: 404 });
    } catch {
      log('error', 'request_failed', { errorType: 'Defect' });
      return Response.json({ error: { code: 'INTERNAL_ERROR', message: 'An internal error occurred', details: {} } }, { status: 500 });
    }
  },
  queue: consume,
  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    const result = await Effect.runPromise(startSync('reconcile').pipe(Effect.provide(applicationLayer(env)), Effect.result));
    if (result._tag === 'Failure') {
      log('error', 'scheduled_reconcile_failed', { errorType: result.failure._tag });
      throw new Error('Scheduled reconciliation could not start');
    }
  },
} satisfies ExportedHandler<Env, unknown>;
