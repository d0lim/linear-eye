import { env } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/env';
import type { QueueMessage, WebhookQueueMessage } from '../src/queue/types';
import { handleWebhook } from '../src/routes/webhook';

function payload(overrides: Record<string, unknown> = {}) {
  return {
    type: 'Issue', action: 'update', organizationId: 'org-1', webhookTimestamp: Date.now(),
    createdAt: new Date().toISOString(), data: { id: 'issue-1', title: 'New title', stateId: 'started' },
    updatedFrom: { stateId: 'todo' }, ...overrides,
  };
}

async function signedRequest(body: unknown, headers: Record<string, string> = {}) {
  const raw = typeof body === 'string' ? body : JSON.stringify(body);
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(env.LINEAR_WEBHOOK_SECRET),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(raw));
  const hex = [...new Uint8Array(signature)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return new Request('https://example.test/webhooks/linear', {
    method: 'POST', body: raw,
    headers: { 'Linear-Signature': hex, 'Linear-Timestamp': String(Date.now()), 'Linear-Delivery': 'delivery-1', ...headers },
  });
}

function context() {
  const send = vi.fn(async (_message: QueueMessage) => {});
  const bindings: Env = { ...env, LINEAR_EYE_QUEUE: { send } as unknown as Queue<QueueMessage> };
  return { send, bindings };
}

