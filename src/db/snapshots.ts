import type { EntityType } from '../queue/types';
import type { SqlValue, Statement } from './database';

const common = { id: 'id', createdAt: 'created_at', updatedAt: 'updated_at' };
export const snapshotDefinitions = {
  User: { table: 'users', required: ['id', 'name'], fields: { ...common, name: 'name', displayName: 'display_name', email: 'email', avatarUrl: 'avatar_url', active: 'active' } },
  Team: { table: 'teams', required: ['id', 'key', 'name'], fields: { ...common, key: 'key', name: 'name', archivedAt: 'archived_at' } },
  WorkflowState: { table: 'workflow_states', required: ['id', 'teamId', 'name', 'type'], fields: { ...common, teamId: 'team_id', name: 'name', type: 'type' } },
  Project: { table: 'projects', required: ['id', 'name'], fields: { ...common, name: 'name', url: 'url', statusId: 'status_id', statusName: 'status_name', statusType: 'status_type', leadId: 'lead_id', startDate: 'start_date', targetDate: 'target_date', completedAt: 'completed_at', canceledAt: 'canceled_at', archivedAt: 'archived_at' } },
  ProjectMilestone: { table: 'project_milestones', required: ['id', 'projectId', 'name'], fields: { ...common, projectId: 'project_id', name: 'name', targetDate: 'target_date' } },
  Issue: { table: 'issues', required: ['id', 'identifier', 'title', 'teamId', 'stateId'], fields: { ...common, identifier: 'identifier', title: 'title', teamId: 'team_id', assigneeId: 'assignee_id', creatorId: 'creator_id', stateId: 'state_id', projectId: 'project_id', projectMilestoneId: 'project_milestone_id', cycleId: 'cycle_id', priority: 'priority', estimate: 'estimate', dueDate: 'due_date', parentId: 'parent_id', url: 'url', startedAt: 'started_at', completedAt: 'completed_at', canceledAt: 'canceled_at', archivedAt: 'archived_at' } },
  ProjectUpdate: { table: 'project_updates', required: ['id', 'projectId'], fields: { ...common, projectId: 'project_id', userId: 'user_id', health: 'health', body: 'body', url: 'url', archivedAt: 'archived_at' } },
} as const;

function value(input: unknown): SqlValue {
  if (typeof input === 'boolean') return input ? 1 : 0;
  if (typeof input === 'number') return Number.isFinite(input) ? input : null;
  return typeof input === 'string' ? input : null;
}

export function normalizeTimestamp(input: unknown, fallback: string): string {
  if (typeof input !== 'string' && typeof input !== 'number') return fallback;
  const date = new Date(input);
  return Number.isNaN(date.getTime()) ? fallback : date.toISOString();
}

