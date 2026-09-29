# linear-eye

A read-only MCP server for Linear. It stores current snapshots and observed changes in Cloudflare D1, then answers questions about current work, project and milestone progress, member activity, and weekly reports.

Linear remains the source of truth. The server does not modify Linear data or call an LLM.

## Architecture

```text
Linear Webhook ─ HMAC + timestamp ─ Queue ─┐
                                         ├─ Effect services ─ Effect SQL / D1
Linear GraphQL ─ full sync / daily Cron ──┘                         │
                                                                  ▼
MCP client ─ Bearer ─ createMcpHandler ─ Effect intelligence ────── D1
```

One Cloudflare Worker provides `fetch`, `queue`, and `scheduled` handlers. Cloudflare owns durable retries and scheduling; Effect manages application logic within each invocation.

- **Effect 4.0.0-rc.118** and **`@effect/sql-d1` 4.0.0-rc.118**, pinned together. Services use `Context.Service`, `Layer`, Effect Schema, and typed errors.
- Parameterized SQL through the Effect D1 driver, without an ORM. Writes use D1's atomic `batch` rather than `BEGIN` transactions.
- Stateless MCP transport through `agents/createMcpHandler` and MCP SDK v2. Zod describes the transport schemas; Effect Schema validates application inputs.
- Database, configuration, Queue, and Linear client dependencies are injected through Layers. Analytics services do not access the Linear client or Worker bindings.
- No individual scores, rankings, or productivity assessments.

See the [MVP specification](docs/mvp-spec.md), [Effect architecture decisions](docs/effect-direction.md), and [verification record](docs/verification.md).

## Prerequisites

- Node.js 22 or newer and pnpm 10 for development and builds. The deployed application runs on Workers.
- A Cloudflare account with Workers, D1, and Queues access.
- A **read-only** API key for one Linear workspace and permission to create webhooks.
- A Streamable HTTP MCP client that supports a custom Bearer authorization header.

## Local development

```sh
git clone https://github.com/d0lim/linear-eye.git
cd linear-eye
pnpm install --frozen-lockfile
cp .dev.vars.example .dev.vars
# Replace the four placeholder values in .dev.vars with development credentials.
pnpm db:migrate:local
pnpm dev
```

`.dev.vars` is excluded from Git. Linear requires a publicly reachable HTTPS URL for webhook delivery, so localhost alone cannot receive real deliveries. The local Queue consumer stops when the development server exits.

```sh
curl http://localhost:8787/health
pnpm check
pnpm test
pnpm build
```

Tests run in the Workers runtime with real local D1. They cover migrations, atomic rollback, duplicate and out-of-order webhooks, sync pagination and recovery, analytics, and MCP HTTP requests. Tests require no Linear or Cloudflare account. `pnpm build` performs a Wrangler deployment **dry run**; it does not deploy.

## Create D1 and Queues

```sh
pnpm exec wrangler login
pnpm exec wrangler d1 create linear-eye
pnpm exec wrangler queues create linear-eye-events
pnpm exec wrangler queues create linear-eye-dead-letter
```

Set `database_id` in `wrangler.jsonc` to the ID returned by D1 creation in your Cloudflare account before running a remote migration or deployment. Keep the binding names `DB` and `LINEAR_EYE_QUEUE`.

```sh
pnpm db:migrate:remote
```

This applies `migrations/0001_initial.sql` to the new database. Use new migrations for later schema changes; do not edit a migration already applied in production.

## Configure secrets and deploy

Create a read-only API key in Linear Settings → API. Generate separate, long random tokens for MCP and admin access; for example, run `openssl rand -hex 32` once for each token.

```sh
pnpm exec wrangler secret put LINEAR_API_KEY
pnpm exec wrangler secret put LINEAR_WEBHOOK_SECRET
pnpm exec wrangler secret put MCP_AUTH_TOKEN
pnpm exec wrangler secret put ADMIN_AUTH_TOKEN
pnpm run deploy
```

Copy the webhook signing secret from the webhook details in Linear. For a new installation without a webhook yet, deploy the Worker first, create the webhook using the next section, and then register its signing secret. Requests return 401 until the secret is configured. If a test delivery failed during setup, check that the webhook is active after registering the secret.

Keep production secrets out of `wrangler.jsonc`, source files, and commits. Non-secret settings are:

| Variable | Default | Purpose |
|---|---|---|
| `REPORT_TIMEZONE` | `Asia/Seoul` | IANA timezone for date ranges and weekly reports |
| `STALE_ISSUE_DAYS` | `5` | Days without an observed change before an in-progress issue is considered stale |
| `PROJECT_UPDATE_BODY_LIMIT` | `8000` | Maximum stored ProjectUpdate body length in characters, capped at 8000 |

Reports use English headings. Set `REPORT_TIMEZONE` to the timezone your team uses; report language does not change date boundaries.

## Configure the Linear webhook

In Linear Settings → API → Webhooks, register:

