# linear-eye — MVP Specification

## 1. Overview

`linear-eye`는 Linear의 현재 상태와 변경 이력을 수집하고, 이를 분석 가능한 형태로 저장한 뒤 MCP(Model Context Protocol)를 통해 팀의 업무 현황에 대한 intelligence를 제공하는 서버다.

이 프로젝트가 해결하려는 핵심 문제는 다음과 같다.

- PM / PO가 없는 개발팀에서 팀원별 현재 진행 업무를 파악하기 어렵다.
- Linear Project / Milestone의 실제 진행도를 매번 직접 확인해야 한다.
- 지난 며칠 또는 지난주 동안 무엇이 변경되었는지 추적하기 어렵다.
- 주간 보고를 팀원들이 수기로 작성해야 한다.
- Linear 자체에는 현재 상태는 있지만 시간축 기반 분석이 제한적이다.

`linear-eye`는 Linear를 대체하지 않는다.

Linear를 **source of truth**로 유지하면서 그 위에 다음 계층을 추가한다.

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

MVP는 **read-only intelligence service**다.

Linear의 Issue, Project 등을 수정하는 기능은 제공하지 않는다.

---

# 2. Goals

MVP는 다음 질문에 답할 수 있어야 한다.

### Team activity

```text
현재 팀원들은 각각 어떤 이슈를 진행하고 있어?
```

### Member activity

```text
Alice가 이번 주에 어떤 업무를 했어?
```

### Project progress

```text
Custody 프로젝트 진행도가 어떻게 돼?
```

### Milestone progress

```text
Custody 프로젝트의 Beta milestone 진행도 알려줘.
```

### Changes

```text
지난주 동안 Linear에서 주요 변경 사항이 뭐였어?
```

```text
이번 주에 milestone이 변경된 이슈 알려줘.
```

### Weekly report

```text
Alice의 이번 주 주간 보고 초안을 만들어줘.
```

MVP 완료 후 MCP client가 위 질문을 별도의 Linear API 호출 없이 `linear-eye` 데이터만 이용해 답할 수 있어야 한다.

---

# 3. Non-goals

다음 기능은 MVP 범위에서 제외한다.

- Linear Issue 생성
- Linear Issue 수정
- Linear Comment 작성
- Project 수정
- OAuth 기반 다중 workspace 지원
- 웹 대시보드
- Slack integration
- GitHub integration
- 자체 LLM 호출
- 개인 생산성 점수 산출
- 팀원 ranking
- 업무량 평가
- velocity 예측
- 일정 완료 시점 AI 예측
- 자연어 → Linear mutation
- Linear comment 전체 ingest
- Linear issue description 전체 ingest
- historical Linear activity 전체 backfill

MVP는 단일 Linear Workspace를 대상으로 한다.

---

# 4. Design Principles

## 4.1 Linear is the source of truth

현재 상태의 canonical source는 Linear다.

`linear-eye`의 데이터는 Linear를 분석하기 위한 projection/cache다.

데이터 불일치가 발생했을 경우 Linear 상태를 우선한다.

---

## 4.2 Snapshot + Event History

현재 상태와 변경 이력은 분리한다.

```text
Snapshot
────────────
현재 누가 무엇을 하고 있는가?

Event History
────────────
언제 무엇이 어떻게 바뀌었는가?
```

예:

```text
issues
  PAY-123
  state = Done
  assignee = Alice
```

와 별도로:

```text
field_changes

PAY-123
Todo → In Progress

PAY-123
Alice → Bob

PAY-123
In Progress → Done
```

을 저장한다.

---

## 4.3 Webhook first, GraphQL reconciliation second

변경 사항 수집은 Linear Webhook을 primary mechanism으로 사용한다.

GraphQL API는 다음 용도로만 사용한다.

- 최초 bootstrap
- periodic reconciliation
- webhook으로 얻기 어려운 metadata 동기화
- webhook 유실 복구

주기적 polling으로 Linear 전체를 지속적으로 조회하지 않는다.

Linear 역시 업데이트 감지에는 polling 대신 webhook 사용을 권장한다.

---

## 4.4 Intelligence must be deterministic

MVP 서버 내부에서 LLM을 호출하지 않는다.

예:

```text
get_weekly_report()
```

