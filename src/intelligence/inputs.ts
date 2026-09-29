import { Effect, Schema } from 'effect';
import { AppError } from '../errors';
import { changeFields } from './changes';

const optionalString = Schema.optional(Schema.String);
export const TeamCurrentWorkInputSchema = Schema.Struct({ team: optionalString, includeStale: Schema.optional(Schema.Boolean) });
export const MemberActivityInputSchema = Schema.Struct({ member: Schema.String, from: Schema.String, to: Schema.String });
export const ProjectProgressInputSchema = Schema.Struct({ project: Schema.String });
export const MilestoneProgressInputSchema = Schema.Struct({ project: Schema.String, milestone: Schema.String });
export const ChangesInputSchema = Schema.Struct({ from: Schema.String, to: Schema.String, member: optionalString,
  project: optionalString, issue: optionalString, fields: Schema.optional(Schema.Array(Schema.Literals(changeFields))),
  limit: Schema.optional(Schema.Number), cursor: optionalString });
export const WeeklyReportInputSchema = Schema.Struct({ member: Schema.String,
  week: Schema.optional(Schema.Literals(['current', 'previous'])), weekStart: optionalString });
export const decodeInput = <S extends Schema.Constraint>(schema: S, input: unknown) =>
  Schema.decodeUnknownEffect(schema)(input).pipe(Effect.mapError(() => new AppError({ code: 'INVALID_INPUT', message: 'Invalid tool input' })));