```text
https://<worker>/webhooks/linear
```

Subscribe to **Issue, Project, ProjectUpdate, and User** events. Select the workspace and team scope accessible to the API key. Do not subscribe to comments.

The endpoint validates HMAC-SHA256 over the raw request bytes using `Linear-Signature`. It requires `Linear-Delivery` and the millisecond `Linear-Timestamp` header, and checks that both the header timestamp and the signed body's `webhookTimestamp` are within 60 seconds. The HTTP handler projects the payload, enqueues it, and returns 200 without accessing D1.

Safe values from unknown changed fields are retained in history. Queue messages are limited to 96 KiB in UTF-8, with at most 64 KiB for unknown-field history. Oversized values receive an explicit `$linearEyeTruncated` marker. If field names cannot fit, the projection records the number omitted. Large extensions therefore do not discard known state or title changes. Excluded content, including descriptions and comments, is removed at every nesting level.

## Initial sync and status

Enable the webhook before starting bootstrap so changes made during bootstrap can also be observed.

```sh
export WORKER_URL='https://<worker>'
# Set ADMIN_AUTH_TOKEN to your separately stored admin token.
curl -X POST "$WORKER_URL/admin/sync" \
  -H "Authorization: Bearer $ADMIN_AUTH_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"mode":"full"}'
```

The endpoint returns HTTP 202 with `{ "accepted": true, "runId": "..." }`. The sync runs through the Queue after the HTTP response.

```sh
curl "$WORKER_URL/admin/sync/<runId>" \
  -H "Authorization: Bearer $ADMIN_AUTH_TOKEN"
```

Wait for `status: "completed"`. The response includes `pagesProcessed`, `entitiesProcessed`, and `error`. MCP tools return `SYNC_NOT_READY` until the first full sync completes.

Full sync order: users → teams → workflow states → projects → project milestones → issues → project updates. Each Queue message processes one GraphQL page of up to 50 entities. A page receipt and its continuation are committed together, allowing retries to recover an enqueue failure after the database commit. Version checks prevent older sync pages or webhooks from overwriting newer snapshots.

### Start a sync through Cloudflare

