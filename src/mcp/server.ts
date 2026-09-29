import { McpServer } from '@modelcontextprotocol/server';
import { createMcpHandler } from 'agents/mcp/server';
import { Effect } from 'effect';
import type { Database } from '../db/database';
import type { Env } from '../env';
import { errorResult } from '../errors';
import { getChanges, getMemberActivity, getMilestoneProgress, getProjectProgress, getTeamCurrentWork, getWeeklyReport } from '../intelligence';
import { log } from '../log';
import { dataLayer } from '../runtime';
import type { AppConfig } from '../services';
import { changesInput, memberInput, milestoneInput, projectInput, teamInput, weeklyInput } from './schemas';

const annotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

export function createServer(env: Env) {
  const server = new McpServer({ name: 'linear-eye', version: '0.1.0' });
  const layer = dataLayer(env);
  const run = async <A extends Record<string, unknown>, E>(tool: string, program: Effect.Effect<A, E, Database | AppConfig>) => {
    const started = Date.now();
    try {
      const result = await Effect.runPromise(program.pipe(Effect.provide(layer), Effect.result));
      const output = result._tag === 'Success' ? result.success : errorResult(result.failure);
      const isError = result._tag === 'Failure';
      log(isError ? 'warn' : 'info', isError ? 'mcp_tool_failed' : 'mcp_tool_called', { tool, latencyMs: Date.now() - started });
      return { content: [{ type: 'text' as const, text: JSON.stringify(output) }], structuredContent: output, isError };
    } catch {
      log('error', 'mcp_tool_failed', { tool, latencyMs: Date.now() - started, errorType: 'Defect' });
      const output = errorResult(null);
      return { content: [{ type: 'text' as const, text: JSON.stringify(output) }], structuredContent: output, isError: true };
    }
  };
  server.registerTool('get_team_current_work', {
    description: 'Current assigned work in started workflow states, grouped by member; includes tracking coverage and optional stale activity facts.',
    inputSchema: teamInput, annotations,
  }, (input) => run('get_team_current_work', getTeamCurrentWork({ ...input, team: input.team ?? undefined })));
  server.registerTool('get_member_activity', {
    description: 'Observed member activity in an inclusive local calendar date range. Keeps the actor separate from the affected assignee and flags inferred attribution.',
    inputSchema: memberInput, annotations,
  }, (input) => run('get_member_activity', getMemberActivity(input)));
  server.registerTool('get_project_progress', {
    description: 'Current project progress by issue count and estimate, excluding canceled, archived and deleted issues from the denominator.',
    inputSchema: projectInput, annotations,
  }, (input) => run('get_project_progress', getProjectProgress(input)));
  server.registerTool('get_milestone_progress', {
    description: 'Current milestone progress and issue buckets within an exactly resolved project.',
    inputSchema: milestoneInput, annotations,
  }, (input) => run('get_milestone_progress', getMilestoneProgress(input)));
  server.registerTool('get_changes', {
    description: 'Chronological observed changes with human-readable references and coverage. Follow nextCursor for further pages.',
    inputSchema: changesInput, annotations,
  }, (input) => run('get_changes', getChanges({ ...input, member: input.member ?? undefined, project: input.project ?? undefined, issue: input.issue ?? undefined })));
  server.registerTool('get_weekly_report', {
    description: 'Deterministic weekly activity facts and a Markdown draft. Weeks start Monday in REPORT_TIMEZONE; currentlyInProgress is current, not a historical end-of-week snapshot.',
    inputSchema: weeklyInput, annotations,
  }, (input) => run('get_weekly_report', getWeeklyReport(input)));
  return server;
}

export const handleMcp = (request: Request, env: Env, ctx: ExecutionContext) =>
  createMcpHandler(() => createServer(env), { route: '/mcp', corsOptions: false })(request, env, ctx);
