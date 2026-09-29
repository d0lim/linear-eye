응. **`linear-eye`는 Effect TS를 쓰기에 꽤 적합한 프로젝트**라고 봐. 오히려 단순 CRUD 서버보다 Effect의 장점이 잘 드러나는 구조야.

특히 이 프로젝트는 경계가 많아:

```text
Linear GraphQL
Linear Webhook
Cloudflare Queue
D1
Cron
MCP
```

그리고 각 경계마다 실패 유형이 다르다. 이걸 `Promise + throw + try/catch`로 엮기보다 Effect의 typed error와 Layer로 표현하면 구조가 명확해진다.

### 특히 잘 맞는 부분

예를 들어 서비스 의존성을 이런 식으로 가져갈 수 있어.

```ts
LinearClient
IssueRepository
EventRepository
ProjectRepository
Clock
Config
```

그리고 application service는:

```ts
const ingestWebhook =
  Effect.gen(function* () {
    const events = yield* EventRepository
    const issues = yield* IssueRepository

    // ...
  })
```

처럼 실제 Cloudflare binding을 몰라도 된다.

Production에서는:

```text
LinearClientLive
D1IssueRepository
D1EventRepository
```

를 주고 테스트에서는:

```text
LinearClientTest
InMemoryIssueRepository
InMemoryEventRepository
```

를 주면 된다.

`linear-eye`처럼 **데이터 수집 → normalize → projection → intelligence**가 명확히 나뉘는 프로젝트에서는 Layer가 꽤 효과적이다.

---

더 좋은 건 D1까지 이미 Effect 생태계 지원이 있다는 점이야. Effect에는 Cloudflare D1용 `@effect/sql-d1`이 존재하고, Effect 4에서도 SQL 계층이 계속 발전 중이다. 최근 RC에서는 D1 batch 지원도 추가됐다. :chatgpt-content-reference{index="0"}

그러면 이전 스펙의

```text
ORM 사용하지 않음
D1 binding 직접 사용
```

은 내가 이제 이렇게 바꾸는 편을 선호해.

```text
ORM 사용하지 않음
Effect SQL + D1 driver 사용
```

즉 Drizzle 같은 ORM은 넣지 않으면서:

```ts
const sql = yield* SqlClient.SqlClient

const issues = yield* sql<Issue>`
  SELECT *
  FROM issues
  WHERE assignee_id = ${userId}
`
```

같은 식으로 가는 거지.

Effect SQL 자체도 parameterized statement, transaction, tracing 등을 제공한다. :chatgpt-content-reference{index="1"}

### Webhook/Queue에서 더 빛남

예를 들어 Webhook pipeline:

```text
verify signature
    ↓
decode payload
    ↓
normalize
    ↓
enqueue
```

를

```ts
verifySignature(request)
  .pipe(
    Effect.flatMap(decodeWebhook),
    Effect.flatMap(projectWebhook),
    Effect.flatMap(queue.offer)
  )
```

처럼 만들 수 있다.

에러도:

```ts
WebhookSignatureError
WebhookTimestampError
WebhookDecodeError
QueueOfferError
```

로 분리할 수 있고.

Queue consumer에서도:

```text
DuplicateDelivery
DatabaseError
InvalidLinearEvent
```

가 타입에 그대로 드러난다.

이 프로젝트에서는 이런 특성이 단순한 FP 취향 문제가 아니라 **“왜 해당 이벤트를 처리하지 못했는가”를 명확히 만드는 운영상의 장점**이 있어.

---

### 다만 `Effect Schedule`로 Cloudflare Queue/Cron을 대체하면 안 됨

이건 중요한 부분이야.

Effect에는 훌륭한 `Schedule`, `retry`가 있지만 Effect 문서에서도 schedule은 **현재 Effect runtime이 살아 있는 동안에만 동작하고 durable scheduling이 아니다**라고 명시한다. :chatgpt-content-reference{index="2"}

그러니까:

```text
잘못된 방향

Worker
  └ Effect.Schedule
       └ 매일 reconcile
```

가 아니라 기존 설계를 유지해야 한다.

```text
Cloudflare Cron Trigger
        ↓
Effect program
        ↓
ReconcileService
```

그리고:

```text
Cloudflare Queue
        ↓
Effect program
        ↓
WebhookIngestionService
```

Effect는 **실행 모델 내부**를 담당하고 Cloudflare가 durability/lifecycle을 담당하게 하는 게 맞아.

---

## MCP도 흥미로운 상황이 됐어

지금 Effect 4에는 아예 **native MCP server API가 추가되어 있어.**

`effect/ai/McpServer`가:

- tools
- resources
- prompts
- Streamable HTTP
- MCP protocol adapters

를 직접 지원한다. 현재 MCP `2026-07-28` 프로토콜 adapter도 있다. :chatgpt-content-reference{index="3"}

그래서 이론적으로는:

```text
Cloudflare createMcpHandler
+
@modelcontextprotocol/server
```

조합조차 빼고:

```text
Effect McpServer
```

하나로 통일할 수도 있어.

이건 꽤 매력적이다.

하지만 **MVP에서는 나는 아직 그렇게 안 할 것 같아.**

현재 Cloudflare가 공식적으로 권장하고 가장 직접 지원하는 방법은:

```ts
createMcpHandler(createServer)
```

기반의 stateless MCP Worker이고, SDK v2 `@modelcontextprotocol/server`와 Streamable HTTP를 사용하는 방식이다. :chatgpt-content-reference{index="4"}

따라서 경계를 이렇게 두는 게 안정적이라고 봐.

