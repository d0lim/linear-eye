import { Schema } from 'effect';

const nonEmptyString = Schema.String.check(Schema.isNonEmpty());
const record = Schema.Record(Schema.String, Schema.Unknown);
const entityData = Schema.StructWithRest(Schema.Struct({ id: nonEmptyString }), [record]);
const utcTimestamp = Schema.String.check(Schema.makeFilter((value) => {
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value;
}));
const action = Schema.Literals(['create', 'update', 'remove']);
const nullableString = Schema.NullOr(Schema.String);
const actor = Schema.Struct({ id: nullableString, type: nullableString, name: nullableString });

export const WebhookQueueMessageSchema = Schema.Struct({
  kind: Schema.Literal('webhook'),
  deliveryId: nonEmptyString,
  webhookId: nullableString,
  organizationId: nonEmptyString,
  eventType: nonEmptyString,
  action,
  occurredAt: utcTimestamp,
  receivedAt: utcTimestamp,
  actor: Schema.NullOr(actor),
  entityUrl: nullableString,
  data: entityData,
  updatedFrom: Schema.NullOr(record),
});

export const SyncQueueMessageSchema = Schema.Struct({
  kind: Schema.Literal('sync'),
  runId: nonEmptyString,
  mode: Schema.Literals(['full', 'reconcile']),
  resource: Schema.Literals(['users', 'teams', 'workflow_states', 'projects', 'project_milestones', 'issues', 'project_updates']),
  cursor: nullableString,
  watermark: Schema.NullOr(utcTimestamp),
});

export const SyncRequestQueueMessageSchema = Schema.Struct({
  kind: Schema.Literal('sync-request'),
  runId: Schema.String.check(Schema.isUUID()),
  mode: Schema.Literals(['full', 'reconcile']),
});

export const QueueMessageSchema = Schema.Union([WebhookQueueMessageSchema, SyncQueueMessageSchema, SyncRequestQueueMessageSchema]);

export const LinearWebhookSchema = Schema.Struct({
  type: nonEmptyString,
  action,
  organizationId: nonEmptyString,
  webhookId: Schema.optional(nullableString),
  webhookTimestamp: Schema.Number.check(Schema.isInt()),
  createdAt: Schema.optional(Schema.String),
  url: Schema.optional(nullableString),
  actor: Schema.optional(Schema.NullOr(Schema.Struct({
    id: Schema.optional(nullableString),
    type: Schema.optional(nullableString),
    name: Schema.optional(nullableString),
  }))),
  data: entityData,
  updatedFrom: Schema.optional(Schema.NullOr(record)),
});
