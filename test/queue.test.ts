import { createExecutionContext, env } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import worker from '../src';
import type { Env } from '../src/env';
import type { QueueMessage } from '../src/queue/types';
import { seed } from './helpers';

function delivery(body: unknown, attempts = 1) {
  const ack = vi.fn(), retry = vi.fn();
  const message = { id: 'queue-message', timestamp: new Date(), body, attempts, ack, retry };
  return { ack, retry, batch: { queue: 'linear-eye-events', messages: [message], ackAll: vi.fn(), retryAll: vi.fn() } as unknown as MessageBatch<unknown> };
}

describe('Worker queue and scheduling', () => {
  it('flows a signed HTTP webhook through queue consumption into D1', async () => {
    const messages: QueueMessage[] = [];
    const bindings = { ...env, LINEAR_EYE_QUEUE: { send: async (body: QueueMessage) => { messages.push(body); } } } as unknown as Env;
    const timestamp = Date.now();
    const raw = JSON.stringify({ action: 'create', type: 'Issue', organizationId: 'org',
      webhookTimestamp: timestamp, createdAt: new Date(timestamp).toISOString(),
      data: { id: 'i', identifier: 'PAY-10', title: 'A task', teamId: 't', stateId: 'started', assigneeId: 'alice',
        updatedAt: new Date(timestamp).toISOString(), description: 'must not persist' } });
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(env.LINEAR_WEBHOOK_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const signed = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(raw)));
    const signature = [...signed].map((byte) => byte.toString(16).padStart(2, '0')).join('');
    const response = await worker.fetch(new Request('https://example.com/webhooks/linear', {
      method: 'POST', body: raw, headers: { 'Linear-Signature': signature, 'Linear-Delivery': 'd1', 'Linear-Timestamp': String(timestamp) },
    }), bindings, createExecutionContext());
    expect(response.status).toBe(200);
    expect(messages).toHaveLength(1);
    expect(JSON.stringify(messages)).not.toContain('must not persist');
    expect(await env.DB.prepare('SELECT COUNT(*) n FROM issues').first('n')).toBe(0);
    const queued = delivery(messages[0]);
    await worker.queue(queued.batch, bindings);
    expect(queued.ack).toHaveBeenCalledOnce();
    expect(queued.retry).not.toHaveBeenCalled();
    expect(await env.DB.prepare('SELECT identifier FROM issues WHERE id=?').bind('i').first('identifier')).toBe('PAY-10');
    expect(await env.DB.prepare('SELECT COUNT(*) n FROM events').first('n')).toBe(1);
  });

  it('retries malformed queue messages without writing them', async () => {
    const queued = delivery({ kind: 'webhook', description: 'bad' });
    await worker.queue(queued.batch, env);
    expect(queued.retry).toHaveBeenCalled();
    expect(queued.ack).not.toHaveBeenCalled();
  });

  it('honors API retry delay and records terminal sync failure', async () => {
    await seed("INSERT INTO sync_runs(id,mode,status,started_at) VALUES('r','full','running','2026-09-01T00:00:00.000Z')");
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 429, headers: { 'Retry-After': '90' } }));
    const bindings = { ...env, LINEAR_EYE_QUEUE: { send: vi.fn() } } as unknown as Env;
    const queued = delivery({ kind: 'sync', runId: 'r', mode: 'full', resource: 'users', cursor: null, watermark: null }, 6);
    try {
      await worker.queue(queued.batch, bindings);
      expect(queued.retry).toHaveBeenCalledWith({ delaySeconds: 90 });
      expect(queued.ack).not.toHaveBeenCalled();
      expect(await env.DB.prepare("SELECT status FROM sync_runs WHERE id='r'").first('status')).toBe('failed');
    } finally { fetchMock.mockRestore(); }
  });

  it('starts daily reconciliation through Queue without fetching Linear', async () => {
    await seed("INSERT INTO meta(key,value,updated_at) VALUES('last_full_sync_completed_at','2026-09-01T00:00:00.000Z','2026-09-01T00:00:00.000Z')");
    const send = vi.fn(async () => {});
    const bindings = { ...env, LINEAR_EYE_QUEUE: { send } } as unknown as Env;
    await worker.scheduled({} as ScheduledController, bindings);
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ kind: 'sync', mode: 'reconcile' }));
  });
});