```text
┌───────────────────────────────┐
│ Cloudflare                    │
│                               │
│ fetch / queue / scheduled     │
│ createMcpHandler              │
└──────────────┬────────────────┘
               │
          Effect.runPromise
               │
               ▼
┌───────────────────────────────┐
│ Effect                        │
│                               │
│ Services                      │
│ Repositories                  │
│ Intelligence                  │
│ Error handling                │
│ Schema                        │
│ Retry                         │
└───────────────────────────────┘
```

즉 **Cloudflare/MCP adapter는 얇게 imperative하게 두고, 내부 로직은 Effect로 전부 작성**하는 구조.

이게 가장 마음에 들어.

---

## Schema도 잘 맞는다

지금 스펙에는 이런 데이터가 엄청 많잖아.

```ts
WebhookQueueMessage
SyncQueueMessage
GetChangesInput
GetWeeklyReportInput
Issue
FieldChange
```

Effect Schema를 사용하면 외부 boundary마다:

```text
unknown
 ↓
Schema.decodeUnknown
 ↓
validated domain value
```

로 가져올 수 있다.

특히 Linear webhook은 외부 input이라 단순 TypeScript `as LinearWebhook`으로 받으면 안 된다.

예를 들어:

```ts
class IssueWebhook extends Schema.Class<IssueWebhook>("IssueWebhook")({
  action: Schema.Literal("create", "update", "remove"),
  type: Schema.Literal("Issue"),
  data: IssueWebhookData,
  updatedFrom: Schema.optional(...)
}) {}
```

처럼 정의하고

```ts
Schema.decodeUnknown(IssueWebhook)(payload)
```

에서 경계를 확실히 닫을 수 있다.

Queue message에도 동일한 Schema를 재사용할 수 있고.

---

## `Effect.Service` 구조를 쓰면 나는 대략 이렇게 잡을 것 같아

```text
src/
├── domain/
│   ├── Issue.ts
│   ├── Project.ts
│   ├── Event.ts
│   ├── Webhook.ts
│   └── Errors.ts
│
├── services/
│   ├── LinearClient.ts
│   ├── IssueRepository.ts
│   ├── EventRepository.ts
│   ├── ProjectRepository.ts
│   ├── IngestionService.ts
│   ├── SyncService.ts
│   └── IntelligenceService.ts
│
├── layers/
│   ├── LinearClientLive.ts
│   ├── D1IssueRepository.ts
│   ├── D1EventRepository.ts
│   └── D1ProjectRepository.ts
│
├── intelligence/
│   ├── CurrentWork.ts
│   ├── Changes.ts
│   ├── Progress.ts
│   └── WeeklyReport.ts
│
├── entrypoints/
│   ├── fetch.ts
│   ├── queue.ts
│   └── scheduled.ts
│
└── index.ts
```

그리고 예를 들면:

```ts
class LinearClient extends Effect.Service<LinearClient>()(
  "linear-eye/LinearClient",
  {
    effect: Effect.gen(function* () {
      // ...
      return {
        getIssues,
        getProjects,
        getUsers
      }
    })
  }
) {}
```

식으로.

---

## 한 가지 고민은 Effect 버전

2026년 9월 29일 현재 **Effect 4는 아직 RC이고, npm의 stable은 Effect 3**다. Effect 팀은 4.0 RC에서 광범위한 breaking change는 더 이상 계획하지 않는다고 밝히고 있지만, stable은 아직 아니다. :chatgpt-content-reference{index="5"}

선택지는 두 가지야.

| | Effect 3 | Effect 4 RC |
|---|---|---|
| 안정성 | 높음 | RC |
| Cloudflare D1 | 지원 | 지원/개선 |
| MCP native | 별도 SDK 필요 | **native 지원** |
| 신규 API | 구버전 | **최신** |
| migration | 나중에 v4 필요 | 거의 최신 구조 |
| 새 개인/팀 프로젝트 | 무난 | 매력적 |

`linear-eye`가 지금 새로 시작하는 내부 도구라는 걸 생각하면 **나는 오히려 Effect 4 RC로 시작하는 쪽에 조금 더 기울어.**

Effect 4가 지금 막 RC 단계고, 프로젝트도 처음부터 Effect를 전제로 작성하는 거라 migration debt가 없으니까.

다만 MCP는 Effect native MCP에 바로 묶지 않고 Cloudflare 공식 handler를 adapter로 남겨둘 것 같아. 그러면 Effect 4 API가 일부 바뀌어도 MCP transport까지 같이 흔들리지 않는다.

### 그래서 내가 고르면

```text
Runtime
  Cloudflare Workers

Application
  Effect 4 RC

Validation
  Effect Schema

Database
  Effect SQL
  @effect/sql-d1
  D1

Queue
  Cloudflare Queues
  + Effect consumer logic

Scheduling
  Cloudflare Cron Triggers
  + Effect reconciliation logic

MCP transport
  Cloudflare createMcpHandler
  @modelcontextprotocol/server

MCP handlers
  thin adapter
       ↓
  Effect Intelligence services
```

이 조합으로 갈 것 같아.

`linear-eye`는 **Effect를 쓰려고 억지로 끼워 넣는 프로젝트가 아니라, Effect의 typed error / dependency injection / schema / retry / testability가 실제 문제와 잘 맞는 편**이야.

원하면 아까 만든 MVP Specification을 이 구조 기준으로 **Effect 4 전용 구현 스펙으로 전체 수정해서 코딩 에이전트용 문서로 다시 만들어주는 것**도 괜찮아.