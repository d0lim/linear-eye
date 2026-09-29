# MVP verification

Verified locally and on Cloudflare on 2026-09-29. This record distinguishes local checks from observed hosted behavior.

| Check | Result |
|---|---|
| `pnpm check` | Passed |
| `pnpm test` | 95 tests passed across 12 files |
| `pnpm build` | Wrangler deployment dry run passed; 387.18 KiB gzip |
| `pnpm db:migrate:local` | Initial migration applied successfully (38 statements) |
| Actual `wrangler dev` `/health` | HTTP 200; correct service JSON |
| Actual `wrangler dev` anonymous `/mcp` | HTTP 401 |
| Actual `wrangler dev` anonymous `/admin/sync/...` | HTTP 401 |
| MCP HTTP initialization and tool listing | Exactly six read-only tools |
| All six MCP HTTP tool calls | D1 only; no outgoing fetch |
| Live Linear introspection | All collection fields, selections, pagination and updatedAt filters verified |
| `pnpm run deploy` | Worker, Queue consumer, and daily Cron deployed successfully |
| Remote D1 migration | Initial migration applied successfully (38 statements) |
| Hosted `/health` | Correct service JSON confirmed by the operator in a browser |
| Hosted full sync | Queue request accepted through the Cloudflare API; run reached `completed` with no error, and snapshots were present in remote D1 |
| Hosted manual reconciliation | Queue request reached `completed` with no error; reconciliation watermark persisted |
| Hosted authenticated MCP calls | Not verified: the execution environment's configured proxy rejects the Worker URL before HTTP |

Tests run in the Workers runtime with real local D1. They exercise signature and signed timestamp validation, data minimization, retry idempotence, concurrent duplicate delivery, atomic rollback, version and tombstone guards, fifty-row bulk sync, page continuations, Queue failure recovery, GraphQL errors, Cron enqueueing, exact-name ambiguity, progress denominators, historical assignment, date coverage, DST and deterministic weekly reports.

Final regressions also cover a stalled GraphQL connection and response body (both aborted after 20 seconds), large unknown webhook values and field names, UTF-8 queue budgeting that preserves known fields and metadata, and stable omission counts across HTTP and consumer projection. Changed-field persistence uses one bulk SQL statement while preserving canonical JSON strings, delivery guards and atomic rollback.

Queue control-message regressions cover full and reconciliation requests, UUID validation, retries after enqueue failure, concurrent duplicate requests, persisted reconciliation watermarks, mismatched modes, and no-op delivery after progress or completion. Exhausting a duplicate control message's retries must not fail a run whose first page is already queued. A focused independent review found and resolved that race before the final checks and deployment.

The bounded-statement regression counts SQL statements through a test Layer. It does not reproduce hosted Cloudflare subrequest enforcement or establish how statements within a native D1 batch consume that allowance.

The integration test submits a signed HTTP webhook, observes no D1 writes before consumption, consumes its compact queue message, and checks persisted snapshot/event rows. Unit dependency replacement uses Effect Layers; the database tests use the actual Effect SQL D1 driver.

The pinned Vitest Workers pool supports compatibility dates only through 2026-08-22, so automated tests use 2026-08-15. Attempting the deployment date 2026-09-29 was rejected before tests started. The separate Wrangler development-server smoke checks and deployment dry run use the configured deployment date; the full automated suite has not run against that newer runtime.

## Review and resolution

`ce-code-review` completed its full review of the captured implementation (`status: complete`, run `20260929-105254-c029ac73`). It confirmed three P2 findings: oversized unknown history rejecting a webhook, an unbounded Linear request, and a timestamp rejection test dependent on setup speed. All three were fixed with regressions and included in the final verification above. There are no remaining confirmed findings.

The separate D1 batch-accounting claim remained unconfirmed and was excluded from actionable defects. Bulk history insertion is retained as a bounded-statement improvement. The review evaluated the captured pre-fix source; the final test results verify the subsequent repairs, without claiming a second independent review.

## English publication check

The public repository documentation and deterministic weekly Markdown template use English. The publication update passed the full 81-test suite, type checking, and deployment dry run. Weekly report regressions verify every English heading, the `None` fallback, and Markdown escaping. Documentation review checked command examples, configuration, MIT license metadata, and translated specification structure; the documented scope-change heading was aligned with the runtime.

## Remaining operational acceptance

The first hosted bootstrap and a manual reconciliation have reached `completed`. Both ran inside the Worker using its configured secrets; no local Linear sync helper was required. Linear webhook configuration and its signing secret were also verified, but live webhook delivery has not been tested end to end.

The deployer should inspect the bootstrap counters against workspace expectations, trigger one real issue update, and confirm a single event/field change is visible through authenticated MCP. Verify that the next daily Cron produces `sync.started` / `sync.completed` without a growing queue backlog. Registering the Cron and completing manual reconciliation do not verify a scheduled invocation.

Investigate repeated webhook rejection, sustained Queue retries, a dead-letter backlog, failed or stalled syncs, MCP failures, and D1/Workers quota errors. Fix configuration or upstream availability first; replay preserved deliveries to recover history, then reconcile snapshots. Reconciliation cannot reconstruct lost intermediate events. If a deployed code change corrupts projections, roll back the Worker version before reprocessing; retain the D1 data and dead-letter messages for investigation.

Production CPU, quota use and sustained latency remain unmeasured; local tests and successful initial syncs do not establish Free-tier capacity for a particular workspace.
