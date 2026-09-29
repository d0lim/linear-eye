# linear-eye

Linear를 source of truth로 유지하면서 현재 snapshot과 관찰한 변경 이력을 D1에 저장하는 읽기 전용 MCP 서버입니다. 현재 담당 업무, 프로젝트·milestone 진행률, 기간별 변경, 팀원의 활동과 주간 보고 초안을 반환합니다. 서버는 LLM을 호출하거나 Linear 데이터를 수정하지 않습니다.

## Architecture

```text
Linear Webhook ─ HMAC + timestamp ─ Queue ─┐
                                         ├─ Effect services ─ Effect SQL / D1
Linear GraphQL ─ full sync / daily Cron ──┘                         │
                                                                  ▼
MCP client ─ Bearer ─ createMcpHandler ─ Effect intelligence ────── D1
```

하나의 Cloudflare Worker에 `fetch`, `queue`, `scheduled`가 있습니다. Cloudflare가 재시도와 실행 수명을 담당하며, Effect Schedule로 polling이나 영구 스케줄을 구현하지 않습니다.

- Effect와 `@effect/sql-d1`: **4.0.0-rc.118**로 고정했습니다. Effect 4의 `Context.Service`, `Layer`, Schema, typed errors를 사용합니다.
- Effect SQL의 D1 driver와 parameterized SQL을 사용하며 ORM은 없습니다. D1은 `BEGIN` transaction 대신 driver의 atomic `batch`를 사용합니다.
- MCP transport는 `agents`의 `createMcpHandler`와 SDK v2입니다. Zod는 MCP transport schema에만 쓰고 application 입력은 Effect Schema로 검증합니다.
- 저장소·설정·Queue·Linear client는 Layer로 주입합니다. 분석 서비스는 Linear client나 Worker binding을 참조하지 않습니다.
- 개인 점수, 순위, 생산성 평가를 계산하지 않습니다.

원본 명세는 [docs/mvp-spec.md](docs/mvp-spec.md), 추가 설계 방향은 [docs/effect-direction.md](docs/effect-direction.md)에 있습니다. DB 접근 방식은 추가 문서의 Effect SQL 방향을 따릅니다.

## Prerequisites

- Node.js 22 이상 및 pnpm 10 (개발·빌드 도구용; 운영 서버는 Workers입니다).
- Cloudflare 계정과 Workers / D1 / Queues 사용 권한.
- 단일 Linear workspace의 **read-only** API key와 webhook 생성 권한.
- Bearer header를 설정할 수 있는 Streamable HTTP MCP client.

## Local development

```sh
pnpm install
cp .dev.vars.example .dev.vars
# .dev.vars의 네 가지 값을 실제 개발용 값으로 교체
pnpm db:migrate:local
pnpm dev
```

`.dev.vars`는 git에서 제외됩니다. 실제 webhook은 공개 HTTPS URL이 필요하므로 localhost만으로 Linear delivery를 받을 수 없습니다. 개발 서버가 종료되면 로컬 Queue consumer도 종료됩니다.

```sh
curl http://localhost:8787/health
pnpm check
pnpm test
pnpm build
```

`pnpm test`는 Workers runtime + 실제 로컬 D1에서 migration, atomic rollback, 중복 및 역순 webhook, sync pagination·실패 복구, 분석, MCP HTTP를 검증합니다. 테스트는 Linear와 Cloudflare 계정이 필요하지 않습니다. `pnpm build`는 **배포하지 않는** Wrangler dry run입니다.

## Create D1 and Queues

```sh
pnpm exec wrangler login
pnpm exec wrangler d1 create linear-eye
pnpm exec wrangler queues create linear-eye-events
pnpm exec wrangler queues create linear-eye-dead-letter
```