describe('Linear webhook HTTP boundary', () => {
  it('authenticates exact raw bytes, tolerates additional fields, and enqueues compact data', async () => {
    const { send, bindings } = context();
    const body = payload({ extraFutureField: true });
    const request = await signedRequest(JSON.stringify(body, null, 2));
    expect((await handleWebhook(request, bindings)).status).toBe(200);
    expect(send).toHaveBeenCalledOnce();
    const message = send.mock.calls[0][0] as WebhookQueueMessage;
    expect(message).toMatchObject({ deliveryId: 'delivery-1', kind: 'webhook', eventType: 'Issue' });
    expect(message).not.toHaveProperty('extraFutureField');
    expect(message.updatedFrom).toEqual({ stateId: 'todo' });
  });

  it.each(['', 'f'.repeat(64), 'z'.repeat(64), '0'.repeat(63), `${'0'.repeat(64)}00`])(
    'rejects missing, invalid, or non-hex signatures (%s)', async (signature) => {
      const { send, bindings } = context();
      expect((await handleWebhook(await signedRequest(payload(), { 'Linear-Signature': signature }), bindings)).status).toBe(401);
      expect(send).not.toHaveBeenCalled();
    },
  );

  it('verifies the signature before attempting to decode JSON', async () => {
    const { bindings } = context();
    const request = await signedRequest('{invalid JSON', { 'Linear-Signature': 'f'.repeat(64) });
    expect((await handleWebhook(request, bindings)).status).toBe(401);
    expect((await handleWebhook(await signedRequest('{invalid JSON'), bindings)).status).toBe(400);
  });

  it.each(['0', -61_000, 61_000, '', 'not-a-time']) (
    'rejects stale, future, missing, or malformed header timestamps (%s)', async (value) => {
      const { send, bindings } = context();
      const now = Date.now();
      const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
      try {
        const timestamp = typeof value === 'number' ? String(now + value) : value;
        const response = await handleWebhook(await signedRequest(payload(), { 'Linear-Timestamp': timestamp }), bindings);
        expect(response.status).toBe(401);
        expect(send).not.toHaveBeenCalled();
      } finally { clock.mockRestore(); }
    },
  );

  it('rejects replay with a fresh unsigned header and an expired signed timestamp', async () => {
    const { send, bindings } = context();
    const response = await handleWebhook(await signedRequest(payload({ webhookTimestamp: Date.now() - 61_000 })), bindings);
    expect(response.status).toBe(401);
    expect(send).not.toHaveBeenCalled();
  });

  it('rejects a body changed after signing', async () => {
    const { send, bindings } = context();
    const original = await signedRequest(payload());
    const tampered = new Request(original.url, { method: 'POST', headers: original.headers, body: JSON.stringify(payload({ organizationId: 'other' })) });
    expect((await handleWebhook(tampered, bindings)).status).toBe(401);
    expect(send).not.toHaveBeenCalled();
  });

  it('rejects structurally invalid signed payloads and absent delivery identifiers', async () => {
    const { bindings } = context();
    expect((await handleWebhook(await signedRequest(payload({ action: 'delete' })), bindings)).status).toBe(400);
    expect((await handleWebhook(await signedRequest(payload(), { 'Linear-Delivery': '' }), bindings)).status).toBe(400);
  });

  it('keeps safe unknown before/after fields while removing sensitive data at every depth', async () => {
    const { send, bindings } = context();
    const response = await handleWebhook(await signedRequest(payload({
      data: { id: 'issue-1', title: 'Safe', description: 'private-description',
        fooBar: { value: 2, nested: { body: 'private-body', comment: 'private-comment', safe: true } }, unused: 'discard' },
      updatedFrom: { description: 'private-old-description', fooBar: { value: 1, document: 'private-document' } },
      rawPayload: 'private-raw',
    })), bindings);
    expect(response.status).toBe(200);
    const message = send.mock.calls[0][0] as WebhookQueueMessage;
    expect(message.data).toEqual({ id: 'issue-1', title: 'Safe', fooBar: { value: 2, nested: { safe: true } } });
    expect(message.updatedFrom).toEqual({ fooBar: { value: 1 } });
    expect(JSON.stringify(message)).not.toContain('private-');
  });

  it('accepts large unknown history while preserving known changes and the queue byte budget', async () => {
    const { send, bindings } = context();
    const response = await handleWebhook(await signedRequest(payload({
      data: { id: 'issue-1', title: 'New title', stateId: 'started',
        futureExtension: Array.from({ length: 7 }, () => '\uD55C'.repeat(8000)), safeFuture: { value: 2, body: 'private-new' } },
      updatedFrom: { title: 'Old title', stateId: 'todo',
        futureExtension: Array.from({ length: 7 }, () => '\uAE00'.repeat(8000)), safeFuture: { value: 1, description: 'private-old' } },
    })), bindings);
    expect(response.status).toBe(200);
    const message = send.mock.calls[0][0] as WebhookQueueMessage;
    expect(message.data).toMatchObject({ title: 'New title', stateId: 'started', safeFuture: { value: 2 } });
    expect(message.updatedFrom).toMatchObject({ title: 'Old title', stateId: 'todo', safeFuture: { value: 1 } });
    expect(message.data.futureExtension).toEqual({ $linearEyeTruncated: 'history_byte_budget' });
    expect(message.updatedFrom?.futureExtension).toEqual({ $linearEyeTruncated: 'history_byte_budget' });
    expect(new TextEncoder().encode(JSON.stringify(message)).byteLength).toBeLessThanOrEqual(96 * 1024);
    expect(JSON.stringify(message)).not.toContain('private-');
  });

  it('reports omitted unknown field counts when their names cannot fit the queue budget', async () => {
    const { send, bindings } = context();
    const longField = 'future'.repeat(20_000);
    const response = await handleWebhook(await signedRequest(payload({
      data: { id: 'issue-1', title: 'New title', stateId: 'started', [longField]: 2 },
      updatedFrom: { stateId: 'todo', [longField]: 1 },
    })), bindings);
    expect(response.status).toBe(200);
    const message = send.mock.calls[0][0] as WebhookQueueMessage;
    expect(message.updatedFrom?.stateId).toBe('todo');
    expect(message.updatedFrom?.$linearEyeOmittedFields).toEqual({ $linearEyeTruncated: 'history_byte_budget', omittedFields: 1 });
    expect(new TextEncoder().encode(JSON.stringify(message)).byteLength).toBeLessThanOrEqual(96 * 1024);
  });

  it('reserves the existing known fields and metadata before budgeting unknown history', async () => {
    const { send, bindings } = context();
    const title = 't'.repeat(80 * 1024);
    const actorName = 'a'.repeat(5000);
    const extension = Array.from({ length: 7 }, () => 'x'.repeat(8000));
    const response = await handleWebhook(await signedRequest(payload({
      actor: { id: 'actor-1', name: actorName, type: 'user' },
      data: { id: 'issue-1', title, stateId: 'started', futureExtension: extension },
      updatedFrom: { title: 'Old title', stateId: 'todo', futureExtension: extension },
    })), bindings);
    expect(response.status).toBe(200);
    const message = send.mock.calls[0][0] as WebhookQueueMessage;
    expect(message.data).toMatchObject({ title, stateId: 'started' });
    expect(message.updatedFrom).toMatchObject({ title: 'Old title', stateId: 'todo' });
    expect(message.actor?.name).toBe(actorName);
    expect(message.data.futureExtension).toEqual({ $linearEyeTruncated: 'history_byte_budget' });
    expect(new TextEncoder().encode(JSON.stringify(message)).byteLength).toBeLessThanOrEqual(96 * 1024);
  });

  it('caps project update bodies and ignores comment subscriptions', async () => {
    const { send, bindings } = context();
    bindings.PROJECT_UPDATE_BODY_LIMIT = '12';
    expect((await handleWebhook(await signedRequest(payload({
      type: 'ProjectUpdate', data: { id: 'update-1', projectId: 'project-1', body: 'a'.repeat(50) }, updatedFrom: null,
    })), bindings)).status).toBe(200);
    expect((send.mock.calls[0][0] as WebhookQueueMessage).data.body).toBe('a'.repeat(12));
    expect((await handleWebhook(await signedRequest(payload({ type: 'Comment', data: { id: 'comment-1', body: 'private' } })), bindings)).status).toBe(200);
    expect(send).toHaveBeenCalledOnce();
  });

  it('returns retryable failure when the queue does not accept the message', async () => {
    const { send, bindings } = context();
    send.mockRejectedValueOnce(new Error('queue down'));
    expect((await handleWebhook(await signedRequest(payload()), bindings)).status).toBe(503);
  });
});