의 결과는 AI가 생성한 문장이 아니라 다음과 같은 사실 데이터다.

```json
{
  "completed": [],
  "started": [],
  "reopened": [],
  "scopeChanges": [],
  "currentlyInProgress": []
}
```

필요하다면 deterministic Markdown draft도 함께 반환할 수 있다.

최종 자연어 요약은 MCP를 호출하는 ChatGPT / Claude가 수행한다.

이 구조를 통해:

- Cloudflare 무료 운영 가능
- hallucination 최소화
- 분석 결과 근거 추적 가능
- LLM vendor dependency 제거

를 달성한다.

---

# 5. Technology Stack

## Runtime

- TypeScript
- Cloudflare Workers
- Node.js application server 사용 금지
- 별도 container 사용 금지

## Storage

- Cloudflare D1

KV를 primary database로 사용하지 않는다.

현재 필요한 query는 다음과 같이 relational workload에 가깝다.

```sql
WHERE assignee_id = ?
WHERE project_id = ?
WHERE occurred_at BETWEEN ? AND ?
GROUP BY assignee
GROUP BY state
```

따라서 D1을 사용한다.

## Queue

Cloudflare Queues를 사용한다.

목적:

- Webhook 응답 latency 최소화
- Webhook ingestion과 DB mutation 분리
- retry 지원
- initial/reconciliation sync pagination 처리

## MCP

현재 Cloudflare의 stateless MCP 방식을 사용한다.

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

Cloudflare는 현재 신규 MCP 서버에 `createMcpHandler()` 기반 stateless Streamable HTTP 구성을 제공한다.

## Database access

ORM을 사용하지 않는다.

Cloudflare D1 Worker Binding API와 SQL migration을 직접 사용한다.

목표:

- bundle 최소화
- query cost 명확화
- D1-specific optimization 용이
- schema 단순화

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

하나의 Cloudflare Worker 프로젝트에서 다음 handler를 모두 제공한다.

```text
fetch()
queue()
scheduled()
```

별도의 microservice로 분리하지 않는다.

---

# 7. HTTP Endpoints

## 7.1 Health

```http
GET /health
```

Authentication 없음.

Response:

```json
{
  "status": "ok",
  "service": "linear-eye"
}
```

DB health check는 하지 않는다.

health request마다 D1 read를 발생시키지 않기 위함이다.

---

## 7.2 Linear Webhook

```http
POST /webhooks/linear
```

Linear webhook 전용 endpoint.

처리 순서:

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

Linear webhook signature는 raw HTTP body에 대한 HMAC-SHA256으로 검증한다.

검증 대상:

```text
Linear-Signature
Linear-Timestamp
```

다음 조건을 만족하지 않으면 `401`.

```text
abs(now - webhookTimestamp) <= 60 seconds
```

중복 처리 식별자는:

```text
Linear-Delivery
```

를 사용한다.

Linear는 각 webhook payload에 고유 `Linear-Delivery` UUID를 전달하고, webhook handler가 5초 안에 HTTP 200을 반환하지 못하면 재시도한다.

Webhook endpoint에서는 D1 write를 직접 수행하지 않는다.

Queue enqueue까지만 수행한다.

---

## 7.3 MCP

```http
POST /mcp
GET /mcp
```

Cloudflare `createMcpHandler()`를 사용한다.

Authentication:

```http
Authorization: Bearer <MCP_AUTH_TOKEN>
```

인증 실패:

```http
401 Unauthorized
```

MCP는 internet에 anonymous로 공개하지 않는다.

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

실제 sync는 HTTP request 안에서 수행하지 않는다.

Queue에 첫 번째 sync job을 enqueue한다.

---

## 7.5 Reconciliation

```http
POST /admin/reconcile
```

Body:

```json
{}
```

Queue 기반 incremental reconciliation을 시작한다.

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

API key 및 token을 `wrangler.jsonc`에 직접 기록하지 않는다.

Cloudflare secrets를 사용한다.

---

# 9. Linear Webhook Subscription

MVP에서는 다음 resource를 구독한다.

```text
Issue
Project
ProjectUpdate
User
```

필요하다면 향후:

```text
Cycle
IssueLabel
Comment
```

를 추가한다.

Comment는 MVP에서 ingest하지 않는다.