D1 생성 결과의 `database_id`를 `wrangler.jsonc`의 placeholder UUID 대신 넣으세요. 실제 ID 없이 remote migration이나 deploy를 실행하면 안 됩니다. `DB` 및 `LINEAR_EYE_QUEUE` binding 이름은 그대로 유지합니다.

```sh
pnpm db:migrate:remote
```

새 데이터베이스에서 `migrations/0001_initial.sql`을 적용합니다. 이미 적용한 migration을 수정하여 운영 DB에 재적용하지 마세요.

## Configure secrets and deploy

Linear Settings → API에서 read-only API key를 만듭니다. 토큰별 역할을 분리하고 충분히 긴 무작위 값을 사용하세요. 예를 들어 `openssl rand -hex 32`로 MCP와 Admin 토큰을 **각각** 생성할 수 있습니다.

```sh
pnpm exec wrangler secret put LINEAR_API_KEY
pnpm exec wrangler secret put LINEAR_WEBHOOK_SECRET
pnpm exec wrangler secret put MCP_AUTH_TOKEN
pnpm exec wrangler secret put ADMIN_AUTH_TOKEN
pnpm deploy
```

Webhook signing secret은 Linear webhook 상세 화면에서 가져옵니다. 새 설치에서 아직 secret이 없다면 먼저 Worker를 배포한 후 다음 절차로 webhook을 만들고 signing secret을 등록하세요. 등록 전 webhook 요청은 401로 거부됩니다. 생성 중 테스트 delivery가 실패했다면 secret 등록 후 webhook이 활성 상태인지 확인합니다.

운영 secret을 `wrangler.jsonc`, 소스, 커밋에 넣지 않습니다. 일반 설정은 다음과 같습니다.

| Variable | Default | 의미 |
|---|---|---|
| `REPORT_TIMEZONE` | `Asia/Seoul` | 날짜 범위와 주간 보고의 IANA timezone |
| `STALE_ISSUE_DAYS` | `5` | 진행 중 issue에 최근 변화가 없었던 일수 |
| `PROJECT_UPDATE_BODY_LIMIT` | `8000` | ProjectUpdate body 저장 길이, 최대 8000 |

## Configure the Linear webhook

Linear Settings → API → Webhooks에서 아래 URL을 등록합니다.

```text
https://<worker>/webhooks/linear
```

구독 resource: **Issue, Project, ProjectUpdate, User**. API key가 읽을 수 있는 같은 workspace·team 범위를 선택하세요. Comments는 구독하지 않습니다.

서명은 raw bytes의 HMAC-SHA256입니다. `Linear-Signature`, `Linear-Delivery`, millisecond `Linear-Timestamp` header를 사용하며, timestamp header와 서명된 body의 `webhookTimestamp`를 모두 60초 이내인지 검증합니다. Webhook HTTP 경로는 D1에 접근하지 않고 projection을 Queue에 넣은 뒤 200을 반환합니다.

알 수 없는 변경 필드도 안전한 값은 이력에 보존합니다. Queue 메시지는 UTF-8 기준 96 KiB, 추가 필드의 이력은 최대 64 KiB로 제한합니다. 제한을 넘는 값은 `$linearEyeTruncated` 표시로 대체하며, 필드 이름까지 담을 수 없으면 생략 개수를 기록합니다. 따라서 큰 추가 필드 때문에 알려진 상태·제목 변경까지 버리지 않습니다. description/comment 등 제외 대상은 중첩된 값에서도 제거합니다.

## Initial sync and status

Webhook을 활성화한 뒤 bootstrap을 시작하세요. 그래야 bootstrap 도중의 변경도 관찰할 수 있습니다.

```sh
export WORKER_URL='https://<worker>'
# ADMIN_AUTH_TOKEN에는 별도로 보관한 admin token을 설정
curl -X POST "$WORKER_URL/admin/sync" \
  -H "Authorization: Bearer $ADMIN_AUTH_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"mode":"full"}'
```

