import { createExecutionContext, env } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import worker from '../src';
import type { QueueMessage } from '../src/queue/types';
import type { Env } from '../src/env';

function request(path: string, token = env.ADMIN_AUTH_TOKEN, body?: unknown) {
  return new Request(`https://example.com${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
function withQueue(send = vi.fn(async (_message: QueueMessage) => {})): Env {
  return { ...env, LINEAR_EYE_QUEUE: { send } as unknown as Queue<QueueMessage> };
}

describe('admin API', () => {
  it('requires admin credential independently of MCP', async () => {
    const response = await worker.fetch(request('/admin/sync', env.MCP_AUTH_TOKEN, { mode: 'full' }), env, createExecutionContext());
    expect(response.status).toBe(401);
  });
  it('accepts a full sync as a queue job and exposes its status', async () => {
    const send = vi.fn(async (_message: QueueMessage) => {});
    const bindings = withQueue(send);
    const response = await worker.fetch(request('/admin/sync', env.ADMIN_AUTH_TOKEN, { mode: 'full' }), bindings, createExecutionContext());
    expect(response.status).toBe(202);
    const accepted = await response.json() as { runId: string; accepted: boolean };
    expect(accepted.accepted).toBe(true);
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ kind: 'sync', resource: 'users', runId: accepted.runId }));
    const status = await worker.fetch(request(`/admin/sync/${accepted.runId}`), bindings, createExecutionContext());
    expect(await status.json()).toMatchObject({ id: accepted.runId, status: 'running', pagesProcessed: 0 });
  });
  it('rejects invalid sync input and reconciliation before bootstrap', async () => {
    const bindings = withQueue();
    const bad = await worker.fetch(request('/admin/sync', env.ADMIN_AUTH_TOKEN, { mode: 'oops' }), bindings, createExecutionContext());
    expect(bad.status).toBe(400);
    const early = await worker.fetch(request('/admin/reconcile', env.ADMIN_AUTH_TOKEN, {}), bindings, createExecutionContext());
    expect(early.status).toBe(409);
  });
});
