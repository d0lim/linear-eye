# linear-eye — MVP Specification

> Implementation update: [Effect implementation direction](effect-direction.md) supersedes the original direct-binding database choice. The application uses Effect 4 RC, Effect SQL, and its D1 driver. The product requirements below remain in effect.

> Dashboard extension (2026-09-29): the approved read-only browser dashboard supersedes this document's original web-dashboard exclusion. Team, Projects, milestone details, and Activity now share the existing intelligence functions through an Access-authenticated API on the same Worker. See [Dashboard and Cloudflare Access](../README.md#dashboard-and-cloudflare-access) for the current login and deployment contract. MCP bearer authentication and webhook verification remain separate.

## 1. Overview

`linear-eye` collects Linear's current state and change history, stores them for analysis, and exposes intelligence about the team's work through MCP (Model Context Protocol).

The project addresses the following problems:

- Development teams without a PM or PO struggle to see what each member is working on.
- Someone must manually check the actual progress of each Linear project and milestone.
- Changes over the past few days or week are difficult to track.
- Team members have to write weekly reports by hand.
- Linear exposes current state, but analysis over time is limited.

`linear-eye` does not replace Linear.

Linear remains the **source of truth**, with the following layers added above it:

```text
Linear
  ↓
Current State + Change History
  ↓
Deterministic Analytics
  ↓
MCP
  ↓
ChatGPT / Claude / Coding Agent
```

The MVP is a **read-only intelligence service**.

It does not modify Linear issues, projects, or other resources.

---

# 2. Goals

The MVP must be able to answer the following questions.

### Team activity

```text
Which issues is each team member currently working on?
```

### Member activity

```text
What did Alice work on this week?
```

### Project progress

```text
How is the Storefront project progressing?
```

### Milestone progress

```text
Show the progress of the Checkout milestone in the Storefront project.
```

### Changes

```text
What were the main changes in Linear last week?
```

```text
Which issues changed milestones this week?
```

### Weekly report

```text
Draft Alice's weekly report for this week.
```

Once the MVP is complete, an MCP client must be able to answer these questions using only `linear-eye` data, without making additional Linear API calls.

---

# 3. Non-goals

The following features are outside the MVP scope:

- Creating Linear issues
- Editing Linear issues
- Posting Linear comments
- Editing projects
- OAuth support for multiple workspaces
- A web dashboard
- Slack integration
- GitHub integration
- Calling an LLM from the service
- Individual productivity scores
- Ranking team members
- Evaluating workloads
- Predicting velocity
- AI predictions of completion dates
- Natural language to Linear mutations
- Ingesting all Linear comments
- Ingesting full Linear issue descriptions
- Backfilling all historical Linear activity

The MVP targets a single Linear workspace.

---

# 4. Design Principles

## 4.1 Linear is the source of truth

Linear is the canonical source of current state.

Data in `linear-eye` is a projection/cache used to analyze Linear.

If data disagrees, Linear's state takes precedence.

---

## 4.2 Snapshot + Event History

Keep current state separate from change history.

```text
Snapshot
────────────
Who is working on what now?

Event History
────────────
What changed, when, and how?
```

For example, store this snapshot:

```text
issues
  SHOP-123
  state = Done
  assignee = Alice
```

Separately, store the change history:

```text
field_changes

SHOP-123
Todo → In Progress

SHOP-123
Alice → Bob

SHOP-123
In Progress → Done
```

---

## 4.3 Webhook first, GraphQL reconciliation second

Use Linear webhooks as the primary mechanism for collecting changes.

Use the GraphQL API only for:

- Initial bootstrap
- Periodic reconciliation
- Synchronizing metadata that is difficult to obtain through webhooks
- Recovering from missed webhooks

Do not continuously poll all Linear data.

Linear also recommends webhooks instead of polling to detect updates.

---

## 4.4 Intelligence must be deterministic

Do not call an LLM inside the MVP server.

For example:

```text
get_weekly_report()
```

returns factual data like the following, rather than AI-generated prose:

```json
{
  "completed": [],
  "started": [],
  "reopened": [],
  "scopeChanges": [],
  "currentlyInProgress": []
}
```

The response may also include a deterministic Markdown draft.

The MCP client, such as ChatGPT or Claude, produces the final natural-language summary.

This design supports:

- Operation on Cloudflare's free tier
- Reduced hallucination
- Traceable evidence for analysis results
- Independence from LLM vendors

---

# 5. Technology Stack

## Runtime

- TypeScript
- Cloudflare Workers
- No Node.js application server
- No separate containers

## Storage

- Cloudflare D1

Do not use KV as the primary database.

The required queries are relational workloads, for example:

```sql
WHERE assignee_id = ?
WHERE project_id = ?
WHERE occurred_at BETWEEN ? AND ?
GROUP BY assignee
GROUP BY state
```

Use D1 for this workload.

## Queue

Use Cloudflare Queues.

Purposes:

- Minimize webhook response latency
- Separate webhook ingestion from database writes
- Support retries
- Process pagination during initial sync and reconciliation

## MCP

Use Cloudflare's stateless MCP approach.

Dependencies:

```text
agents
@modelcontextprotocol/server
zod
```

MCP endpoint:

```text
/mcp
```

Cloudflare provides stateless Streamable HTTP through `createMcpHandler()` for new MCP servers.

## Database access

Do not use an ORM.

