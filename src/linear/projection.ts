import { snapshotDefinitions } from '../db/snapshots';
import type { EntityType } from '../queue/types';

const relations = ['team', 'assignee', 'creator', 'state', 'project', 'projectMilestone', 'cycle', 'parent', 'lead', 'user'];

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function scalar(value: unknown): value is string | number | boolean | null {
  return value === null || typeof value === 'string' || typeof value === 'boolean'
    || (typeof value === 'number' && Number.isFinite(value));
}

export function isEntityType(type: string): type is EntityType {
  return Object.hasOwn(snapshotDefinitions, type);
}

/** Shared, pure GraphQL/webhook projection. Unknown data never reaches snapshots. */
export function projectEntity(type: EntityType, data: Record<string, unknown>, bodyLimit: number): Record<string, unknown> {
  const fields = snapshotDefinitions[type].fields;
  const projected: Record<string, unknown> = {};
  for (const field of Object.keys(fields)) {
    if (Object.hasOwn(data, field) && scalar(data[field])) projected[field] = data[field];
  }
  for (const relation of relations) {
    const field = `${relation}Id`;
    if (!Object.hasOwn(fields, field) || Object.hasOwn(projected, field) || !Object.hasOwn(data, relation)) continue;
    const value = data[relation];
    if (value === null) projected[field] = null;
    else if (isRecord(value) && typeof value.id === 'string') projected[field] = value.id;
  }
  if (type === 'Project' && Object.hasOwn(data, 'status')) {
    const status = data.status;
    for (const [source, target] of [['id', 'statusId'], ['name', 'statusName'], ['type', 'statusType']]) {
      if (Object.hasOwn(projected, target)) continue;
      if (status === null) projected[target] = null;
      else if (isRecord(status) && typeof status[source] === 'string') projected[target] = status[source];
    }
  }
  if (type === 'ProjectUpdate' && typeof projected.body === 'string') {
    projected.body = projected.body.slice(0, Math.max(0, Math.min(8000, bodyLimit)));
  }
  return projected;
}

// Apply to keys at every depth, including unknown future Linear fields.
export function isPrivateField(field: string): boolean {
  const key = field.replace(/[^a-z]/gi, '').toLowerCase();
  return /description|comment|attachment|document|reaction|body|rawpayload|rawwebhook|webhookpayload/.test(key)
    || key === 'raw' || key === 'payload' || key === 'proto' || key === 'prototype' || key === 'constructor';
}

function compactValue(value: unknown, depth = 0): unknown {
  if (scalar(value)) return typeof value === 'string' && value.length > 8000
    ? { $linearEyeTruncated: 'string_limit', originalUtf8Bytes: new TextEncoder().encode(value).byteLength } : value;
  if (depth >= 6) return { $linearEyeTruncated: 'depth_limit' };
  if (Array.isArray(value)) return value.length > 50
    ? { $linearEyeTruncated: 'item_limit', originalItems: value.length }
    : value.map((item) => compactValue(item, depth + 1));
  if (!isRecord(value)) return { $linearEyeTruncated: 'unsupported_value' };
  const entries = Object.entries(value).filter(([key]) => !isPrivateField(key));
  return entries.length > 50 ? { $linearEyeTruncated: 'field_limit', originalSafeFields: entries.length }
    : Object.fromEntries(entries.map(([key, item]) => [key, compactValue(item, depth + 1)]));
}

export const jsonUtf8Bytes = (value: unknown): number => new TextEncoder().encode(JSON.stringify(value)).byteLength;

