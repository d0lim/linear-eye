import { Effect, Schema } from 'effect';
import type { Env } from '../env';
import { LinearApiError } from '../errors';
import { log } from '../log';
import { applicationLayer, dataLayer, syncLayer } from '../runtime';
import { startRequestedSync } from '../sync/full-sync';
import { QueueMessageSchema } from './schemas';
import { markSyncFailed, processSyncPage } from './sync-handler';
import { ingestWebhook } from './webhook-handler';

export async function consume(batch: MessageBatch<unknown>, env: Env): Promise<void> {
  for (const message of batch.messages) {
    const decoded = await Effect.runPromise(Schema.decodeUnknownEffect(QueueMessageSchema)(message.body).pipe(Effect.result));
    if (decoded._tag === 'Failure') {
      log('warn', 'queue_message_rejected', { messageId: message.id, attempts: message.attempts });
      message.retry({ delaySeconds: 60 });
      continue;
    }
    const body = decoded.success;
    const program = body.kind === 'webhook'
      ? ingestWebhook(body).pipe(Effect.asVoid, Effect.provide(dataLayer(env)))
      : body.kind === 'sync-request'
        ? startRequestedSync(body.runId, body.mode).pipe(Effect.asVoid, Effect.provide(applicationLayer(env)))
        : processSyncPage(body).pipe(Effect.provide(syncLayer(env)));
    const result = await Effect.runPromise(program.pipe(Effect.result));
    if (result._tag === 'Success') {
      message.ack();
      continue;
    }
    const failure = result.failure;
    log('error', 'queue_processing_failed', { kind: body.kind, errorType: failure._tag, attempts: message.attempts });
    if (body.kind === 'sync' && message.attempts >= 6) {
      await Effect.runPromise(markSyncFailed(body.runId, failure instanceof LinearApiError ? 'LINEAR_API_FAILED' : 'PROCESSING_FAILED')
        .pipe(Effect.provide(dataLayer(env))));
    }
    // A request send may have succeeded despite a failed acknowledgement. Leave
    // its run recoverable; only page processing can establish terminal failure.
    // Cloudflare owns durable retries; Effect schedules never keep a Worker alive.
    const delay = failure instanceof LinearApiError && failure.retryAfterSeconds !== undefined
      ? failure.retryAfterSeconds : Math.min(3600, 10 * 2 ** Math.min(message.attempts, 8));
    message.retry({ delaySeconds: Math.min(43200, Math.max(1, delay)) });
  }
}
