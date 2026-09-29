# MVP verification

Verified locally on 2026-09-29. This record describes observed checks, not production deployment.

| Check | Result |
|---|---|
| `pnpm check` | Passed |
| `pnpm test` | 80 tests passed across 11 files |
| `pnpm build` | Wrangler deployment dry run passed; 387.04 KiB gzip |
| `pnpm db:migrate:local` | Initial migration applied successfully (38 statements) |
| Actual `wrangler dev` `/health` | HTTP 200; correct service JSON |
| Actual `wrangler dev` anonymous `/mcp` | HTTP 401 |
| Actual `wrangler dev` anonymous `/admin/sync/...` | HTTP 401 |
| MCP HTTP initialization and tool listing | Exactly six read-only tools |
| All six MCP HTTP tool calls | D1 only; no outgoing fetch |
| Live Linear introspection | All collection fields, selections, pagination and updatedAt filters verified |
| Hosted Cloudflare deployment / authenticated Linear bootstrap | Not run: D1 ID, account credentials and service secrets are not configured |

Tests run in the Workers runtime with real local D1. They exercise signature and signed timestamp validation, data minimization, retry idempotence, concurrent duplicate delivery, atomic rollback, version and tombstone guards, fifty-row bulk sync, page continuations, Queue failure recovery, GraphQL errors, Cron enqueueing, exact-name ambiguity, progress denominators, historical assignment, date coverage, DST and deterministic weekly reports.

Final regressions also cover a stalled GraphQL connection and response body (both aborted after 20 seconds), large unknown webhook values and field names, UTF-8 queue budgeting that preserves known fields and metadata, and stable omission counts across HTTP and consumer projection. Changed-field persistence uses one bulk SQL statement while preserving canonical JSON strings, delivery guards and atomic rollback.

The bounded-statement regression counts SQL statements through a test Layer. It does not reproduce hosted Cloudflare subrequest enforcement or establish how statements within a native D1 batch consume that allowance.

The integration test submits a signed HTTP webhook, observes no D1 writes before consumption, consumes its compact queue message, and checks persisted snapshot/event rows. Unit dependency replacement uses Effect Layers; the database tests use the actual Effect SQL D1 driver.

The pinned Vitest Workers pool supports compatibility dates only through 2026-08-22, so automated tests use 2026-08-15. Attempting the deployment date 2026-09-29 was rejected before tests started. The separate Wrangler development-server smoke checks and deployment dry run use the configured deployment date; the full automated suite has not run against that newer runtime.

## Review and resolution

`ce-code-review` completed its full review of the captured implementation (`status: complete`, run `20260929-105254-c029ac73`). It confirmed three P2 findings: oversized unknown history rejecting a webhook, an unbounded Linear request, and a timestamp rejection test dependent on setup speed. All three were fixed with regressions and included in the final verification above. There are no remaining confirmed findings.

The separate D1 batch-accounting claim remained unconfirmed and was excluded from actionable defects. Bulk history insertion is retained as a bounded-statement improvement. The review evaluated the captured pre-fix source; the final test results verify the subsequent repairs, without claiming a second independent review.

## Operational acceptance after configuration

The deployer should verify the first bootstrap reaches `completed`, inspect its counters against workspace expectations, trigger one real issue update, and confirm a single event/field change is visible through MCP. Then verify a manual reconciliation completes and the next daily Cron produces `sync.started` / `sync.completed` without a growing queue backlog.

Investigate repeated webhook rejection, sustained Queue retries, a dead-letter backlog, failed or stalled syncs, MCP failures, and D1/Workers quota errors. Fix configuration or upstream availability first; replay preserved deliveries to recover history, then reconcile snapshots. Reconciliation cannot reconstruct lost intermediate events. If a deployed code change corrupts projections, roll back the Worker version before reprocessing; retain the D1 data and dead-letter messages for investigation.

Production CPU, quota use and latency remain unmeasured; a successful dry run and local tests do not establish Free-tier capacity for a particular workspace.
