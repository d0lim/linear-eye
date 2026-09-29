import { env, applyD1Migrations } from 'cloudflare:test';
import { beforeAll, beforeEach } from 'vitest';

beforeAll(async () => { await applyD1Migrations(env.DB, env.TEST_MIGRATIONS); });
beforeEach(async () => {
  const tables = ['meta', 'users', 'teams', 'workflow_states', 'projects', 'project_milestones',
    'issues', 'project_updates', 'events', 'field_changes', 'entity_versions', 'sync_runs', 'sync_pages'];
  await env.DB.batch(tables.map((table) => env.DB.prepare(`DELETE FROM ${table}`)));
});
