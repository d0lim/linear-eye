import type { QueueMessage } from './queue/types';

export interface Env {
  DB: D1Database;
  LINEAR_EYE_QUEUE: Queue<QueueMessage>;
  LINEAR_API_KEY: string;
  LINEAR_WEBHOOK_SECRET: string;
  MCP_AUTH_TOKEN: string;
  ADMIN_AUTH_TOKEN: string;
  REPORT_TIMEZONE: string;
  STALE_ISSUE_DAYS: string;
  PROJECT_UPDATE_BODY_LIMIT: string;
}
