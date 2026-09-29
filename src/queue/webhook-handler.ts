import { Effect } from 'effect';
import { Database, type Statement } from '../db/database';
import { snapshotStatements } from '../db/snapshots';
import { AppError } from '../errors';
import { isEntityType, isRecord, projectWebhookData } from '../linear/projection';
import { issueFieldNames } from '../domain/fields';
import { AppConfig } from '../services';
import { log } from '../log';
import type { WebhookQueueMessage } from './types';

export function normalizeFieldName(entityType: string, field: string): string {
  return entityType === 'Issue' && Object.hasOwn(issueFieldNames, field) ? issueFieldNames[field] : `linear.${field}`;
}

/** Stable JSON values make history comparisons independent of object key order. */
export function canonicalJson(value: unknown): string {
  function sort(input: unknown): unknown {
    if (Array.isArray(input)) return input.map(sort);
    if (isRecord(input)) {
      return Object.fromEntries(Object.entries(input).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
        .map(([key, item]) => [key, sort(item)]));
    }
    return input ?? null;
  }
  return JSON.stringify(sort(value));
}

export const ingestWebhook = (message: WebhookQueueMessage) => Effect.gen(function* () {
  const db = yield* Database;
  const config = yield* AppConfig;
  if (!isEntityType(message.eventType)) return;
  const id = message.data.id;
  if (typeof id !== 'string' || !id) {
    return yield* Effect.fail(new AppError({ code: 'INVALID_LINEAR_EVENT', message: 'Webhook entity ID is required' }));
  }
  if (yield* db.first<{ id: string }>('SELECT id FROM events WHERE id = ?', [message.deliveryId])) {
    log('info', 'duplicate_webhook', { deliveryId: message.deliveryId });
    return;
  }
  const projected = projectWebhookData(message.eventType, message.data, message.updatedFrom, config.projectUpdateBodyLimit);
  const statements: Statement[] = [];
  if (message.action === 'update' && projected.updatedFrom) {
    const changes = Object.entries(projected.updatedFrom).map(([field, oldValue]) => {
      const fieldName = normalizeFieldName(message.eventType, field);
      return { id: `${message.deliveryId}:${fieldName}`, event_id: message.deliveryId, entity_type: message.eventType,
        entity_id: id, field_name: fieldName, old_value: canonicalJson(oldValue),
        new_value: canonicalJson(projected.data[field]), actor_id: message.actor?.id ?? null, occurred_at: message.occurredAt };
    });
    if (changes.length) statements.push({
      sql: `INSERT OR IGNORE INTO field_changes
        (id,event_id,entity_type,entity_id,field_name,old_value,new_value,actor_id,occurred_at)
        SELECT json_extract(value,'$.id'),json_extract(value,'$.event_id'),json_extract(value,'$.entity_type'),
          json_extract(value,'$.entity_id'),json_extract(value,'$.field_name'),json_extract(value,'$.old_value'),
          json_extract(value,'$.new_value'),json_extract(value,'$.actor_id'),json_extract(value,'$.occurred_at')
        FROM json_each(?) WHERE NOT EXISTS (SELECT 1 FROM events WHERE id = ?)`,
      params: [JSON.stringify(changes), message.deliveryId],
    });
  }
  statements.push(...snapshotStatements(message.eventType, projected.data, {
    observedAt: message.receivedAt, occurredAt: message.occurredAt, remove: message.action === 'remove', deliveryId: message.deliveryId,
  }));
  // The receipt goes last inside the atomic D1 batch. Every preceding write
  // checks its absence, so concurrent duplicate deliveries are harmless too.
  // A failure anywhere rolls back history, snapshot, version, and receipt.
  statements.push({
    sql: `INSERT OR IGNORE INTO events
      (id,webhook_id,organization_id,entity_type,entity_id,action,actor_id,actor_type,actor_name,occurred_at,received_at,entity_url,source)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    params: [message.deliveryId, message.webhookId, message.organizationId, message.eventType, id, message.action,
      message.actor?.id ?? null, message.actor?.type ?? null, message.actor?.name ?? null,
      message.occurredAt, message.receivedAt, message.entityUrl, 'webhook'],
  });
  yield* db.batch(statements);
  log('info', 'webhook_processed', { deliveryId: message.deliveryId, entityType: message.eventType, action: message.action });
});