/** Keep safe before/after values for fields that do not yet have snapshot columns. */
export function projectWebhookData(type: EntityType, data: Record<string, unknown>,
  updatedFrom: Record<string, unknown> | null, bodyLimit: number, maxProjectionBytes = 96 * 1024) {
  const projected = projectEntity(type, data, bodyLimit);
  if (!updatedFrom) return { data: projected, updatedFrom: null };
  const previous: Record<string, unknown> = {};
  const projectedPrevious = projectEntity(type, updatedFrom, bodyLimit);
  const unknown: { field: string; oldValue: unknown; hasNew: boolean; newValue: unknown }[] = [];
  for (const [field, oldValue] of Object.entries(updatedFrom)) {
    if (isPrivateField(field)) continue;
    const relationField = relations.includes(field) && Object.hasOwn(snapshotDefinitions[type].fields, `${field}Id`)
      ? `${field}Id` : field;
    if (!Object.hasOwn(snapshotDefinitions[type].fields, relationField)) {
      unknown.push({ field: relationField, oldValue: compactValue(oldValue), hasNew: Object.hasOwn(data, field),
        newValue: Object.hasOwn(data, field) ? compactValue(data[field]) : undefined });
      continue;
    }
    if (Object.hasOwn(projectedPrevious, relationField)) previous[relationField] = projectedPrevious[relationField];
    else previous[relationField] = compactValue(oldValue);
    if (!Object.hasOwn(projected, relationField) && Object.hasOwn(data, field)) {
      projected[relationField] = compactValue(data[field]);
    }
  }
  if (!unknown.length) return { data: projected, updatedFrom: previous };

  const truncated = { $linearEyeTruncated: 'history_byte_budget' };
  // Reserve space for an honest omission count if even field names cannot fit.
  // A queued projection already contains this summary. Reuse its reservation
  // and count so projecting again cannot replace it with a new, smaller count.
  const priorSummaryIndex = unknown.findIndex(({ field, oldValue, newValue }) =>
    /^\$linearEyeOmittedFields_*$/.test(field) && isRecord(oldValue) && isRecord(newValue)
    && oldValue.$linearEyeTruncated === 'history_byte_budget' && newValue.$linearEyeTruncated === 'history_byte_budget'
    && typeof oldValue.omittedFields === 'number' && Number.isSafeInteger(oldValue.omittedFields)
    && oldValue.omittedFields > 0 && newValue.omittedFields === oldValue.omittedFields);
  const priorSummary = priorSummaryIndex < 0 ? null : unknown.splice(priorSummaryIndex, 1)[0];
  let summaryField = priorSummary?.field ?? '$linearEyeOmittedFields';
  if (!priorSummary) {
    while (Object.hasOwn(updatedFrom, summaryField) || Object.hasOwn(data, summaryField)) summaryField += '_';
  }
  let omittedFields = priorSummary ? (priorSummary.oldValue as { omittedFields: number }).omittedFields : 0;
  const summary = { ...truncated, omittedFields: unknown.length + omittedFields };
  const entryBytes = (field: string, value: unknown) => jsonUtf8Bytes(field) + jsonUtf8Bytes(value) + 2;
  let remaining = Math.min(64 * 1024,
    maxProjectionBytes - jsonUtf8Bytes({ data: projected, updatedFrom: previous })) - 2 * entryBytes(summaryField, summary);
  const retained: typeof unknown = [];
  // Allocate names and the smallest honest values first, so one large extension
  // cannot consume the space needed to identify other changed fields.
  for (const entry of unknown) {
    const oldValue = jsonUtf8Bytes(entry.oldValue) <= jsonUtf8Bytes(truncated) ? entry.oldValue : truncated;
    const newValue = !entry.hasNew || jsonUtf8Bytes(entry.newValue) <= jsonUtf8Bytes(truncated) ? entry.newValue : truncated;
    const bytes = entryBytes(entry.field, oldValue) + (entry.hasNew ? entryBytes(entry.field, newValue) : 0);
    if (bytes > remaining) { omittedFields += 1; continue; }
    previous[entry.field] = oldValue;
    if (entry.hasNew) projected[entry.field] = newValue;
    remaining -= bytes;
    retained.push(entry);
  }
  const restoreValue = (target: Record<string, unknown>, field: string, value: unknown) => {
    const extraBytes = jsonUtf8Bytes(value) - jsonUtf8Bytes(target[field]);
    if (extraBytes <= remaining) { target[field] = value; remaining -= extraBytes; }
  };
  for (const entry of retained) {
    restoreValue(previous, entry.field, entry.oldValue);
    if (entry.hasNew) restoreValue(projected, entry.field, entry.newValue);
  }
  if (omittedFields) {
    previous[summaryField] = { ...truncated, omittedFields };
    projected[summaryField] = { ...truncated, omittedFields };
  }
  return { data: projected, updatedFrom: previous };
}
