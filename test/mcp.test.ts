import { createExecutionContext, env } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import worker from '../src';
import { seed } from './helpers';

async function rpc(method: string, params: Record<string, unknown> = {}) {
  const response = await worker.fetch(new Request('https://example.com/mcp', {
    method: 'POST', headers: {
      Authorization: `Bearer ${env.MCP_AUTH_TOKEN}`, 'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': '2025-03-26',
    }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  }), env, createExecutionContext());
  const text = await response.text();
  expect(response.status, text).toBe(200);
  const json = text.startsWith('event:') || text.startsWith('data:')
    ? text.split('\n').find((line) => line.startsWith('data:'))!.slice(5) : text;
  return JSON.parse(json);
}

describe('stateless authenticated MCP', () => {
  it('rejects anonymous clients and the separate admin credential', async () => {
    for (const token of ['', env.ADMIN_AUTH_TOKEN]) {
      const response = await worker.fetch(new Request('https://example.com/mcp', {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      }), env, createExecutionContext());
      expect(response.status).toBe(401);
    }
  });

  it('initializes and exposes exactly the six read-only tools', async () => {
    const init = await rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
    expect(init.result.serverInfo.name).toBe('linear-eye');
    const listed = await rpc('tools/list');
    expect(listed.result.tools.map((tool: { name: string }) => tool.name).sort()).toEqual([
      'get_changes', 'get_member_activity', 'get_milestone_progress', 'get_project_progress', 'get_team_current_work', 'get_weekly_report',
    ]);
    expect(listed.result.tools.every((tool: { annotations: { readOnlyHint: boolean } }) => tool.annotations.readOnlyHint)).toBe(true);
  });

  it('returns a safe SYNC_NOT_READY tool error', async () => {
    const response = await rpc('tools/call', { name: 'get_team_current_work', arguments: {} });
    expect(response.result.isError).toBe(true);
    expect(response.result.structuredContent.error.code).toBe('SYNC_NOT_READY');
  });

  it('runs all six tools against D1 without requesting Linear', async () => {
    await seed("INSERT INTO meta(key,value,updated_at) VALUES('tracking_started_at','2026-09-01T00:00:00.000Z','2026-09-01T00:00:00.000Z'),('last_full_sync_completed_at','2026-09-01T00:00:00.000Z','2026-09-01T00:00:00.000Z')");
    await seed("INSERT INTO users(id,name,email) VALUES('alice','Alice','alice@example.com')");
    await seed("INSERT INTO projects(id,name) VALUES('p','Storefront')");
    await seed("INSERT INTO project_milestones(id,project_id,name) VALUES('m','p','Checkout')");
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const calls = [
      ['get_team_current_work', {}],
      ['get_member_activity', { member: 'alice', from: '2026-09-21', to: '2026-09-27' }],
      ['get_project_progress', { project: 'p' }],
      ['get_milestone_progress', { project: 'p', milestone: 'm' }],
      ['get_changes', { from: '2026-09-21', to: '2026-09-27' }],
      ['get_weekly_report', { member: 'alice', weekStart: '2026-09-21' }],
    ] as const;
    try {
      for (const [name, args] of calls) {
        const response = await rpc('tools/call', { name, arguments: args });
        expect(response.result.isError, JSON.stringify(response)).toBe(false);
        expect(response.result.structuredContent.coverage.complete).toBe(true);
      }
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally { fetchSpy.mockRestore(); }
  });
});
