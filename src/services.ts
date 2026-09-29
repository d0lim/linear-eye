import { Context, Effect, Layer } from 'effect';
import type { Env } from './env';
import { QueueOfferError } from './errors';
import type { QueueMessage } from './queue/types';

export class AppConfig extends Context.Service<AppConfig, {
  readonly timezone: string;
  readonly staleIssueDays: number;
  readonly projectUpdateBodyLimit: number;
}>()('linear-eye/AppConfig') {}

export class QueuePublisher extends Context.Service<QueuePublisher, {
  readonly send: (message: QueueMessage) => Effect.Effect<void, QueueOfferError>;
}>()('linear-eye/QueuePublisher') {}

export const configLayer = (env: Env) => Layer.succeed(AppConfig, {
  timezone: env.REPORT_TIMEZONE || 'Asia/Seoul',
  staleIssueDays: Math.max(1, Number(env.STALE_ISSUE_DAYS) || 5),
  projectUpdateBodyLimit: Math.min(8000, Math.max(1, Number(env.PROJECT_UPDATE_BODY_LIMIT) || 8000)),
});

export const queueLayer = (env: Env) => Layer.succeed(QueuePublisher, {
  send: (message) => Effect.tryPromise({
    try: () => env.LINEAR_EYE_QUEUE.send(message),
    catch: () => new QueueOfferError(),
  }),
});