Use Effect SQL with the D1 driver and SQL migrations. The [Effect implementation direction](effect-direction.md) supersedes the original choice to call the D1 Worker binding directly from application code.

Goals:

- Keep the bundle small
- Make query costs explicit
- Allow D1-specific optimizations
- Keep the schema simple

---

# 6. High-level Architecture

```text
                         ┌─────────────────┐
                         │     Linear      │
                         └───────┬─────────┘
                                 │
                  ┌──────────────┴──────────────┐
                  │                             │
               Webhook                      GraphQL
                  │                             │
                  ▼                             ▼
        POST /webhooks/linear          Sync / Reconcile
                  │                             │
           HMAC validation                     │
                  │                             │
                  └─────────────┬───────────────┘
                                ▼
                       Cloudflare Queue
                                │
                                ▼
                         Queue Consumer
                                │
                   ┌────────────┴────────────┐
                   │                         │
            Snapshot update             Event history
                   │                         │
                   └────────────┬────────────┘
                                ▼
                         Cloudflare D1
                                │
                                ▼
                         Analytics Layer
                                │
                                ▼
                           MCP Server
                                │
                                ▼
                  ChatGPT / Claude / Agent
```

A single Cloudflare Worker project provides all of these handlers:

```text
fetch()
queue()
scheduled()
```

Do not split them into separate microservices.

---

# 7. HTTP Endpoints

## 7.1 Health

```http
GET /health
```

No authentication required.

Response:

```json
{
  "status": "ok",
  "service": "linear-eye"
}
```

Do not query the database for health checks.

This avoids a D1 read on every health request.

---

## 7.2 Linear Webhook

```http
POST /webhooks/linear
```

Dedicated endpoint for Linear webhooks.

Processing order:

```text
read raw body
↓
verify Linear-Signature
↓
verify timestamp
↓
parse JSON
↓
project payload into compact queue message
↓
QUEUE.send()
↓
200
```

Verify the Linear webhook signature with HMAC-SHA256 over the raw HTTP body.

Validate:

```text
Linear-Signature
Linear-Timestamp
```

Return `401` unless the following condition holds:

```text
abs(now - webhookTimestamp) <= 60 seconds
```

Use the following identifier for deduplication:

```text
Linear-Delivery
```

Linear supplies a unique `Linear-Delivery` UUID for each webhook payload and retries if the handler does not return HTTP 200 within five seconds.

Do not write directly to D1 in the webhook endpoint.

The endpoint only validates the request and enqueues it.

---

## 7.3 MCP

```http
POST /mcp
GET /mcp
```

Use Cloudflare's `createMcpHandler()`.

Authentication:

```http
Authorization: Bearer <MCP_AUTH_TOKEN>
```

Authentication failure:

```http
401 Unauthorized
```

Do not expose MCP anonymously on the internet.

---

## 7.4 Full sync

```http
POST /admin/sync
```

Authentication:

```http
Authorization: Bearer <ADMIN_AUTH_TOKEN>
```

Body:

```json
{
  "mode": "full"
}
```

Response:

```json
{
  "accepted": true,
  "runId": "uuid"
}
```

Do not perform the sync inside the HTTP request.

Enqueue the first sync job instead.

---

## 7.5 Reconciliation

```http
POST /admin/reconcile
```

Body:

```json
{}
```

Start queue-based incremental reconciliation.

---

## 7.6 Sync status

```http
GET /admin/sync/:runId
```

Response:

```json
{
  "id": "...",
  "mode": "full",
  "status": "completed",
  "startedAt": "...",
  "completedAt": "...",
  "pagesProcessed": 18,
  "entitiesProcessed": 742,
  "error": null
}
```

---

# 8. Environment Variables / Secrets

Cloudflare secrets:

```text
LINEAR_API_KEY
LINEAR_WEBHOOK_SECRET
MCP_AUTH_TOKEN
ADMIN_AUTH_TOKEN
```

Environment variables:

```text
REPORT_TIMEZONE=Asia/Seoul
STALE_ISSUE_DAYS=5
PROJECT_UPDATE_BODY_LIMIT=8000
```

Do not write API keys or tokens directly in `wrangler.jsonc`.

Use Cloudflare secrets.

---

# 9. Linear Webhook Subscription

Subscribe to these resources for the MVP:

```text
Issue
Project
ProjectUpdate
User
```

Additional resources may be added later if needed:

```text
Cycle
IssueLabel
Comment
```

Do not ingest comments in the MVP.

Do not store issue descriptions either.

Linear data-change webhooks provide `create`, `update`, and `remove` events. Update events include previous values in `updatedFrom`.

---

# 10. Queue Message Types

Represent queue messages as a discriminated union.

## Webhook message

```ts
type WebhookQueueMessage = {
  kind: "webhook";

  deliveryId: string;
  webhookId: string | null;

  organizationId: string;
  eventType: string;
  action: "create" | "update" | "remove";

  occurredAt: string;
  receivedAt: string;

  actor: {
    id: string | null;
    type: string | null;
    name: string | null;
  } | null;

  entityUrl: string | null;

  data: Record<string, unknown>;
  updatedFrom: Record<string, unknown> | null;
};
```

Do not put the entire original webhook payload in `data`.

Apply a projection for each entity type.

Example allowlisted issue fields:

```text
id
identifier
title
teamId
assigneeId
creatorId
stateId
projectId
projectMilestoneId
cycleId
priority
estimate
dueDate
parentId
url
createdAt
updatedAt
startedAt
completedAt
canceledAt
archivedAt
```

Remove the description.

Do not store unknown fields in snapshots.

Changed fields in `updatedFrom` may still be used to create field-change history.

---

## Sync message

```ts
type SyncQueueMessage = {
  kind: "sync";

  runId: string;

  mode: "full" | "reconcile";

  resource:
    | "users"
    | "teams"
    | "workflow_states"
    | "projects"
    | "project_milestones"
    | "issues"
    | "project_updates";

  cursor: string | null;

  watermark: string | null;
};
```

Each queue consumer invocation processes one GraphQL page.

If another page exists, enqueue the next cursor for the same resource.

After the last page, enqueue the next resource.

---

# 11. Sync Order

Run a full sync in this order:

```text
users
↓
teams
↓
workflow_states
↓
projects
↓
project_milestones
↓
issues
↓
project_updates
```

Each resource uses Relay pagination:

```text
first: 50
after: cursor
```

The Linear API uses cursor-based pagination and provides `pageInfo.hasNextPage` and `endCursor`.

During implementation, introspect the current Linear GraphQL schema to confirm the exact collection field for milestone queries.

If no workspace-level milestone collection exists, traverse:

```text
projects
  → project
     → projectMilestones
```

Do not guess and hardcode undocumented operation names.

---

# 12. Reconciliation Strategy

Do not assume that webhook delivery alone guarantees data consistency.

Run GraphQL reconciliation once per day.

Cloudflare Cron:

```text
18:00 UTC
```

Equivalent local time:

```text
03:00 Asia/Seoul
```

Use approximately this schedule.

Reconcile these resources:

```text
users
workflow_states
projects
project_milestones
issues
```

Use an `updatedAt >= watermark` filter when available.

If the current GraphQL schema does not support that filter, use:

```text
orderBy: updatedAt
```

Fetch results in descending order and stop pagination when records precede the watermark.

Linear's documentation also recommends sorting by `updatedAt` when fetching recently changed data.

Reconciliation repairs snapshots only.

Do not invent intermediate event history for missed webhooks.

Example:

```text
Actual changes

A → B → C

The webhook for event B is lost
```

Reconciliation restores:

```text
current snapshot = C
```

It does not fabricate the following history:

```text
A → B
B → C
```

---

# 13. Database Schema

Store every timestamp as a UTC ISO-8601 string.

Example:

```text
2026-09-29T01:30:00.000Z
```

## meta

```sql
CREATE TABLE meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
```

Keys used:

```text
tracking_started_at
last_full_sync_completed_at
last_reconcile_completed_at
```

---

## users

```sql
CREATE TABLE users (
    id TEXT PRIMARY KEY,

    name TEXT NOT NULL,
    display_name TEXT,
    email TEXT,
    avatar_url TEXT,

    active INTEGER NOT NULL DEFAULT 1,

    created_at TEXT,
    updated_at TEXT,
    deleted_at TEXT
);
```

---

## teams

```sql
CREATE TABLE teams (
    id TEXT PRIMARY KEY,

    key TEXT NOT NULL,
    name TEXT NOT NULL,

    created_at TEXT,
    updated_at TEXT,
    archived_at TEXT,
    deleted_at TEXT
);
```

---

## workflow_states

```sql
CREATE TABLE workflow_states (
    id TEXT PRIMARY KEY,

    team_id TEXT NOT NULL,

    name TEXT NOT NULL,
    type TEXT NOT NULL,

    created_at TEXT,
    updated_at TEXT,
    deleted_at TEXT
);
```

`type` stores the semantic type of a Linear workflow state.

Examples:

```text
backlog
unstarted
started
completed
canceled
```

---

## projects

```sql
CREATE TABLE projects (
    id TEXT PRIMARY KEY,

    name TEXT NOT NULL,
    url TEXT,

    status_id TEXT,
    status_name TEXT,
    status_type TEXT,

    lead_id TEXT,

    start_date TEXT,
    target_date TEXT,

    created_at TEXT,
    updated_at TEXT,

    completed_at TEXT,
    canceled_at TEXT,
    archived_at TEXT,
    deleted_at TEXT
);
```

---

## project_milestones

```sql
CREATE TABLE project_milestones (
    id TEXT PRIMARY KEY,

    project_id TEXT NOT NULL,

    name TEXT NOT NULL,

    target_date TEXT,

    created_at TEXT,
    updated_at TEXT,
    deleted_at TEXT
);
```

---

## issues

```sql
CREATE TABLE issues (
    id TEXT PRIMARY KEY,

    identifier TEXT NOT NULL,
    title TEXT NOT NULL,

    team_id TEXT NOT NULL,

    assignee_id TEXT,
    creator_id TEXT,

    state_id TEXT NOT NULL,

    project_id TEXT,
    project_milestone_id TEXT,
    cycle_id TEXT,

    priority INTEGER,
    estimate REAL,

    due_date TEXT,

    parent_id TEXT,

    url TEXT,

    created_at TEXT,
    updated_at TEXT,

    started_at TEXT,
    completed_at TEXT,
    canceled_at TEXT,
    archived_at TEXT,

    deleted_at TEXT,

    last_synced_at TEXT NOT NULL
);
```

---

## project_updates