/** Fixed atomic batch; guards remove-before-create and out-of-order deliveries. */
export function snapshotStatements(type: EntityType, data: Record<string, unknown>, options: {
  observedAt: string; occurredAt?: string; remove?: boolean; deliveryId?: string;
}): Statement[] {
  const def = snapshotDefinitions[type];
  const id = typeof data.id === 'string' ? data.id : '';
  if (!id) return [];
  const version = options.remove ? (options.occurredAt ?? options.observedAt)
    : normalizeTimestamp(data.updatedAt, options.occurredAt ?? options.observedAt);
  const deleted = options.remove ? (options.occurredAt ?? version) : null;
  const guard = `NOT EXISTS (SELECT 1 FROM entity_versions WHERE entity_type = ? AND entity_id = ? AND (version_at > ? OR (version_at = ? AND deleted_at IS NOT NULL)))${options.deliveryId ? ' AND NOT EXISTS (SELECT 1 FROM events WHERE id = ?)' : ''}`;
  const guardParams: SqlValue[] = [type, id, version, version];
  if (options.deliveryId) guardParams.push(options.deliveryId);
  const statements: Statement[] = [];
  if (options.remove) {
    statements.push({ sql: `UPDATE ${def.table} SET deleted_at = ? WHERE id = ? AND ${guard}`, params: [deleted, id, ...guardParams] });
  } else {
    const entries = Object.entries(def.fields).filter(([key]) => Object.hasOwn(data, key));
    const columns: string[] = entries.map(([, col]) => col);
    const values = entries.map(([key]) => key.endsWith('At') && data[key] != null ? normalizeTimestamp(data[key], version) : value(data[key]));
    columns.push('deleted_at'); values.push(null);
    if (type === 'Issue') { columns.push('last_synced_at'); values.push(options.observedAt); }
    const complete = def.required.every((key) => typeof data[key] === 'string');
    if (complete) {
      statements.push({
        sql: `INSERT INTO ${def.table} (${columns.join(',')}) SELECT ${columns.map(() => '?').join(',')} WHERE ${guard}
          ON CONFLICT(id) DO UPDATE SET ${columns.filter((c) => c !== 'id').map((c) => `${c}=excluded.${c}`).join(',')}`,
        params: [...values, ...guardParams],
      });
    } else {
      const mutable = columns.map((col, index) => ({ col, v: values[index] })).filter((x) => x.col !== 'id');
      statements.push({ sql: `UPDATE ${def.table} SET ${mutable.map((x) => `${x.col}=?`).join(',')} WHERE id=? AND ${guard}`,
        params: [...mutable.map((x) => x.v), id, ...guardParams] });
    }
  }
  statements.push({
    sql: `INSERT INTO entity_versions(entity_type,entity_id,version_at,deleted_at)
      ${options.deliveryId ? 'SELECT ?,?,?,? WHERE NOT EXISTS (SELECT 1 FROM events WHERE id = ?)' : 'VALUES(?,?,?,?)'}
      ON CONFLICT(entity_type,entity_id) DO UPDATE SET version_at=excluded.version_at,deleted_at=excluded.deleted_at
      WHERE excluded.version_at > entity_versions.version_at OR (excluded.version_at = entity_versions.version_at AND excluded.deleted_at IS NOT NULL)`,
    params: [type, id, version, deleted, ...(options.deliveryId ? [options.deliveryId] : [])],
  });
  return statements;
}

/** Sync rows are complete projections. Two statements handle an entire page,
 * using one JSON payload each to bound statement and bind-parameter counts. */
export function snapshotPageStatements(type: EntityType, rows: ReadonlyArray<Record<string, unknown>>, options: {
  observedAt: string;
}): Statement[] {
  if (!rows.length) return [];
  const def = snapshotDefinitions[type];
  const entries = Object.entries(def.fields);
  const columns: string[] = [...entries.map(([, col]) => col), 'deleted_at'];
  if (type === 'Issue') columns.push('last_synced_at');
  const records = rows.map((data) => {
    const version = normalizeTimestamp(data.updatedAt, options.observedAt);
    const record: Record<string, SqlValue> = { __version: version, deleted_at: null };
    for (const [key, column] of entries) {
      record[column] = key.endsWith('At') && data[key] != null ? normalizeTimestamp(data[key], version) : value(data[key]);
    }
    if (type === 'User' && record.active === null) record.active = 1;
    if (type === 'Issue') record.last_synced_at = options.observedAt;
    return record;
  });
  const json = JSON.stringify(records);
  const incomingId = "json_extract(incoming.value,'$.id')";
  const incomingVersion = "json_extract(incoming.value,'$.__version')";
  return [
    {
      sql: `INSERT INTO ${def.table} (${columns.join(',')})
        SELECT ${columns.map((col) => `json_extract(incoming.value,'$.${col}')`).join(',')}
        FROM json_each(?) incoming
        WHERE NOT EXISTS (SELECT 1 FROM entity_versions v WHERE v.entity_type=? AND v.entity_id=${incomingId}
          AND (v.version_at > ${incomingVersion} OR (v.version_at = ${incomingVersion} AND v.deleted_at IS NOT NULL)))
        ON CONFLICT(id) DO UPDATE SET ${columns.filter((col) => col !== 'id').map((col) => `${col}=excluded.${col}`).join(',')}`,
      params: [json, type],
    },
    {
      sql: `INSERT INTO entity_versions(entity_type,entity_id,version_at,deleted_at)
        SELECT ?,${incomingId},${incomingVersion},NULL FROM json_each(?) incoming WHERE true
        ON CONFLICT(entity_type,entity_id) DO UPDATE SET version_at=excluded.version_at,deleted_at=NULL
        WHERE excluded.version_at > entity_versions.version_at`,
      params: [type, json],
    },
  ];
}