응답은 HTTP 202와 `{ "accepted": true, "runId": "..." }`입니다. HTTP 응답 안에서 동기화를 끝내지 않습니다.

```sh
curl "$WORKER_URL/admin/sync/<runId>" \
  -H "Authorization: Bearer $ADMIN_AUTH_TOKEN"
```

`status`가 `completed`인지 확인하세요. `pagesProcessed`, `entitiesProcessed`, `error`가 포함됩니다. 최초 full sync 완료 전 MCP는 `SYNC_NOT_READY`를 반환합니다.

Full sync 순서: users → teams → workflow states → projects → project milestones → issues → project updates. 한 메시지에서 GraphQL 50개 한 page만 처리합니다. 페이지 receipt와 다음 메시지를 DB에 함께 기록하므로 DB commit 이후 enqueue 실패도 재시도로 복구합니다. snapshot 버전을 비교해 오래된 sync page나 webhook이 최신 데이터를 덮어쓰지 않게 합니다.

## Reconciliation and recovery

Cron은 매일 **18:00 UTC / 03:00 Asia/Seoul**에 증분 reconciliation을 시작합니다. 대상은 users, workflow states, projects, project milestones, issues입니다. 마지막 성공한 run의 시작 시각에서 5분 겹쳐 읽습니다. 기간 내 변경을 놓치지 않도록 완료 시각을 watermark로 사용하지 않습니다.

```sh
curl -X POST "$WORKER_URL/admin/reconcile" \
  -H "Authorization: Bearer $ADMIN_AUTH_TOKEN" \
  -H 'Content-Type: application/json' -d '{}'
```

Linear page 요청은 response body 읽기를 포함해 20초 후 취소되며 재시도 가능한 오류로 처리합니다. Queue는 실패를 최대 5번 재시도합니다. 429의 `Retry-After`를 존중하고 실패가 지속되면 `linear-eye-dead-letter`로 보냅니다. terminal sync 실패는 상태 API에도 기록합니다. 원인을 해결한 뒤 admin endpoint로 새 sync를 시작할 수 있습니다. Webhook DLQ 메시지는 순서를 바꾸거나 body를 편집하지 말고 Cloudflare 도구로 원 Queue에 재전달하세요. `Linear-Delivery` 기준으로 이미 처리한 메시지는 중복 저장되지 않습니다.

재시도 중 status는 `running`입니다. Worker가 아예 실행되지 못한 경우 status를 갱신할 수 없으므로 Queue backlog와 DLQ도 확인해야 합니다. Queue retention 이전에 복구해야 event history를 보존할 수 있습니다.

```sh
pnpm exec wrangler tail
```

JSON 로그에는 webhook received/rejected/processed/duplicate, sync started/completed/failed, GraphQL page/error, MCP tool name/latency가 나옵니다. Secret, 질문 전문, issue description, project update 전체 body를 로그에 남기지 않습니다.

## Connect an MCP client

- URL: `https://<worker>/mcp`
- Transport: Streamable HTTP
- Header: `Authorization: Bearer <MCP_AUTH_TOKEN>`

MCP token은 Admin token과 다릅니다. OAuth discovery/login은 구현하지 않으므로 custom Bearer header를 설정할 수 없는 client는 바로 연결할 수 없습니다. 브라우저 CORS를 공개하지 않습니다.

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
| `get_team_current_work` | `{ "team": "PAY", "includeStale": true }` |
| `get_member_activity` | `{ "member": "alice@example.com", "from": "2026-09-21", "to": "2026-09-27" }` |
| `get_project_progress` | `{ "project": "Custody" }` |
| `get_milestone_progress` | `{ "project": "Custody", "milestone": "Beta" }` |
| `get_changes` | `{ "from": "2026-09-21", "to": "2026-09-27", "issue": "PAY-123", "fields": ["state"], "limit": 100 }` |
| `get_weekly_report` | `{ "member": "alice@example.com", "week": "current" }` |

