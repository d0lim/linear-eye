import { env } from 'cloudflare:test';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { handleDashboard } from '../src/routes/dashboard';
import { seed } from './helpers';

const issuer = 'https://dashboard-test.cloudflareaccess.com';
const bindings = () => ({ ...env, ACCESS_TEAM_DOMAIN: issuer, ACCESS_AUD: 'dashboard-audience' });
let assertion: string;
let jwk: Awaited<ReturnType<typeof exportJWK>>;
beforeAll(async () => {
  const keys = await generateKeyPair('RS256', { extractable: true });
  jwk = { ...await exportJWK(keys.publicKey), kid: 'dashboard-key', alg: 'RS256', use: 'sig' };
  assertion = await new SignJWT({ email: 'reader@example.com' }).setProtectedHeader({ alg: 'RS256', kid: 'dashboard-key' })
    .setIssuer(issuer).setAudience('dashboard-audience').setSubject('reader').setIssuedAt().setExpirationTime('1h').sign(keys.privateKey);
});
beforeEach(() => {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
    expect(String(url)).toBe(`${issuer}/cdn-cgi/access/certs`);
    return Response.json({ keys: [jwk] });
  });
});
afterEach(() => { vi.restoreAllMocks(); });
async function api(path: string, method = 'GET') {
  return handleDashboard(new Request(`https://linear-eye.owner.workers.dev${path}`, {
    method, headers: { 'Cf-Access-Jwt-Assertion': assertion },
  }), bindings());
}
async function fixture() {
  await seed("INSERT INTO meta(key,value,updated_at) VALUES ('tracking_started_at','2026-09-01T00:00:00.000Z','2026-09-01T00:00:00.000Z'),('last_full_sync_completed_at','2026-09-01T01:00:00.000Z','2026-09-01T01:00:00.000Z'),('last_reconcile_completed_at','2026-09-29T00:00:00.000Z','2026-09-29T00:00:00.000Z')");
  await seed("INSERT INTO users(id,name,display_name,email) VALUES('alice','Alice Kim','Alice','alice@example.com')");
  await seed("INSERT INTO teams(id,key,name) VALUES('team','SHOP','Commerce')");
  await seed("INSERT INTO projects(id,name) VALUES('project','Storefront')");
  await seed("INSERT INTO project_milestones(id,project_id,name) VALUES('milestone','project','Checkout')");
  await seed("INSERT INTO workflow_states(id,team_id,name,type) VALUES('started','team','In progress','started'),('done','team','Done','completed')");
  await seed("INSERT INTO issues(id,identifier,title,team_id,state_id,project_id,project_milestone_id,assignee_id,last_synced_at,updated_at) VALUES('issue','SHOP-123','Improve checkout','team','started','project','milestone','alice','2026-09-01T00:00:00.000Z','2020-01-01T00:00:00.000Z')");
  await seed("INSERT INTO events(id,entity_type,entity_id,action,occurred_at,received_at,source) VALUES('event','Issue','issue','update','2026-09-21T01:00:00.000Z','2026-09-21T01:00:00.000Z','webhook')");
  await seed("INSERT INTO field_changes(id,event_id,entity_type,entity_id,field_name,old_value,new_value,occurred_at) VALUES('change','event','Issue','issue','state','\"done\"','\"started\"','2026-09-21T01:00:00.000Z')");
}

