import { Effect, Layer, Schema } from 'effect';
import { isFreshWebhookTimestamp, verifyWebhook } from '../auth/webhook';
import { normalizeTimestamp } from '../db/snapshots';
import type { Env } from '../env';
import { WebhookDecodeError, WebhookTimestampError } from '../errors';
import { isEntityType, jsonUtf8Bytes, projectEntity, projectWebhookData } from '../linear/projection';
import { LinearWebhookSchema } from '../queue/schemas';
import type { WebhookQueueMessage } from '../queue/types';
import { AppConfig, QueuePublisher, configLayer, queueLayer } from '../services';
import { log } from '../log';

const accepted = () => Response.json({ ok: true });
const failure = (status: number, code: string) => {
  log('warn', 'webhook_rejected', { code });
  return Response.json({ error: { code } }, { status });
};

const acceptWebhook = (request: Request, secret: string) => Effect.gen(function* () {
  const config = yield* AppConfig;
  const queue = yield* QueuePublisher;
  const rawBody = yield* Effect.tryPromise({ try: () => request.arrayBuffer(), catch: () => new WebhookDecodeError() });
  const now = Date.now();
  yield* verifyWebhook(rawBody, request.headers, secret, now);
  const parsed = yield* Effect.try({
    try: () => JSON.parse(new TextDecoder().decode(rawBody)) as unknown,
    catch: () => new WebhookDecodeError(),
  });
  const body = yield* Schema.decodeUnknownEffect(LinearWebhookSchema)(parsed)
    .pipe(Effect.mapError(() => new WebhookDecodeError()));
  // The header is not part of the HMAC. Validate the timestamp in the signed body too.
  if (!isFreshWebhookTimestamp(body.webhookTimestamp, now)) {
    return yield* Effect.fail(new WebhookTimestampError());
  }
  const deliveryId = request.headers.get('Linear-Delivery');
  if (!deliveryId || typeof body.data.id !== 'string' || !body.data.id) {
    return yield* Effect.fail(new WebhookDecodeError());
  }
  // Unsupported subscriptions (especially comments) never enter the queue.
  if (!isEntityType(body.type)) return accepted();
  const projectedUrl = projectEntity(body.type, body.data, config.projectUpdateBodyLimit).url;
  const metadata: Omit<WebhookQueueMessage, 'data' | 'updatedFrom'> = {
    kind: 'webhook', deliveryId, webhookId: body.webhookId ?? null,
    organizationId: body.organizationId, eventType: body.type, action: body.action,
    occurredAt: normalizeTimestamp(body.createdAt, new Date(body.webhookTimestamp).toISOString()),
    receivedAt: new Date(now).toISOString(),
    actor: body.actor ? { id: body.actor.id ?? null, type: body.actor.type ?? null, name: body.actor.name ?? null } : null,
    entityUrl: body.url ?? (typeof projectedUrl === 'string' ? projectedUrl : null),
  };
  // Joining the two serialized objects replaces their touching braces with one
  // comma. Budget the projection after reserving every byte of known metadata.
  const projected = projectWebhookData(body.type, body.data, body.updatedFrom ?? null,
    config.projectUpdateBodyLimit, 96 * 1024 - jsonUtf8Bytes(metadata) + 1);
  const message: WebhookQueueMessage = { ...metadata, ...projected };
  if (jsonUtf8Bytes(message) > 96 * 1024) {
    return yield* Effect.fail(new WebhookDecodeError());
  }
  yield* queue.send(message);
  log('info', 'webhook_received', { deliveryId, entityType: body.type, action: body.action });
  return accepted();
});

/** Thin HTTP runtime boundary; the pipeline and failures remain typed Effects. */
export function handleWebhook(request: Request, env: Env): Promise<Response> {
  return Effect.runPromise(acceptWebhook(request, env.LINEAR_WEBHOOK_SECRET).pipe(
    Effect.provide(Layer.merge(configLayer(env), queueLayer(env))),
    Effect.catchTags({
      WebhookSignatureError: () => Effect.succeed(failure(401, 'INVALID_SIGNATURE')),
      WebhookTimestampError: () => Effect.succeed(failure(401, 'INVALID_TIMESTAMP')),
      WebhookDecodeError: () => Effect.succeed(failure(400, 'INVALID_WEBHOOK')),
      QueueOfferError: () => Effect.succeed(failure(503, 'QUEUE_UNAVAILABLE')),
    }),
  ));
}