Issue description 또한 저장하지 않는다.

Linear의 data change webhook은 `create`, `update`, `remove` 이벤트를 제공하며 update 이벤트에는 이전 값이 `updatedFrom`으로 포함된다.

---

# 10. Queue Message Types

Queue에는 discriminated union을 사용한다.

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

`data`는 원본 webhook 전체를 넣지 않는다.

entity별 projection을 적용한다.

Issue에서 허용하는 필드 예:

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

description은 제거한다.

알 수 없는 필드는 snapshot에는 저장하지 않는다.

단 `updatedFrom`에 포함된 변경 field는 field change history 생성을 위해 사용할 수 있다.

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

한 Queue consumer invocation은 한 GraphQL page만 처리한다.

다음 page가 있으면 동일 resource의 다음 cursor를 enqueue한다.

마지막 page라면 다음 resource를 enqueue한다.

---

# 11. Sync Order

Full sync 순서는 다음과 같다.

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

각 resource는 Relay pagination을 사용한다.

```text
first: 50
after: cursor
```

Linear API는 cursor 기반 pagination을 사용하며 `pageInfo.hasNextPage`와 `endCursor`를 제공한다.

Milestone query의 정확한 GraphQL collection field는 구현 시 현재 Linear GraphQL schema를 introspection해서 확인한다.

workspace-level milestone collection이 없으면:

```text
projects
  → project
     → projectMilestones
```

형태로 traverse한다.

문서에 없는 operation 이름을 추측해서 hardcode하지 않는다.

---

# 12. Reconciliation Strategy

Webhook delivery만으로 데이터 정합성을 100% 가정하지 않는다.

하루 1회 GraphQL reconciliation을 수행한다.

Cloudflare Cron:

```text
18:00 UTC
```

즉:

```text
03:00 Asia/Seoul
```

정도로 실행한다.

Reconciliation 대상:

```text
users
workflow_states
projects
project_milestones
issues
```

가능하다면 `updatedAt >= watermark` filter를 사용한다.

현재 GraphQL schema에서 해당 filter가 지원되지 않을 경우:

```text
orderBy: updatedAt
```

descending 결과를 가져오고 watermark 이전 데이터가 나오면 pagination을 중단한다.

Linear 문서도 최근 변경 데이터를 가져와야 할 경우 `updatedAt` 정렬 사용을 안내한다.

Reconciliation은 snapshot만 복구한다.

Webhook을 놓쳐 발생한 중간 event history까지 가짜로 생성하지 않는다.

예:

```text
실제 변경

A → B → C

Webhook에서 B 이벤트 유실
```

Reconciliation 결과:

```text
current snapshot = C
```

까지는 복원하지만:

```text
A → B
B → C
```

라는 history를 만들어내지 않는다.

---

# 13. Database Schema

모든 timestamp는 UTC ISO-8601 string으로 저장한다.

예:

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

사용 key:

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

`type`은 Linear workflow state의 semantic type을 저장한다.

예:

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

`body`는 최대:

```text
PROJECT_UPDATE_BODY_LIMIT
```

까지만 저장한다.

기본값:

```text
8000 characters
```

---

# 14. Event Storage

## events

Webhook 하나당 event 하나를 생성한다.

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

`id`는 `Linear-Delivery`를 사용한다.

따라서 webhook retry가 발생하더라도 동일 event가 중복 저장되지 않는다.

`source`:

```text
webhook
```

MVP에서는 reconcile 결과를 event로 기록하지 않는다.

---

## field_changes

하나의 update webhook에서 변경된 필드별 row를 저장한다.

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

`old_value`, `new_value`는 canonical JSON representation을 사용한다.

예:

```text
"abc-user-id"
3
null
```

ID 생성:

```text
${eventId}:${fieldName}
```

한 webhook에서 동일 field는 한 번만 변경된다고 가정한다.

---

# 15. Field normalization

Issue에서 다음 필드는 canonical field name으로 변환한다.

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

알 수 없는 변경 필드는:

```text
linear.<originalFieldName>
```

으로 저장한다.

예:

```text
linear.fooBar
```

이를 통해 Linear에서 새로운 field가 추가되어도 변경 history를 완전히 버리지 않는다.

---

# 16. Indexes

최소 다음 index를 생성한다.

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

