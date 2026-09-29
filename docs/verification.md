# MVP verification

Verified locally and on Cloudflare on 2026-09-29. This record distinguishes local checks from observed hosted behavior.

| Check | Result |
|---|---|
| `pnpm check` | Passed |
| `pnpm test` | 139 tests passed across 16 files, including dashboard and Access coverage |
| `pnpm build` | React assets and Wrangler deployment dry run passed; Worker 399.25 KiB gzip |
| `pnpm db:migrate:local` | Initial migration applied successfully (38 statements) |
| Actual `wrangler dev` `/health` | HTTP 200; correct service JSON |
| Actual `wrangler dev` anonymous `/mcp` | HTTP 401 |
| Actual `wrangler dev` anonymous `/admin/sync/...` | HTTP 401 |
| MCP HTTP initialization and tool listing | Exactly six read-only tools |
| All six MCP HTTP tool calls | D1 only; no outgoing fetch |
| Live Linear introspection | All collection fields, selections, pagination and updatedAt filters verified |
| `pnpm run deploy` | Worker, dashboard assets, Queue consumer, and daily Cron deployed successfully |
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

## Dashboard and Access checks

The dashboard API tests use signed RS256 assertions and a synthetic JWKS with real local D1. They verify trusted issuer/audience/expiry, rejection of forged signatures and plain email/bearer headers, alternate hostname protection, missing configuration, read-only methods, input errors, selectors, sync metadata, and team/project/milestone/activity responses. Asset tests cover prefix routing, redirects, HTML security headers, and separation from machine endpoints.

A local Miniflare preview using compatibility date 2026-09-29, an ephemeral database, synthetic commerce data, and a fixture signing key exercised the built Worker and React assets. Browser checks covered Team, project selection, milestone details, Activity, 30-to-60-row pagination, empty results, JSON and HTML 503 responses with Retry, and a simulated expired session with sign-in recovery. Final browser checks confirmed optional filters can be cleared, a failed next page retains all loaded rows and retries the same cursor, and refreshing during a delayed third page leaves only the refreshed first page after the delayed response arrives. Desktop and 390px mobile layouts rendered without horizontal page overflow; no browser console errors were observed. These checks do not use production credentials or establish live identity verification.

The hosted Access application was configured with `/app` and `/api` parent paths, an explicit email allow rule, One-time PIN, a 24-hour application session, and HttpOnly cookies. Anonymous visits to `/app/` and `/api/bootstrap` reached the expected Access login page. The API also verifies the signed assertion inside the Worker. The dashboard Worker and assets were deployed as version `458074a9-58e5-41e5-86d8-6e9848585c76`. Authenticated hosted dashboard acceptance remains pending until the operator's first Access login.

## Review and resolution

`ce-code-review` completed its full review of the captured implementation (`status: complete`, run `20260929-105254-c029ac73`). It confirmed three P2 findings: oversized unknown history rejecting a webhook, an unbounded Linear request, and a timestamp rejection test dependent on setup speed. All three were fixed with regressions and included in the final verification above. There are no remaining confirmed findings.

The separate D1 batch-accounting claim remained unconfirmed and was excluded from actionable defects. Bulk history insertion is retained as a bounded-statement improvement. The review evaluated the captured pre-fix source; the final test results verify the subsequent repairs, without claiming a second independent review.

The dashboard review completed with `status: complete` (run `20260929-190230-a1a08966`). Six findings were applied in two batches: signing-key outages now return a retryable 503 (finding 1); pagination preserves results on failure, filters remain clearable, calendar dates retain their day, stale pages cannot append after refresh, and non-JSON service errors retain a retry action (findings 2, 3, 4, 5, and 7). The final suite adds regressions for signing-key service failures, unknown keys, timezone/date boundaries, and client error classification. Browser checks cover the pagination and filter repairs. No confirmed findings remain unresolved. The review covered the captured source before these repairs; the final checks verify the repairs without claiming a second independent review.

## English publication check

The public repository documentation and deterministic weekly Markdown template use English. The publication update passed the full 81-test suite, type checking, and deployment dry run. Weekly report regressions verify every English heading, the `None` fallback, and Markdown escaping. Documentation review checked command examples, configuration, MIT license metadata, and translated specification structure; the documented scope-change heading was aligned with the runtime.

## Remaining operational acceptance

The first hosted bootstrap and a manual reconciliation have reached `completed`. Both ran inside the Worker using its configured secrets; no local Linear sync helper was required. Linear webhook configuration and its signing secret were also verified, but live webhook delivery has not been tested end to end.

The deployer should inspect the bootstrap counters against workspace expectations, trigger one real issue update, and confirm a single event/field change is visible through authenticated MCP. Verify that the next daily Cron produces `sync.started` / `sync.completed` without a growing queue backlog. Registering the Cron and completing manual reconciliation do not verify a scheduled invocation.

Investigate repeated webhook rejection, sustained Queue retries, a dead-letter backlog, failed or stalled syncs, MCP failures, and D1/Workers quota errors. Fix configuration or upstream availability first; replay preserved deliveries to recover history, then reconcile snapshots. Reconciliation cannot reconstruct lost intermediate events. If a deployed code change corrupts projections, roll back the Worker version before reprocessing; retain the D1 data and dead-letter messages for investigation.

Production CPU, quota use and sustained latency remain unmeasured; local tests and successful initial syncs do not establish Free-tier capacity for a particular workspace.
