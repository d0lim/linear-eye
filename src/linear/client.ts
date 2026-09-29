import { Context, Effect, Layer, Schema } from 'effect';
import { LinearApiError } from '../errors';
import { log } from '../log';
import type { Resource } from '../queue/types';
import { pageQuery, resourceDefinitions } from './queries';

export interface LinearPageRequest { resource: Resource; cursor: string | null; watermark: string | null }
export interface LinearPage {
  readonly nodes: ReadonlyArray<Record<string, unknown>>;
  readonly hasNextPage: boolean;
  readonly endCursor: string | null;
}

export class LinearClient extends Context.Service<LinearClient, {
  readonly fetchPage: (request: LinearPageRequest) => Effect.Effect<LinearPage, LinearApiError>;
}>()('linear-eye/LinearClient') {}

const nullableString = Schema.NullOr(Schema.String);
const relation = Schema.Struct({ id: Schema.NonEmptyString });
const optionalRelation = Schema.NullOr(relation);
const timestamp = Schema.String.check(Schema.makeFilter((value) => Number.isFinite(Date.parse(value))));
const dates = { id: Schema.NonEmptyString, createdAt: timestamp, updatedAt: timestamp };
const nodeSchemas = {
  users: Schema.Struct({ ...dates, name: Schema.String, displayName: nullableString, email: nullableString, avatarUrl: nullableString, active: Schema.Boolean }),
  teams: Schema.Struct({ ...dates, key: Schema.String, name: Schema.String, archivedAt: nullableString }),
  workflow_states: Schema.Struct({ ...dates, name: Schema.String, type: Schema.String, team: relation }),
  projects: Schema.Struct({ ...dates, name: Schema.String, url: nullableString, status: Schema.NullOr(Schema.Struct({ id: Schema.String, name: Schema.String, type: Schema.String })), lead: optionalRelation, startDate: nullableString, targetDate: nullableString, completedAt: nullableString, canceledAt: nullableString, archivedAt: nullableString }),
  project_milestones: Schema.Struct({ ...dates, name: Schema.String, project: relation, targetDate: nullableString }),
  issues: Schema.Struct({ ...dates, identifier: Schema.String, title: Schema.String, team: relation, assignee: optionalRelation, creator: optionalRelation, state: relation, project: optionalRelation, projectMilestone: optionalRelation, cycle: optionalRelation, priority: Schema.Number, estimate: Schema.NullOr(Schema.Number), dueDate: nullableString, parent: optionalRelation, url: nullableString, startedAt: nullableString, completedAt: nullableString, canceledAt: nullableString, archivedAt: nullableString }),
  project_updates: Schema.Struct({ ...dates, project: relation, user: optionalRelation, health: nullableString, body: nullableString, url: nullableString, archivedAt: nullableString }),
};
const envelopeSchema = Schema.Struct({
  data: Schema.optionalKey(Schema.NullOr(Schema.Record(Schema.String, Schema.Unknown))),
  errors: Schema.optionalKey(Schema.Array(Schema.Struct({
    message: Schema.String,
    extensions: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
  }))),
});
const connectionSchema = Schema.Struct({
  nodes: Schema.Array(Schema.Unknown),
  pageInfo: Schema.Struct({ hasNextPage: Schema.Boolean, endCursor: nullableString }),
});

function retryAfter(response: Response): number | undefined {
  const value = response.headers.get('retry-after');
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, Math.ceil((date - Date.now()) / 1000)) : undefined;
}

export const linearClientLayer = (apiKey: string) => Layer.succeed(LinearClient, {
  fetchPage: (request) => Effect.gen(function* () {
    // Keep the abort signal alive through the body read, not just the headers.
    const { response, raw } = yield* Effect.tryPromise({
      try: async (signal) => {
        const response = await fetch('https://api.linear.app/graphql', {
          method: 'POST', signal,
          headers: { Authorization: apiKey, 'Content-Type': 'application/json' },
          body: JSON.stringify({ query: pageQuery(request.resource), variables: {
            after: request.cursor,
            filter: request.watermark ? { updatedAt: { gte: request.watermark } } : null,
          } }),
        });
        if (!response.ok) {
          await response.body?.cancel();
          return { response, raw: null };
        }
        const raw: unknown = await response.json().catch(() => {
          throw new LinearApiError({ status: 502, retryable: false });
        });
        return { response, raw };
      },
      catch: (error) => error instanceof LinearApiError ? error : new LinearApiError({ status: 0, retryable: true }),
    });
    if (!response.ok) {
      return yield* Effect.fail(new LinearApiError({ status: response.status,
        retryable: response.status === 429 || response.status === 408 || response.status === 425 || response.status >= 500,
        retryAfterSeconds: retryAfter(response) }));
    }
    const body = yield* Schema.decodeUnknownEffect(envelopeSchema)(raw).pipe(
      Effect.mapError(() => new LinearApiError({ status: 502, retryable: false })),
    );
    if (body.errors?.length) {
      const codes = body.errors.flatMap((error) => [error.extensions?.code, error.extensions?.type])
        .filter((value): value is string => typeof value === 'string').map((value) => value.toUpperCase());
      const rateLimited = codes.some((code) => code.includes('RATELIMIT') || code.includes('RATE_LIMIT'));
      return yield* Effect.fail(new LinearApiError({ status: rateLimited ? 429 : 502,
        retryable: rateLimited || codes.includes('INTERNAL_SERVER_ERROR'), retryAfterSeconds: retryAfter(response) }));
    }
    const connection = yield* Schema.decodeUnknownEffect(connectionSchema)(body.data?.[resourceDefinitions[request.resource].field]).pipe(
      Effect.mapError(() => new LinearApiError({ status: 502, retryable: false })),
    );
    const nodes = yield* Effect.forEach(connection.nodes, (node) =>
      Schema.decodeUnknownEffect(nodeSchemas[request.resource])(node).pipe(
        Effect.map((decoded): Record<string, unknown> => ({ ...decoded })),
        Effect.mapError(() => new LinearApiError({ status: 502, retryable: false })),
      ));
    if (connection.pageInfo.hasNextPage && (!connection.pageInfo.endCursor || connection.pageInfo.endCursor === request.cursor)) {
      return yield* Effect.fail(new LinearApiError({ status: 502, retryable: false }));
    }
    log('info', 'graphql.page_fetched', { resource: request.resource, count: nodes.length });
    return { nodes, ...connection.pageInfo };
  }).pipe(
    Effect.timeoutOrElse({ duration: '20 seconds', orElse: () => Effect.fail(new LinearApiError({ status: 408, retryable: true })) }),
    Effect.tapError((error) => Effect.sync(() => log('warn', 'graphql.error', { resource: request.resource, status: error.status, retryable: error.retryable }))),
  ),
});