```sql
CREATE TABLE project_updates (
    id TEXT PRIMARY KEY,

    project_id TEXT NOT NULL,
    user_id TEXT,

    health TEXT,

    body TEXT,

    url TEXT,

    created_at TEXT,
    updated_at TEXT,
    archived_at TEXT,
    deleted_at TEXT
);
```

Store at most the following number of characters in `body`:

```text
PROJECT_UPDATE_BODY_LIMIT
```

Default:

```text
8000 characters
```

---

# 14. Event Storage

## events

Create one event per webhook.

```sql
CREATE TABLE events (
    id TEXT PRIMARY KEY,

    webhook_id TEXT,

    organization_id TEXT,

    entity_type TEXT NOT NULL,
    entity_id TEXT,

    action TEXT NOT NULL,

    actor_id TEXT,
    actor_type TEXT,
    actor_name TEXT,

    occurred_at TEXT NOT NULL,
    received_at TEXT NOT NULL,

    entity_url TEXT,

    source TEXT NOT NULL
);
```

Use `Linear-Delivery` as the `id`.

This prevents duplicate events when a webhook is retried.

`source`:

```text
webhook
```

Do not record reconciliation results as events in the MVP.

---

## field_changes

Store one row per field changed in an update webhook.

```sql
CREATE TABLE field_changes (
    id TEXT PRIMARY KEY,

    event_id TEXT NOT NULL,

    entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,

    field_name TEXT NOT NULL,

    old_value TEXT,
    new_value TEXT,

    actor_id TEXT,

    occurred_at TEXT NOT NULL
);
```

Store `old_value` and `new_value` as canonical JSON representations.

Examples:

```text
"abc-user-id"
3
null
```

Generate the ID as:

```text
${eventId}:${fieldName}
```

Assume each field changes at most once within a webhook.

---

# 15. Field normalization

Normalize the following issue fields to canonical names:

```text
assigneeId
    → assignee

stateId
    → state

projectId
    → project

projectMilestoneId
    → project_milestone

priority
    → priority

estimate
    → estimate

dueDate
    → due_date

title
    → title

cycleId
    → cycle

parentId
    → parent
```

Store unknown changed fields using this name:

```text
linear.<originalFieldName>
```

Example:

```text
linear.fooBar
```

This preserves change history when Linear introduces new fields.

---

# 16. Indexes

Create at least the following indexes:

```sql
CREATE INDEX idx_issues_assignee
ON issues(assignee_id);

CREATE INDEX idx_issues_project
ON issues(project_id);

CREATE INDEX idx_issues_milestone
ON issues(project_milestone_id);

CREATE INDEX idx_issues_state
ON issues(state_id);

CREATE INDEX idx_issues_updated
ON issues(updated_at);

CREATE INDEX idx_events_entity
ON events(entity_type, entity_id, occurred_at);

CREATE INDEX idx_events_actor
ON events(actor_id, occurred_at);

CREATE INDEX idx_events_occurred
ON events(occurred_at);

CREATE INDEX idx_changes_entity
ON field_changes(entity_type, entity_id, occurred_at);

CREATE INDEX idx_changes_field
ON field_changes(field_name, occurred_at);

CREATE INDEX idx_changes_actor
ON field_changes(actor_id, occurred_at);

CREATE INDEX idx_milestones_project
ON project_milestones(project_id);

CREATE INDEX idx_project_updates_project
ON project_updates(project_id, created_at);
```

The original design assumes D1 Free limits of 5 million rows read and 100,000 rows written per day, with queries failing when daily limits are exceeded from September 1, 2026. Indexes are required to avoid full-table scans. Check current Cloudflare limits before deployment.

---

# 17. Webhook Processing

The queue consumer processes webhook messages in this order:

```text
1. events INSERT OR IGNORE
2. check for duplicates
3. create field_changes
4. entity snapshot upsert
5. commit
```

If the same `deliveryId` already exists, acknowledge the message and stop:

```text
ACK
```

---

# 18. Remove Event Handling

Do not immediately DELETE snapshot rows when a Linear `remove` webhook arrives.

Use soft deletion.

Example:

```text
issues.deleted_at = occurredAt
```

Reasons:

- Reproduce historical weekly reports
- Preserve references from event history
- Allow deleted issues to appear in historical reports

Current-state MCP queries must use:

```sql
WHERE deleted_at IS NULL
```

---

# 19. Initial History Limitation

Initial sync does not backfill historical changes.

For example, if the service is installed on:

```text
2026-10-01
```

it may not know past assignee or state changes during:

```text
2026-09-01 ~ 2026-09-30
```

During initial sync, store:

```text
meta.tracking_started_at
```

If the period requested through MCP begins before tracking started, return:

```json
{
  "coverage": {
    "complete": false,
    "trackingStartedAt": "..."
  }
}
```

For a period after tracking started, return:

```json
{
  "coverage": {
    "complete": true,
    "trackingStartedAt": "..."
  }
}
```

---

# 20. Progress Definitions

Calculate project and milestone progress deterministically on the server.

## Eligible issue

Include only these issues in the denominator:

```text
deleted_at IS NULL
AND archived_at IS NULL
AND workflow_state.type != canceled
```

## Count progress

```text
completed issue count
────────────────────────
eligible issue count
```

Example:

```text
8 / 12 = 66.7%
```

## Estimate progress

When the total estimate is greater than zero:

```text
completed estimates
────────────────────────
total estimates
```

If the project does not use estimates, return:

```json
"estimateProgress": null
```

Do not assign an arbitrary one-point estimate to issues without an estimate.

## Status buckets

```text
backlog
unstarted
started
completed
canceled
```

Return a separate count for each of these status buckets.

---

# 21. Stale Work Definition

Flag issues that are currently `started` but have had no recent activity as stale candidates.

Default:

```text
STALE_ISSUE_DAYS=5
```

last activity:

```text
MAX(
    issue.updated_at,
    latest event occurred_at
)
```

Calculated result:

```json
{
  "stale": true,
  "daysSinceActivity": 8
}
```

The `stale` flag does not indicate a problem with the issue or poor performance by a team member.

It only means that no recent change was observed.

---

# 22. Member Resolution

MCP inputs can identify a member using any of the following:

```text
Linear user ID
email
display name
full name
```

Resolution order:

```text
exact ID
↓
exact email
↓
exact display name
↓
exact name
```

Do not use substring or fuzzy matching in the MVP.

If multiple users match, do not pick one arbitrarily.

Example:

```json
{
  "error": "AMBIGUOUS_MEMBER",
  "candidates": [
    {
      "id": "...",
      "name": "Alice Kim",
      "email": "..."
    }
  ]
}
```

---

# 23. Project / Milestone Resolution

Apply the same resolution principles.

Project:

```text
exact ID
exact name
```

Milestone:

```text
exact ID
exact name within resolved project
```

Do not automatically select an ambiguous match.

---

# 24. MCP Tools

The MVP MCP server provides exactly these six tools.

---

## 24.1 get_team_current_work

Retrieve the issues currently in progress for each team member.

Input:

```json
{
  "team": null,
  "includeStale": true
}
```

Schema:

```ts
{
  team?: string;
  includeStale?: boolean;
}
```

Definition of currently in progress:

```text
workflow_state.type = started
AND deleted_at IS NULL
AND assignee_id IS NOT NULL
```

Example output:

```json
{
  "generatedAt": "...",
  "members": [
    {
      "user": {
        "id": "...",
        "name": "Alice"
      },
      "issues": [
        {
          "id": "...",
          "identifier": "SHOP-123",
          "title": "Add guest checkout",
          "state": "In Progress",
          "project": "Storefront",
          "milestone": "Checkout",
          "priority": 2,
          "estimate": 3,
          "updatedAt": "...",
          "stale": false,
          "daysSinceActivity": 1,
          "url": "..."
        }
      ]
    }
  ]
}
```

---

# 24.2 get_member_activity

Retrieve a member's activity over a specified period.

Input:

```json
{
  "member": "alice@example.com",
  "from": "2026-09-21",
  "to": "2026-09-27"
}
```

Interpret `from` and `to` as calendar dates in `REPORT_TIMEZONE`.

Output:

```json
{
  "member": {},
  "period": {},
  "coverage": {},
  "completed": [],
  "started": [],
  "reopened": [],
  "assigned": [],
  "unassigned": [],
  "scopeChanges": [],
  "otherChanges": []
}
```

---

# 24.3 get_project_progress

Input:

```json
{
  "project": "Storefront"
}
```

Output:

```json
{
  "project": {
    "id": "...",
    "name": "Storefront",
    "startDate": "...",
    "targetDate": "..."
  },
  "issueCount": {
    "total": 20,
    "completed": 12,
    "started": 4,
    "unstarted": 3,
    "backlog": 1,
    "canceled": 2
  },
  "progress": {
    "byCount": 0.6,
    "byEstimate": 0.64
  },
  "milestones": []
}
```

Exclude `canceled` issues from the denominator, but return their count separately.

---

# 24.4 get_milestone_progress

Input:

```json
{
  "project": "Storefront",
  "milestone": "Checkout"
}
```

Output:

```json
{
  "project": {},
  "milestone": {},
  "issueCount": {},
  "progress": {
    "byCount": 0.75,
    "byEstimate": 0.81
  },
  "issues": {
    "completed": [],
    "started": [],
    "remaining": []
  }
}
```

---

# 24.5 get_changes

Retrieve Linear changes over a specified period.

Input:

```json
{
  "from": "2026-09-21",
  "to": "2026-09-27",
  "member": null,
  "project": null,
  "fields": [],
  "limit": 100
}
```

Supported field filters:

```text
assignee
state
project
project_milestone
priority
estimate
due_date
title
cycle
parent
```

`limit`:

```text
default = 100
max = 500
```

Output:

```json
{
  "period": {},
  "coverage": {},
  "changes": [
    {
      "occurredAt": "...",
      "issue": {
        "identifier": "SHOP-123",
        "title": "Add guest checkout"
      },
      "actor": {},
      "field": "state",
      "before": {
        "id": "...",
        "name": "In Progress"
      },
      "after": {
        "id": "...",
        "name": "Done"
      }
    }
  ]
}
```

Where possible, join snapshot tables to return human-readable names alongside IDs.

---

# 24.6 get_weekly_report

Return structured context and a deterministic Markdown draft for a weekly report.

Input:

```json
{
  "member": "alice@example.com",
  "week": "current"
}
```

Alternatively:

```json
{
  "member": "alice@example.com",
  "weekStart": "2026-09-21"
}
```

A week runs from:

```text
Monday 00:00
~
Sunday 23:59:59
```

