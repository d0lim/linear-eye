import { defineConfig } from 'vitest/config';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers';

export default defineConfig(async () => ({
  plugins: [cloudflareTest({
    miniflare: {
      // The pinned test pool's workerd supports dates only through 2026-08-22.
      // Wrangler smoke checks separately exercise the deployment configuration.
      compatibilityDate: '2026-08-15',
      compatibilityFlags: ['nodejs_compat'],
      d1Databases: ['DB'],
      bindings: {
        TEST_MIGRATIONS: await readD1Migrations('migrations'),
        REPORT_TIMEZONE: 'Asia/Seoul', STALE_ISSUE_DAYS: '5', PROJECT_UPDATE_BODY_LIMIT: '8000',
        LINEAR_WEBHOOK_SECRET: 'test-signing-secret', LINEAR_API_KEY: 'test-api-key',
        ADMIN_AUTH_TOKEN: 'test-admin-token', MCP_AUTH_TOKEN: 'test-mcp-token',
      },
    },
  })],
  test: { setupFiles: ['./test/setup.ts'], include: ['test/**/*.test.ts'], fileParallelism: false },
}));
