# Effect architecture decision

**Status:** Accepted and implemented for the MVP.

This document records the Effect-specific decisions that refine the [MVP specification](mvp-spec.md). The project uses Effect for application logic, dependency injection, validation, and typed failures. Cloudflare owns the Worker lifecycle, durable queue delivery, and scheduled execution.

## Why Effect fits this service

`linear-eye` crosses several boundaries: Linear GraphQL, signed webhooks, Cloudflare Queues, D1, Cron Triggers, and MCP. Each boundary has different validation and failure behavior. Effect makes those dependencies and expected failures explicit while keeping the ingestion, projection, and intelligence logic composable and testable.

The data pipeline is:

```text
External input
    → validate
    → normalize and project
    → persist snapshots and observed changes
    → query intelligence services
```

Application programs request capabilities through `Context.Service`; production and test implementations are supplied through `Layer`. They do not need to access Cloudflare bindings directly.

## Version choice

The MVP pins both `effect` and `@effect/sql-d1` to `4.0.0-rc.118`. Starting with Effect 4 avoids building a new application around APIs that would require a later major-version migration. The tradeoff is accepting a release candidate and reviewing API changes during upgrades.

Keep the Effect runtime and D1 driver on compatible versions, commit the lockfile, and run the type checker, Worker tests, and deployment dry run when upgrading. Examples for other Effect versions may use different imports or service APIs; this repository uses `Context.Service`, `Schema.decodeUnknownEffect`, and `effect/sql`.

The MCP transport remains behind a separate adapter so an Effect upgrade does not also require replacing the public transport.

## Runtime and dependency boundaries

```text
Cloudflare Workers
├── fetch
│   ├── webhook verification and enqueue adapter
│   ├── authenticated admin adapter
│   └── authenticated MCP adapter
├── queue
│   └── message validation, acknowledgement, and retry adapter
└── scheduled
    └── start reconciliation
         │
         └── Effect programs with the required Layer
             ├── ingestion and synchronization
             ├── database queries and atomic batches
             └── intelligence and reporting
```

The implemented services are:

| Service | Responsibility | Production implementation |
| --- | --- | --- |
| `AppConfig` | Reporting timezone and projection limits | Worker environment configuration |
| `QueuePublisher` | Publish validated queue messages | Cloudflare Queue binding |
| `LinearClient` | Fetch and validate a page of Linear entities | Linear GraphQL over `fetch` |
| `Database` | Parameterized queries and atomic batches | Effect SQL with `@effect/sql-d1` |

`src/runtime.ts` composes three capability sets:

- `dataLayer`: database and configuration, used by intelligence queries and webhook ingestion.
- `applicationLayer`: the data layer plus queue publication, used to start and continue work.
- `syncLayer`: the application layer plus the Linear client, used by synchronization workers.

Programs obtain dependencies with `yield*` and are executed through `Effect.runPromise` at runtime boundaries. Pure projection and normalization helpers remain ordinary TypeScript functions. The MVP uses a small shared `Database` service rather than a separate repository interface for every entity; additional abstractions should follow actual requirements.

## Validation and failures

Treat external payloads as `unknown` and decode them with Effect Schema before using them. The implementation validates webhook envelopes, queue messages, GraphQL envelopes and entity nodes, and intelligence service inputs. Queue schemas are also reused when decoding persisted continuation messages.

MCP tool declarations use Zod to satisfy the MCP SDK's input schema API. Tool execution delegates to intelligence programs, whose inputs are validated with Effect Schema. This keeps the application boundary independent of the transport adapter.

Webhook handling follows this sequence:

```text
Read raw bytes
    → verify HMAC and header timestamp
    → parse and decode the payload
    → validate the timestamp in the signed body
    → build a compact, privacy-filtered projection
    → enqueue
```

Failures use tagged types such as `WebhookSignatureError`, `WebhookTimestampError`, `WebhookDecodeError`, `QueueOfferError`, `LinearApiError`, and `DatabaseError`. Adapters map them to HTTP responses, MCP errors, or queue retries. Public errors are sanitized; operational logs record failure categories without exposing secrets or raw payloads.

The Linear client has a 20-second deadline covering both response headers and body reads. A timeout aborts the request and produces a typed, retryable failure. Rate-limit responses preserve retry timing for the queue consumer.

## Database access and atomicity

Use **Effect SQL + the D1 driver**, with no ORM. SQL values are bound parameters; identifiers come from internal allowlists. The `Database` service exposes `all`, `first`, and `batch` and translates driver failures into `DatabaseError`.

D1 atomic batches implement the required transaction boundary. Do not issue `BEGIN` or assume generic SQL transaction support works on D1. Webhook ingestion commits delivery deduplication, field history, and the snapshot update together. Synchronization commits page data, its receipt, counters, and continuation metadata together.

Bulk statements keep query counts bounded when a page contains many entities or an event changes many fields. Effect provides a typed interface to these operations; the database still provides the atomicity and idempotency guarantees.

## Durable execution belongs to Cloudflare

Cloudflare Queues own persistent delivery, acknowledgement, delayed retries, and dead-letter handling. Cron Triggers initiate daily reconciliation. Effect programs execute the work within each invocation.

An Effect schedule runs only while its runtime is alive. It cannot preserve a daily task or a retry across Worker termination. Do not replace Queue or Cron durability with `Effect.Schedule`, an in-memory loop, or a long-running fiber. Bounded, in-invocation controls such as a request deadline are appropriate uses of Effect.

The queue consumer acknowledges successful processing and explicitly retries failures. Sync page receipts and persisted continuations allow retries to resume safely without fetching an already committed page again.

## MCP transport decision

The MVP uses Cloudflare's `createMcpHandler` from `agents/mcp/server` with `@modelcontextprotocol/server` for stateless Streamable HTTP. Each read-only MCP tool delegates to an Effect intelligence program backed by D1.

Effect's native MCP APIs were considered as an alternative that could unify transport and application logic. They were not selected for the MVP: retaining the Cloudflare adapter keeps deployment integration straightforward and separates transport changes from the Effect release candidate upgrade path. Revisit this choice only when a concrete transport requirement justifies the migration.

## Testing approach

Dependency injection lets tests supply a controlled `LinearClient`, `QueuePublisher`, or configuration without changing application logic. Database integration tests use the Cloudflare Workers Vitest pool with local D1 and the real migrations, so SQL constraints and atomic batch behavior are exercised directly.

The test suite covers authentication, webhook verification and projection, concurrent delivery deduplication, rollback behavior, paginated sync recovery, request cancellation, input validation, date and timezone boundaries, intelligence calculations, and MCP responses. No live Linear credentials are needed for these tests. Production credentials and a deployed environment are still required to verify a real workspace integration.

## Selected stack

| Concern | Decision |
| --- | --- |
| Runtime | Cloudflare Workers |
| Application logic | Effect 4 RC |
| Dependency injection | `Context.Service` and `Layer` |
| Application validation | Effect Schema |
| Database | D1 through Effect SQL and `@effect/sql-d1` |
| Durable delivery | Cloudflare Queues |
| Scheduled execution | Cloudflare Cron Triggers |
| MCP transport | Cloudflare `createMcpHandler` and `@modelcontextprotocol/server` |
| MCP handlers | Thin adapters to Effect intelligence programs |