Interpret these boundaries in `REPORT_TIMEZONE`.

Output:

```json
{
  "member": {},
  "period": {},
  "coverage": {},
  "summary": {
    "completedCount": 3,
    "startedCount": 2,
    "reopenedCount": 1,
    "scopeChangeCount": 2
  },
  "completed": [],
  "started": [],
  "reopened": [],
  "scopeChanges": [],
  "currentlyInProgress": [],
  "draftMarkdown": "..."
}
```

---

# 25. Weekly Report Semantics

## completed

Issues that had the following transition during the period:

```text
state
X → completed
```

---

## started

Issues that had the following transition during the period:

```text
backlog/unstarted → started
```

---

## reopened

These transitions count as reopened:

```text
completed → started
completed → unstarted
canceled → started
```

---

## scopeChanges

Issues where any of the following fields changed:

```text
project
project_milestone
priority
estimate
due_date
```

---

## currentlyInProgress

Issues matching the current snapshot conditions:

```text
assignee = member
state.type = started
```

The output must explicitly state that this is the **current state**, rather than historical state at the end of the report period:

```json
{
  "currentlyInProgressAsOf": "..."
}
```

---

# 26. Weekly Report Markdown

Do not call an LLM inside the server.

Generate deterministic Markdown using this template:

```markdown
## Completed

- SHOP-123 — Add guest checkout
- SHOP-124 — Show product availability

## Started

- SHOP-130 — Add cart quantity controls

## In progress

- SHOP-131 — Track order fulfillment

## Scope changes

- SHOP-132 — milestone: Catalog → Checkout
- SHOP-140 — estimate: 3 → 8
```

Omit a section if it has no items.

The MCP client may rewrite this draft in natural language.

---

# 27. Event Attribution

Where available, store the following on change events:

```text
actor_id
actor_name
actor_type
```

Note that:

```text
assignee = Alice
```

does not mean Alice made the change herself.

For example:

```text
Bob assigns an issue to Alice
```

Distinguish:

```text
actor
```

from:

```text
affected assignee
```

---

# 28. Member Activity Attribution

When calculating a member's weekly work, do not rely only on:

```text
actor_id = member
```

Example:

If SHOP-123 is assigned to Alice and changes to Done, it may count as Alice's work activity regardless of who changed its state.

Use the issue's assignee history in the MVP.

Determine the assignee at the time of the event as follows:

1. For an assignee-change event, use its before and after values.
2. Otherwise, use the most recent assignee change before that time.
3. If no history exists, fall back to the current snapshot's assignee and mark it with `inferred=true`.

Historical attribution may be incomplete for issues that predate tracking.

---

# 29. Error Contract

Do not expose raw exception text in MCP tool errors.

Common error format:

```json
{
  "error": {
    "code": "PROJECT_NOT_FOUND",
    "message": "Project not found",
    "details": {}
  }
}
```

Codes:

```text
MEMBER_NOT_FOUND
AMBIGUOUS_MEMBER

PROJECT_NOT_FOUND
AMBIGUOUS_PROJECT

MILESTONE_NOT_FOUND
AMBIGUOUS_MILESTONE

INVALID_DATE_RANGE

SYNC_NOT_READY

INTERNAL_ERROR
```

Keep internal database query and Linear API error details in server logs only.

---

# 30. Logging

Use structured JSON logging.

Example:

```json
{
  "level": "info",
  "event": "webhook_processed",
  "deliveryId": "...",
  "entityType": "Issue",
  "action": "update"
}
```

Do not log:

```text
LINEAR_API_KEY
LINEAR_WEBHOOK_SECRET
MCP_AUTH_TOKEN
ADMIN_AUTH_TOKEN
issue description
project update full body
```

---

# 31. Security

## Linear Webhook

Always perform:

```text
HMAC-SHA256 signature validation
timestamp validation
```

Verify the signature using the raw request body before parsing it.

Linear recommends raw-body verification because reserializing JSON can change the signature.

## MCP

Require a bearer token.

## Admin API

Use a separate admin token from the MCP token.

## Linear API

Implement read-only GraphQL queries only.

Do not implement mutations.

---

# 32. Privacy / Data Minimization

Store:

```text
Issue title
Issue metadata
User metadata
Project metadata
Milestone metadata
Partial Project Update content
Change history
```

Do not store:

```text
Issue description
Comment body
Attachment
Document
Reaction
raw webhook payload
```

Do not add permanent raw-payload storage for development or debugging.

---

# 33. Cloudflare Configuration

One Worker:

```text
linear-eye
```

Bindings:

```text
DB
LINEAR_EYE_QUEUE
```

D1 database:

```text
linear-eye
```

Queue:

```text
linear-eye-events
```

Use the current date at implementation time as the compatibility date.

---

# 34. Free Tier Constraints

Prioritize Cloudflare Workers Free in the design.

The design assumes Workers Free limits of 100,000 requests per day and 10 ms of CPU time per invocation. Verify current limits before deployment.

D1 Free:

```text
5,000,000 rows read / day
100,000 rows written / day
500 MB / database
```

The design assumes 10,000 operations per day and 24-hour message retention on Queues Free.

Follow these principles in the MVP:

```text
No polling loop
No full-table scan
No raw webhook archive
No comment ingest
Pagination-based sync
Indexed analytics queries
```

---

# 35. Repository Structure