Operators can also start a sync by publishing a JSON control message to `linear-eye-events` through the [Cloudflare Queues API](https://developers.cloudflare.com/queues/examples/publish-to-a-queue-via-http/). This requires Cloudflare permission to publish to the Queue. The Worker uses its deployed Linear secret; the message must not contain credentials.

Generate a UUID once for the intended run, for example with `uuidgen`, and retain it. Send the following request body to `POST https://api.cloudflare.com/client/v4/accounts/<account-id>/queues/<queue-id>/messages`, authenticated with a Cloudflare API token:

```json
{
  "content_type": "json",
  "body": {
    "kind": "sync-request",
    "runId": "<run-uuid>",
    "mode": "full"
  }
}
```

Use the **same UUID** when retrying an uncertain submission. Duplicate deliveries reuse the run, and a request whose run has already progressed or finished does not start it again. Reusing an ID with a different mode is rejected. Use a new UUID only when intentionally starting another run. `mode: "reconcile"` is also supported after the first full sync completes.

The Queue API response confirms submission, not sync completion. Read the run through `/admin/sync/<run-uuid>` or through D1:

```sh
pnpm exec wrangler d1 execute linear-eye --remote \
  --command "SELECT id, mode, status, pages_processed, entities_processed, error FROM sync_runs WHERE id = '<run-uuid>';"
```

Wait for `status = 'completed'`. A failed initial page enqueue remains retryable. If the control message exhausts its retries, it goes to the dead-letter queue and the run can remain `running`: an earlier send may already have succeeded. After resolving the delivery failure, resubmit the same UUID to recover that run. Actual page-processing failures still mark the run `failed` when their retries are exhausted; those terminal failures require a new run ID.

## Reconciliation and recovery

Cron starts incremental reconciliation every day at **18:00 UTC / 03:00 Asia/Seoul**. It covers users, workflow states, projects, project milestones, and issues. The query watermark is the start of the last successful run minus a five-minute overlap. Using the start time avoids skipping changes made while a run was in progress.

```sh
curl -X POST "$WORKER_URL/admin/reconcile" \
  -H "Authorization: Bearer $ADMIN_AUTH_TOKEN" \
  -H 'Content-Type: application/json' -d '{}'
```

Linear page requests have a 20-second deadline covering both headers and response-body consumption. Expiration is a retryable error. The Queue retries failures up to five times, respects `Retry-After` on rate limits, and sends exhausted messages to `linear-eye-dead-letter`. Terminal sync failures are also recorded in the status API. Once the cause is resolved, start a new sync through the admin endpoint.

Replay webhook dead-letter messages to the original Queue using Cloudflare tooling, preserving their bodies and order. The `Linear-Delivery` receipt prevents duplicate persistence. During retries, sync status remains `running`. If a Worker cannot execute at all, it cannot update that status, so also inspect Queue backlog and dead-letter messages. Recover before Queue retention expires to preserve event history.

```sh
pnpm exec wrangler tail
```

Structured JSON logs cover webhook reception, rejection, processing and duplicates; sync starts, completion and failures; GraphQL pages and errors; and MCP tool names and latency. Secrets, full user questions, issue descriptions, and complete project-update bodies are not logged.

## Connect an MCP client

- URL: `https://<worker>/mcp`
- Transport: Streamable HTTP
- Header: `Authorization: Bearer <MCP_AUTH_TOKEN>`

Use the MCP token, not the admin token. OAuth discovery and login are not implemented, so clients must support custom Bearer headers. Browser CORS is not enabled.

MCP protocol smoke request:

```sh
curl "$WORKER_URL/mcp" \
  -H "Authorization: Bearer $MCP_AUTH_TOKEN" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -H 'MCP-Protocol-Version: 2025-03-26' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
```

## Available tools

| Tool | Example arguments |
|---|---|
| `get_team_current_work` | `{ "team": "SHOP", "includeStale": true }` |
| `get_member_activity` | `{ "member": "alice@example.com", "from": "2026-09-21", "to": "2026-09-27" }` |
| `get_project_progress` | `{ "project": "Storefront" }` |
| `get_milestone_progress` | `{ "project": "Storefront", "milestone": "Checkout" }` |
| `get_changes` | `{ "from": "2026-09-21", "to": "2026-09-27", "issue": "SHOP-123", "fields": ["state"], "limit": 100 }` |
| `get_weekly_report` | `{ "member": "alice@example.com", "week": "current" }` |

- Members resolve by exact ID, then email, display name, and name. Projects and milestones also require exact matches. Ambiguous matches return candidates and an `AMBIGUOUS_*` error.
- Dates are calendar dates in `REPORT_TIMEZONE`, inclusive at both ends. Weeks start on Monday. Weekly reports also accept `week: "previous"` or a Monday `weekStart`, such as `"2026-09-21"`.
- Every report includes tracking `coverage`. A range starting before tracking began has `complete: false`.
- Count and estimate progress exclude archived, deleted, and canceled issues from the denominator. Canceled issues have a separate count. An empty denominator returns `null`; missing estimates are not assigned an implicit value of one.
- The actor and the assignee at the time of a change are distinct. If assignment history is unavailable, attribution falls back to the current snapshot and sets `inferred: true`.
- `get_changes` returns up to 500 changes at a time, in chronological order. When `truncated` is true, pass `nextCursor` as `cursor` with the same filters to retrieve the next page.
- Weekly `currentlyInProgress` reflects the current snapshot; check `currentlyInProgressAsOf`. The Markdown draft uses a deterministic English template, without LLM-generated prose.
- `includeStale: false` excludes work with no recent observed changes. Staleness is an activity fact, not a performance assessment.

## Known limitations

- One workspace, read-only. No OAuth, dashboard, Slack/GitHub integration, LLM calls, or issue-description/comment ingestion.
- Bootstrap does not backfill historical activity. Reconciliation repairs snapshots without inventing missed intermediate events. Coverage describes the tracking window, not proof that every webhook arrived.
- Issue change reports use `field_changes`. Creation and removal events, and events for other entities, are stored, but the MVP has no separate event-timeline tool.
- Names and workflow state types use current metadata. Reports do not fully reproduce names as they appeared before a rename.
- Incremental queries cannot detect entities that have disappeared entirely from the API. A lost removal webhook requires operational investigation. Archived entities are recovered with `includeArchived: true`.
- Effect 4 is a release candidate. Upgrade Effect and its D1 driver together and run the full test suite.
- Page, query, and body sizes are bounded, but CPU, daily reads/writes/requests, Queue operations, and storage limits need validation for each workspace. Event retention and automatic deletion are not implemented.
- Real workspace bootstrap and hosted MCP access require account credentials and operational verification. Local tests and dry runs do not establish production readiness; see the [verification record](docs/verification.md) for runtime coverage and remaining checks.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development checks and contribution guidelines. This repository contains a deployable Worker application; `private: true` in `package.json` prevents accidental npm publication and does not make the GitHub repository private.

## License

[MIT](LICENSE).

## API references

- [Linear webhooks](https://linear.app/developers/webhooks): headers, signatures, signed timestamps, and retries.
- [Linear pagination](https://linear.app/developers/pagination) and [filtering](https://linear.app/developers/filtering).
- [Linear's official schema](https://github.com/linear/linear/blob/master/packages/sdk/src/schema.graphql): live introspection on 2026-09-29 also confirmed workspace-level `projectMilestones` and `updatedAt.gte` for every synchronized resource.
- [Cloudflare stateless MCP](https://developers.cloudflare.com/agents/model-context-protocol/).
- [Effect 4 RC changes](https://effect.website/blog/effect-v4-rc-august-recap) and [D1 limits](https://developers.cloudflare.com/d1/platform/limits/).