D1 Free는 현재 하루 5M rows read / 100K rows written 한도를 가지고 있고, 2026-09-01부터 이 daily limit 초과 시 query 자체가 실패한다. 따라서 full table scan을 피하도록 index를 필수로 구성한다.

---

# 17. Webhook Processing

Queue consumer는 webhook message를 다음 순서로 처리한다.

```text
1. events INSERT OR IGNORE
2. duplicate 여부 확인
3. field_changes 생성
4. entity snapshot upsert
5. commit
```

동일 `deliveryId`가 이미 존재하면:

```text
ACK
```

하고 종료한다.

---

# 18. Remove Event Handling

Linear `remove` webhook을 받았다고 snapshot row를 즉시 DELETE하지 않는다.

soft-delete한다.

예:

```text
issues.deleted_at = occurredAt
```

이유:

- 과거 주간 보고 재현
- event history reference 유지
- 삭제된 issue가 과거 report에 등장할 수 있음

MCP의 현재 상태 query에서는:

```sql
WHERE deleted_at IS NULL
```

조건을 사용한다.

---

# 19. Initial History Limitation

Initial sync는 과거 변경 이력을 backfill하지 않는다.

예를 들어 서비스를:

```text
2026-10-01
```

에 설치했다면:

```text
2026-09-01 ~ 2026-09-30
```

의 과거 assignee/state change를 알 수 없을 수 있다.

Initial sync 시:

```text
meta.tracking_started_at
```

을 저장한다.

MCP에서 요청 기간이 이보다 이전이면 결과에:

```json
{
  "coverage": {
    "complete": false,
    "trackingStartedAt": "..."
  }
}
```

를 반환한다.

tracking 시작 이후 기간은:

```json
{
  "coverage": {
    "complete": true,
    "trackingStartedAt": "..."
  }
}
```

로 반환한다.

---

# 20. Progress Definitions

Project / Milestone 진행률은 서버에서 deterministic하게 계산한다.

## Eligible issue

다음 issue만 denominator에 포함한다.

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

예:

```text
8 / 12 = 66.7%
```

## Estimate progress

estimate 합계가 0보다 클 때:

```text
completed estimates
────────────────────────
total estimates
```

estimate가 사용되지 않는 프로젝트라면:

```json
"estimateProgress": null
```

을 반환한다.

estimate 없는 issue를 임의로 1 point로 계산하지 않는다.

## Status buckets

```text
backlog
unstarted
started
completed
canceled
```

별 count를 반환한다.

---

# 21. Stale Work Definition

현재 `started` 상태인데 마지막 activity가 오래된 issue를 stale 후보로 표시한다.

기본값:

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

계산 결과:

```json
{
  "stale": true,
  "daysSinceActivity": 8
}
```

단 `stale`은 Issue가 잘못되었다거나 팀원의 성과가 낮다는 평가가 아니다.

단순히 최근 변경이 없었다는 사실만 의미한다.

---

# 22. Member Resolution

MCP input에서 사용자는 다음 중 하나를 사용할 수 있다.

```text
Linear user ID
email
display name
full name
```

resolution 순서:

```text
exact ID
↓
exact email
↓
exact display name
↓
exact name
```

부분 문자열 fuzzy matching은 MVP에서 하지 않는다.

여러 사용자가 매칭되면 임의로 선택하지 않는다.

예:

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

동일한 원칙을 사용한다.

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

ambiguous한 경우 자동 선택하지 않는다.

---

# 24. MCP Tools

MVP MCP server는 정확히 다음 6개의 tool을 제공한다.

---

## 24.1 get_team_current_work

현재 팀원별 진행 중 issue 조회.

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

현재 진행 중의 정의:

```text
workflow_state.type = started
AND deleted_at IS NULL
AND assignee_id IS NOT NULL
```

Output 예:

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
          "identifier": "PAY-123",
          "title": "...",
          "state": "In Progress",
          "project": "Custody",
          "milestone": "Beta",
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

특정 팀원의 기간별 activity 조회.

Input:

```json
{
  "member": "alice@example.com",
  "from": "2026-09-21",
  "to": "2026-09-27"
}
```