Suggested structure:

```text
linear-eye/
├── src/
│   ├── index.ts
│   │
│   ├── env.ts
│   │
│   ├── auth/
│   │   ├── bearer.ts
│   │   └── webhook.ts
│   │
│   ├── linear/
│   │   ├── client.ts
│   │   ├── queries.ts
│   │   ├── types.ts
│   │   └── projection.ts
│   │
│   ├── queue/
│   │   ├── types.ts
│   │   ├── consumer.ts
│   │   ├── webhook-handler.ts
│   │   └── sync-handler.ts
│   │
│   ├── sync/
│   │   ├── full-sync.ts
│   │   ├── reconcile.ts
│   │   └── resources.ts
│   │
│   ├── db/
│   │   ├── users.ts
│   │   ├── teams.ts
│   │   ├── states.ts
│   │   ├── issues.ts
│   │   ├── projects.ts
│   │   ├── milestones.ts
│   │   ├── events.ts
│   │   └── sync-runs.ts
│   │
│   ├── intelligence/
│   │   ├── current-work.ts
│   │   ├── member-activity.ts
│   │   ├── progress.ts
│   │   ├── changes.ts
│   │   └── weekly-report.ts
│   │
│   ├── mcp/
│   │   ├── server.ts
│   │   ├── tools.ts
│   │   └── schemas.ts
│   │
│   └── routes/
│       ├── health.ts
│       ├── webhook.ts
│       └── admin.ts
│
├── migrations/
│   └── 0001_initial.sql
│
├── test/
│   ├── webhook.test.ts
│   ├── event-normalization.test.ts
│   ├── progress.test.ts
│   ├── weekly-report.test.ts
│   └── mcp.test.ts
│
├── wrangler.jsonc
├── package.json
├── tsconfig.json
└── README.md
```

---

# 36. Implementation Rules

Coding agents must follow these rules.

### Rule 1

Do not execute business queries in the webhook handler.

### Rule 2

Do not create a Linear API polling loop.

### Rule 3

Do not implement GraphQL mutations.

### Rule 4

Do not call the Linear API directly from an MCP tool.

All MCP queries use D1 data only.

### Rule 5

Do not add an LLM API dependency.

### Rule 6

Do not store issue descriptions or comments.

### Rule 7

Do not use fuzzy matching to select an arbitrary user.

### Rule 8

Webhook retries must be idempotent.

### Rule 9

Every report query returns tracking coverage.

### Rule 10

An unknown Linear webhook field must not cause the entire webhook to fail.

---

# 37. Testing Requirements

## Webhook verification

Test:

```text
valid signature → 200
invalid signature → 401
missing signature → 401
expired timestamp → 401
```

---

## Idempotency

Process an event twice with the same:

```text
Linear-Delivery
```

Expected result:

```text
events = 1
field_changes duplicated = 0
snapshot consistent
```

---

## State transition

Input:

```text
Todo → In Progress
```

Verify that this field change is created:

```text
field_changes.field_name = state
```

---

## Project progress

Data:

```text
Completed 6
Started 2
Unstarted 2
Canceled 1
```

expected:

```text
eligible = 10
completed = 6
byCount = 0.6
```

Exclude canceled issues from the denominator.

---

## Estimate progress

```text
Done: 3 + 5
Started: 5
Todo: 3
```

expected:

```text
8 / 16 = 0.5
```

---

## Weekly report

Create fixtures for the following transitions:

```text
A: Todo → Started
B: Started → Completed
C: Completed → Started
D: milestone Catalog → Checkout
```

expected:

```text
started contains A
completed contains B
reopened contains C
scopeChanges contains D
```

---

## Coverage

tracking start:

```text
2026-09-01
```

query:

```text
2026-08-01 ~ 2026-08-07
```

expected:

```json
{
  "complete": false
}
```

---

# 38. Observability

At minimum, the following metrics must be observable through logs:

```text
webhook received
webhook rejected
webhook processed
duplicate webhook

sync started
sync completed
sync failed

GraphQL page fetched
GraphQL error

MCP tool called
MCP tool failed
```

Do not store the full question text in MCP logs.

Record only information such as the tool name and latency.

---

# 39. README Requirements

The README must include at least:

```text
What is linear-eye?
Architecture
Prerequisites

Local development

Create D1 database
Create Queue
Run migrations

Configure Linear API key
Configure Linear webhook

Set Cloudflare secrets

Run initial sync

Run locally

Deploy

Connect MCP client

Available MCP tools

Known limitations
```

Also specify which resources to subscribe to when configuring the Linear webhook.

---

# 40. Setup Flow

Users should follow this setup flow:

```text
1. Clone repository

2. pnpm install

3. Create a Cloudflare D1 database

4. Create the queue

5. Apply migrations

6. Set Cloudflare secrets

   LINEAR_API_KEY
   LINEAR_WEBHOOK_SECRET
   MCP_AUTH_TOKEN
   ADMIN_AUTH_TOKEN

7. Deploy the Worker

8. Create a webhook in Linear

   URL:
   https://<worker>/webhooks/linear

   resources:
   Issue
   Project
   ProjectUpdate
   User

9. POST /admin/sync

10. Confirm that sync completed

11. Connect an MCP client

   https://<worker>/mcp

12. Run an MCP query
```

---

# 41. MVP Acceptance Scenarios

## Scenario A — Current work

Linear state:

```text
Alice
  SHOP-10 In Progress
  SHOP-11 Todo

Bob
  SHOP-20 In Progress
```

Question:

```text
What is each team member currently working on?
```

The MCP result must include:

```text
Alice → SHOP-10
Bob   → SHOP-20
```

Exclude SHOP-11.

---

## Scenario B — Project Progress

```text
Storefront

Done        6
In Progress 2
Todo        2
Canceled    1
```

Result:

```text
progress by count = 60%
```

---

## Scenario C — Changes

SHOP-123:

```text
Monday
Todo → In Progress

Wednesday
Alice → Bob

Friday
Checkout → Launch
```

Question:

```text
What changed on SHOP-123 this week?
```

Return all three changes in chronological order.

---

## Scenario D — Weekly Report

If Alice's work this week includes:

```text
SHOP-1 completed
SHOP-2 started
SHOP-3 estimate 3 → 8
SHOP-4 currently in progress
```

the weekly report context must place all four items in the appropriate categories.

---

# 42. Definition of Done

The MVP is complete when all of the following are true:

- It can be deployed as a Cloudflare Worker.
- D1 migrations are reproducible from an empty database.
- Initial sync through the Linear API works.
- Issue snapshots are created.
- Project snapshots are created.
- Milestone snapshots are created.
- User and workflow-state snapshots are created.
- Linear webhook signatures are verified.
- Webhook events are processed through the queue.
- Webhook retries do not create duplicate events.
- Issue changes are stored in `field_changes`.
- Webhooks update snapshots.
- Daily reconciliation is available.
- MCP requires bearer authentication.
- All six MCP tools are implemented.
- Current work can be queried.
- Project progress can be queried.
- Milestone progress can be queried.
- Changes can be queried by period.
- Member activity can be queried.
- Weekly report context can be generated.
- Weekly report Markdown drafts can be generated.
- All reports return coverage information.
- Core domain logic has unit tests.
- A user can deploy to a new environment using only the README.

---

# 43. Implementation Priority

Implement in this order:

```text
Phase 1
Cloudflare Worker skeleton
D1
migration
health endpoint

↓

Phase 2
Linear GraphQL client
initial sync
snapshot tables

↓

Phase 3
Webhook verification
Queue
event ingestion
field_changes

↓

Phase 4
reconciliation

↓

Phase 5
intelligence queries

current work
progress
changes
member activity
weekly report

↓

Phase 6
MCP server

↓

Phase 7
tests
README
deployment verification
```

Do not start with MCP.

Complete data collection and the deterministic intelligence layer first.

---

# 44. Architectural Boundary

Maintain this dependency direction:

```text
HTTP / Webhook
      │
      ▼
Application
      │
      ▼
Domain / Intelligence
      │
      ▼
Repository
      │
      ▼
D1
```

MCP contains no separate business logic.

```text
MCP Tool
   ↓
Intelligence Service
   ↓
Repository
```

Use this call flow.

Apply the same boundary to webhooks:

```text
Queue Consumer
   ↓
Ingestion Service
   ↓
Repository
```

---

# 45. Future Extensions

The following features can be added after the MVP:

```text
stale issue detection
blocked dependency detection
scope creep detection
reopened issue analysis
priority churn
estimate churn
assignee churn

milestone scope movement

unplanned work detection

project weekly digest
team weekly digest

Slack weekly report
scheduled report

GitHub PR correlation

Linear Comment intelligence

OAuth multi-workspace

web dashboard
```

Keeping the `snapshot + field_changes` structure should make it possible to answer questions such as:

```text
How much has the scope of this milestone increased?

Which issues had large estimate increases this month?

Which completed issues were reopened?

Which issues frequently changed assignee over the past two weeks?

Which issues have been in progress with no changes for at least five days?

How has project progress changed since last week?
```

These features should be possible without major changes to the MVP schema.

---

# 46. Product Principle

`linear-eye` is not a system for evaluating team members.

Its purpose is not to judge:

```text
Who is doing poorly?
```

It should help the team quickly answer:

```text
What is happening?
What changed?
What is currently in progress?
Where is work accumulating?
What should the team know?
```

MCP outputs should therefore return observable facts wherever possible, without assigning scores to individual performance or ability.

---

# 47. Final MVP Architecture

```text
                    LINEAR

       ┌──────────────┴──────────────┐
       │                             │
   Webhooks                      GraphQL
       │                             │
       ▼                             │
/webhooks/linear                     │
       │                             │
HMAC + timestamp                     │
       │                             │
       └────────────┬────────────────┘
                    ▼
             Cloudflare Queue
                    │
                    ▼
                Consumer
                    │
          ┌─────────┴─────────┐
          │                   │
       Snapshot             Events
          │                   │
          └─────────┬─────────┘
                    ▼
                    D1
                    │
                    ▼
             Intelligence Layer
                    │
      ┌─────────────┼─────────────┐
      │             │             │
 Current Work    Progress       Changes
      │             │             │
      └─────────────┼─────────────┘
                    │
             Weekly Activity
                    │
                    ▼
                   MCP
                    │
                    ▼
        ChatGPT / Claude / Agents
```

The implementation should optimize for:

```text
simple
deterministic
read-only
cheap
observable
recoverable
```

over architectural complexity.

The MVP should remain deployable entirely on Cloudflare's free-tier-oriented stack without requiring a separate server.