- 멤버는 정확한 ID → email → display name → name 순서로 찾습니다. 프로젝트·milestone도 정확히 일치해야 합니다. 여러 결과가 있으면 후보와 `AMBIGUOUS_*` 오류를 반환합니다.
- 날짜는 `REPORT_TIMEZONE`의 calendar date이며 양 끝 날짜를 포함합니다. 주는 월요일 시작입니다. `week: "previous"` 또는 월요일 `weekStart: "2026-09-21"`도 지원합니다.
- 모든 report는 tracking `coverage`를 반환합니다. 변경을 시작하기 전 기간은 `complete: false`입니다.
- count/estimate 진행률의 분모에서 archived/deleted/canceled issue를 제외합니다. canceled는 별도 count입니다. 분모가 없으면 진행률은 `null`; estimate가 없다고 1점으로 바꾸지 않습니다.
- Actor와 해당 시점 assignee는 다릅니다. assignee 이력이 없으면 현재 snapshot으로 추정하며 `inferred: true`입니다.
- `get_changes`는 최대 500개씩 시간순으로 반환합니다. `truncated`가 true이면 같은 필터와 `nextCursor`를 `cursor`로 다시 전달하세요.
- 주간 보고의 `currentlyInProgress`는 현재 상태입니다. `currentlyInProgressAsOf`를 확인하세요. Markdown은 deterministic template이며 LLM 요약이 아닙니다.
- `includeStale: false`는 오래 변하지 않은 업무를 결과에서 제외합니다. stale은 성과나 문제 여부에 대한 평가가 아닙니다.

## Known limitations

- 단일 workspace, 읽기 전용. OAuth, UI, Slack/GitHub, LLM API, description/comment ingest는 없습니다.
- bootstrap은 과거 activity를 backfill하지 않습니다. reconciliation도 누락된 중간 history를 만들어내지 않습니다. coverage는 수집 시작 범위이며 webhook이 하나도 유실되지 않았다는 증명은 아닙니다.
- Issue 변경 report는 `field_changes` 기준입니다. 생성·삭제 event와 다른 entity의 event도 보관하지만 별도 event timeline tool은 MVP에 없습니다.
- 이름·workflow state type은 현재 metadata로 해석합니다. 이름 변경 전 표현을 완전히 재현하지는 않습니다.
- API에서 완전히 사라진 삭제 대상은 증분 query만으로 감지할 수 없습니다. 삭제 webhook이 유실되면 운영 확인이 필요합니다. archive는 `includeArchived: true`로 복구합니다.
- Effect 4는 RC입니다. Effect와 D1 driver는 같은 버전으로 함께 업그레이드하고 전체 테스트를 실행하세요.
- Free tier를 고려해 page·query·body 크기를 제한했지만 10ms CPU, 일별 read/write/request/Queue operation, storage 한도는 workspace 규모에 따라 검증해야 합니다. event retention/자동 삭제는 구현하지 않았습니다.
- 실제 workspace bootstrap 및 hosted MCP 연결은 계정과 secret이 필요한 운영 검증입니다. 로컬 테스트와 dry run은 이를 대신하지 않습니다.

## Verified API references

- [Linear webhooks](https://linear.app/developers/webhooks): header, 서명, signed timestamp, 재전송.
- [Linear pagination](https://linear.app/developers/pagination), [filtering](https://linear.app/developers/filtering).
- [Linear official schema](https://github.com/linear/linear/blob/master/packages/sdk/src/schema.graphql): 2026-09-29 live introspection에서도 workspace-level `projectMilestones`와 모든 resource의 `updatedAt.gte`를 확인했습니다.
- [Cloudflare stateless MCP](https://developers.cloudflare.com/agents/model-context-protocol/).
- [Effect 4 RC changes](https://effect.website/blog/effect-v4-rc-august-recap), [D1 limits](https://developers.cloudflare.com/d1/platform/limits/).