`from`, `to`는 `REPORT_TIMEZONE` 기준 calendar date로 해석한다.

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
  "project": "Custody"
}
```

Output:

```json
{
  "project": {
    "id": "...",
    "name": "Custody",
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

`canceled` issue는 denominator에서 제외하되 별도 count로 반환한다.

---

# 24.4 get_milestone_progress

Input:

```json
{
  "project": "Custody",
  "milestone": "Beta"
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

기간 동안 발생한 Linear 변경 조회.

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

지원 field filter:

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
        "identifier": "PAY-123",
        "title": "..."
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

가능한 경우 ID만 반환하지 말고 snapshot table을 join해서 human-readable name을 함께 반환한다.

---

# 24.6 get_weekly_report

주간 보고를 위한 structured context와 deterministic Markdown 초안을 반환한다.

Input:

```json
{
  "member": "alice@example.com",
  "week": "current"
}
```

또는:

```json
{
  "member": "alice@example.com",
  "weekStart": "2026-09-21"
}
```

한 주는:

```text
Monday 00:00
~
Sunday 23:59:59
```

`REPORT_TIMEZONE` 기준이다.

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

기간 안에:

```text
state
X → completed
```

전환이 있었던 issue.

---

## started

기간 안에:

```text
backlog/unstarted → started
```

전환이 있었던 issue.

---

## reopened

다음 형태:

```text
completed → started
completed → unstarted
canceled → started
```

---

## scopeChanges

다음 field 중 하나가 변경된 issue.

```text
project
project_milestone
priority
estimate
due_date
```

---

## currentlyInProgress

현재 snapshot 기준:

```text
assignee = member
state.type = started
```

인 issue.

이는 report period 종료 시점의 historical 상태가 아니라 **현재 상태**임을 output에 명시한다.

```json
{
  "currentlyInProgressAsOf": "..."
}
```

---

# 26. Weekly Report Markdown

서버 내부에서 LLM을 호출하지 않는다.

다음 template으로 deterministic Markdown을 생성한다.

```markdown
## 완료

- PAY-123 — ...
- PAY-124 — ...

## 진행 시작

- PAY-130 — ...

## 진행 중

- PAY-131 — ...

## 주요 변경

- PAY-132 — milestone: Alpha → Beta
- PAY-140 — estimate: 3 → 8
```

해당 section에 항목이 없다면 section 자체를 생략한다.

MCP client는 이 초안을 자연어로 다시 작성할 수 있다.

---

# 27. Event Attribution

변경 event에는 가능하면:

```text
actor_id
actor_name
actor_type
```

을 저장한다.

주의:

```text
assignee = Alice
```

라고 해서 Alice가 해당 변경을 직접 수행했다고 가정하면 안 된다.

예:

```text
Bob이 Alice에게 issue assign
```

일 수 있다.

따라서:

```text
actor
```

와:

```text
affected assignee
```

를 구분한다.

---

# 28. Member Activity Attribution

팀원의 주간 업무를 계산할 때 단순히:

```text
actor_id = member
```

만 사용하지 않는다.

예:

Alice에게 할당된 PAY-123이 Done으로 변경된 경우, 누가 state 변경을 수행했든 Alice의 업무 activity에 포함될 수 있다.

MVP에서는 issue의 assignee history를 이용한다.

Event 시점의 assignee 판단:

1. assignee field 변경 event인 경우 before/after 이용
2. 그 외에는 해당 시점 직전 최신 assignee change 이용
3. history가 없으면 current snapshot assignee를 fallback으로 사용하되 `inferred=true` 표시

tracking 시작 이전 issue에서는 historical attribution이 불완전할 수 있다.

---

# 29. Error Contract

MCP tool error는 exception text를 그대로 노출하지 않는다.

공통 error format:

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

DB query 및 Linear API 내부 오류 상세는 server log로만 남긴다.

---

# 30. Logging

structured JSON logging을 사용한다.

예:

```json
{
  "level": "info",
  "event": "webhook_processed",
  "deliveryId": "...",
  "entityType": "Issue",
  "action": "update"
}
```

다음 항목을 log하지 않는다.

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

반드시:

```text
HMAC-SHA256 signature validation
timestamp validation
```

을 수행한다.

raw request body를 parsing 전에 signature 검증에 사용한다.

Linear는 JSON을 다시 stringify하면 signature가 달라질 수 있으므로 raw body 검증을 권장한다.

## MCP

Bearer token 필수.

## Admin API

MCP token과 별도 admin token 사용.

## Linear API

read-only GraphQL query만 구현한다.

mutation을 작성하지 않는다.

---

# 32. Privacy / Data Minimization

저장 대상:

```text
Issue title
Issue metadata
User metadata
Project metadata
Milestone metadata
Project Update 일부
Change history
```

저장하지 않는 대상:

```text
Issue description
Comment body
Attachment
Document
Reaction
raw webhook payload
```

개발 중 debugging 목적으로 raw payload를 영구 저장하는 기능을 추가하지 않는다.

---

# 33. Cloudflare Configuration

하나의 Worker:

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

Compatibility date는 구현 시 현재 날짜를 사용한다.

---

# 34. Free Tier Constraints

설계는 Cloudflare Workers Free를 우선 대상으로 한다.

현재 Workers Free는 하루 100,000 requests와 invocation당 10ms CPU time 제한을 가진다.

D1 Free:

```text
5,000,000 rows read / day
100,000 rows written / day
500 MB / database
```

이다.

Queues Free는 하루 10,000 operations를 제공하며 Free plan message retention은 24시간이다.

따라서 MVP에서 다음 원칙을 지킨다.

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

권장 구조:

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

코딩 에이전트는 다음 규칙을 따라야 한다.

### Rule 1

Webhook handler에서는 business query를 실행하지 않는다.

### Rule 2

Linear API polling loop를 만들지 않는다.

### Rule 3

GraphQL mutation을 구현하지 않는다.

### Rule 4

MCP tool 안에서 Linear API를 직접 호출하지 않는다.

모든 MCP query는 D1 데이터만 사용한다.

### Rule 5

LLM API dependency를 추가하지 않는다.

### Rule 6

Issue description과 comment를 저장하지 않는다.

### Rule 7

임의의 사용자를 fuzzy match해서 선택하지 않는다.

### Rule 8

Webhook retry에 대해 idempotent해야 한다.

### Rule 9

모든 report query는 tracking coverage를 반환한다.

### Rule 10

알 수 없는 Linear webhook field가 들어와도 webhook 전체가 실패해서는 안 된다.

---

# 37. Testing Requirements

## Webhook verification

테스트:

```text
valid signature → 200
invalid signature → 401
missing signature → 401
expired timestamp → 401
```

---

## Idempotency

동일:

```text
Linear-Delivery
```

event를 두 번 처리한다.

결과:

```text
events = 1
field_changes duplicated = 0
snapshot consistent
```

이어야 한다.

---

## State transition

입력:

```text
Todo → In Progress
```

결과:

```text
field_changes.field_name = state
```

이 생성되는지 확인한다.

---

## Project progress

데이터:

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

Canceled는 denominator에서 제외한다.

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

다음 transition fixture를 생성한다.

```text
A: Todo → Started
B: Started → Completed
C: Completed → Started
D: milestone Alpha → Beta
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

최소 다음 metric을 로그 기반으로 확인 가능해야 한다.

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

MCP log에는 질문 내용 전체를 저장하지 않는다.

tool name과 latency 정도만 기록한다.

---

# 39. README Requirements

README에는 최소 다음 내용이 포함되어야 한다.

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

Linear webhook 설정 시 구독해야 하는 resource도 명시한다.

---

# 40. Setup Flow

실제 사용자가 따라야 하는 설치 흐름은 다음이어야 한다.

```text
1. Clone repository

2. pnpm install

3. Cloudflare D1 생성

4. Queue 생성

5. migrations 적용

6. Cloudflare secrets 등록

   LINEAR_API_KEY
   LINEAR_WEBHOOK_SECRET
   MCP_AUTH_TOKEN
   ADMIN_AUTH_TOKEN

7. Worker deploy

8. Linear에서 webhook 생성

   URL:
   https://<worker>/webhooks/linear

   resources:
   Issue
   Project
   ProjectUpdate
   User

9. POST /admin/sync

10. Sync completed 확인

11. MCP client에 연결

   https://<worker>/mcp

12. MCP query 실행
```

---

# 41. MVP Acceptance Scenarios

## Scenario A — Current work

Linear 상태:

```text
Alice
  PAY-10 In Progress
  PAY-11 Todo

Bob
  PAY-20 In Progress
```

질문:

```text
현재 팀원들이 어떤 일을 하고 있어?
```

MCP 결과에는:

```text
Alice → PAY-10
Bob   → PAY-20
```

가 포함되어야 한다.

PAY-11은 제외되어야 한다.

---

## Scenario B — Project Progress

```text
Custody

Done        6
In Progress 2
Todo        2
Canceled    1
```

결과:

```text
progress by count = 60%
```

---

## Scenario C — Changes

PAY-123:

```text
Monday
Todo → In Progress

Wednesday
Alice → Bob

Friday
Beta → GA
```

질문:

```text
이번 주 PAY-123에 무슨 변화가 있었어?
```

세 변경이 시간 순서대로 반환되어야 한다.

---

## Scenario D — Weekly Report

Alice가 이번 주:

```text
PAY-1 completed
PAY-2 started
PAY-3 estimate 3 → 8
PAY-4 currently in progress
```

이었다면 weekly report context에 네 항목이 적절한 category로 나타나야 한다.

---

# 42. Definition of Done

MVP는 다음 조건을 모두 만족할 때 완료된 것으로 간주한다.

- Cloudflare Worker에 실제 deploy 가능하다.
- D1 migration이 처음부터 재현 가능하다.
- Linear API initial sync가 동작한다.
- Issue snapshot이 생성된다.
- Project snapshot이 생성된다.
- Milestone snapshot이 생성된다.
- User / Workflow State snapshot이 생성된다.
- Linear webhook signature가 검증된다.
- Webhook event가 Queue를 통해 처리된다.
- Webhook retry가 중복 event를 만들지 않는다.
- Issue 변경이 `field_changes`에 저장된다.
- Snapshot이 webhook에 따라 갱신된다.
- Daily reconciliation이 가능하다.
- MCP가 bearer authentication을 요구한다.
- 6개 MCP tool이 모두 구현된다.
- Current work 조회가 가능하다.
- Project progress 조회가 가능하다.
- Milestone progress 조회가 가능하다.
- 기간별 change 조회가 가능하다.
- Member activity 조회가 가능하다.
- Weekly report context 생성이 가능하다.
- Weekly report Markdown draft 생성이 가능하다.
- 모든 report가 coverage 정보를 반환한다.
- 핵심 domain logic에 unit test가 존재한다.
- README만 보고 새 환경에 deploy할 수 있다.

---

# 43. Implementation Priority

구현은 다음 순서로 진행한다.

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

MCP부터 먼저 구현하지 않는다.

데이터 수집과 deterministic intelligence layer를 먼저 완성한다.

---

# 44. Architectural Boundary

최종 dependency 방향은 다음을 유지한다.

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

MCP는 별도의 business logic을 가지지 않는다.

```text
MCP Tool
   ↓
Intelligence Service
   ↓
Repository
```

형태로 동작한다.

Webhook에서도 동일하다.

```text
Queue Consumer
   ↓
Ingestion Service
   ↓
Repository
```

---

# 45. Future Extensions

MVP 이후 자연스럽게 추가할 수 있는 기능은 다음과 같다.

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

특히 `snapshot + field_changes` 구조를 유지하면 이후 다음과 같은 질문도 지원할 수 있다.

```text
이번 milestone에서 scope가 얼마나 증가했어?

이번 달에 estimate가 크게 증가한 이슈는?

완료됐다가 reopen된 이슈는?

최근 2주 동안 담당자가 자주 변경된 이슈는?

5일 이상 진행 상태에서 변경이 없는 이슈는?

지난주 대비 프로젝트 진행도가 어떻게 바뀌었어?
```

이러한 기능은 MVP schema를 크게 변경하지 않고 추가할 수 있어야 한다.

---

# 46. Product Principle

`linear-eye`는 팀원을 평가하는 시스템이 아니다.

목적은:

```text
Who is doing poorly?
```

를 판단하는 것이 아니라:

```text
What is happening?
What changed?
What is currently in progress?
Where is work accumulating?
What should the team know?
```

에 빠르게 답하는 것이다.

따라서 MCP output은 가능한 한 관찰 가능한 사실을 반환해야 하며, 개인의 성과나 업무 능력을 자체적으로 점수화하지 않는다.

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