describe('authenticated read-only dashboard API', () => {
  it('authenticates every route before revealing data or route details', async () => {
    await fixture();
    for (const path of ['/api', '/api/bootstrap', '/api/team', '/api/project', '/api/milestone', '/api/changes', '/api/unknown']) {
      const response = await handleDashboard(new Request(`https://preview.owner.workers.dev${path}`), bindings());
      expect(response.status).toBe(401);
      expect(response.headers.get('Cache-Control')).toContain('no-store');
    }
  });
  it('bootstraps an empty workspace without requiring the initial sync', async () => {
    const response = await api('/api/bootstrap');
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toContain('no-store');
    expect(await response.json()).toEqual({ viewer: { email: 'reader@example.com' }, timezone: 'Asia/Seoul',
      trackingStartedAt: null, lastFullSyncCompletedAt: null, lastReconcileCompletedAt: null,
      latestSync: null, teams: [], projects: [], members: [] });
    const team = await api('/api/team');
    expect(team.status).toBe(409);
    expect(await team.json()).toMatchObject({ error: { code: 'SYNC_NOT_READY' } });
  });
  it('returns selectors and latest sync metadata while excluding deleted or archived choices', async () => {
    await fixture();
    await seed("INSERT INTO users(id,name,deleted_at) VALUES('removed','Removed','2026-09-01')");
    await seed("INSERT INTO teams(id,key,name,archived_at) VALUES('archived','OLD','Old team','2026-09-01')");
    await seed("INSERT INTO projects(id,name,archived_at) VALUES('archived','Old project','2026-09-01')");
    await seed("INSERT INTO sync_runs(id,mode,status,started_at,completed_at,pages_processed,entities_processed) VALUES('run','reconcile','completed','2026-09-29T00:00:00.000Z','2026-09-29T00:00:05.000Z',5,2)");
    const response = await api('/api/bootstrap');
    expect(await response.json()).toEqual({ viewer: { email: 'reader@example.com' }, timezone: 'Asia/Seoul',
      trackingStartedAt: '2026-09-01T00:00:00.000Z', lastFullSyncCompletedAt: '2026-09-01T01:00:00.000Z', lastReconcileCompletedAt: '2026-09-29T00:00:00.000Z',
      latestSync: { id: 'run', mode: 'reconcile', status: 'completed', startedAt: '2026-09-29T00:00:00.000Z', completedAt: '2026-09-29T00:00:05.000Z', pagesProcessed: 5, entitiesProcessed: 2, error: null },
      teams: [{ id: 'team', key: 'SHOP', name: 'Commerce' }], projects: [{ id: 'project', name: 'Storefront' }],
      members: [{ id: 'alice', name: 'Alice Kim', displayName: 'Alice', email: 'alice@example.com' }] });
  });
  it('runs team, project and milestone intelligence against D1', async () => {
    await fixture();
    const team = await api('/api/team?team=SHOP&includeStale=true');
    expect(team.status).toBe(200);
    expect(await team.json()).toMatchObject({ members: [{ user: { id: 'alice' }, issues: [{ identifier: 'SHOP-123', stale: true }] }] });
    const fresh = await api('/api/team?team=team&includeStale=false');
    expect(await fresh.json()).toMatchObject({ members: [] });
    const project = await api('/api/project?project=project');
    expect(await project.json()).toMatchObject({ project: { name: 'Storefront' }, issueCount: { total: 1, started: 1 }, progress: { byCount: 0 } });
    const milestone = await api('/api/milestone?project=project&milestone=milestone');
    expect(await milestone.json()).toMatchObject({ milestone: { name: 'Checkout' }, issues: { started: [{ identifier: 'SHOP-123' }] } });
  });
  it('queries persisted changes with validated scopes and date ranges', async () => {
    await fixture();
    const response = await api('/api/changes?from=2026-09-21&to=2026-09-27&project=project&member=alice&issue=SHOP-123&limit=1');
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ changes: [{ field: 'state', before: { name: 'Done' }, after: { name: 'In progress' }, issue: { identifier: 'SHOP-123' } }], truncated: false });
  });
  it('maps input, not-found, ambiguity, route and method errors without internal details', async () => {
    await fixture();
    for (const path of ['/api/project', '/api/milestone?project=project', '/api/team?includeStale=maybe', '/api/changes?from=2026-02-30&to=2026-03-01', '/api/changes?from=2026-09-21&to=2026-09-27&limit=nope', '/api/changes?from=2026-09-21&to=2026-09-27&cursor=oops']) {
      const response = await api(path);
      expect(response.status, path).toBe(400);
      expect(response.headers.get('Cache-Control')).toContain('no-store');
    }
    expect((await api('/api/project?project=absent')).status).toBe(404);
    await seed("INSERT INTO projects(id,name) VALUES('duplicate','Storefront')");
    expect((await api('/api/project?project=Storefront')).status).toBe(409);
    expect((await api('/api/unknown')).status).toBe(404);
    const post = await api('/api/bootstrap', 'POST');
    expect(post.status).toBe(405);
    expect(post.headers.get('Allow')).toBe('GET');
  });
});
