import { Effect } from 'effect';
import * as Progress from './progress';
import * as Changes from './changes';
import * as Activity from './activity';
import * as Inputs from './inputs';

export const getTeamCurrentWork = (input: Progress.TeamCurrentWorkInput) => Inputs.decodeInput(Inputs.TeamCurrentWorkInputSchema, input).pipe(Effect.flatMap(Progress.getTeamCurrentWork));
export const getProjectProgress = (input: { project: string }) => Inputs.decodeInput(Inputs.ProjectProgressInputSchema, input).pipe(Effect.flatMap(Progress.getProjectProgress));
export const getMilestoneProgress = (input: { project: string; milestone: string }) => Inputs.decodeInput(Inputs.MilestoneProgressInputSchema, input).pipe(Effect.flatMap(Progress.getMilestoneProgress));
export const getChanges = (input: Changes.ChangesInput) => Inputs.decodeInput(Inputs.ChangesInputSchema, input).pipe(Effect.flatMap(Changes.getChanges));
export const getMemberActivity = (input: Activity.MemberActivityInput) => Inputs.decodeInput(Inputs.MemberActivityInputSchema, input).pipe(Effect.flatMap(Activity.getMemberActivity));
export const getWeeklyReport = (input: Activity.WeeklyReportInput) => Inputs.decodeInput(Inputs.WeeklyReportInputSchema, input).pipe(Effect.flatMap(Activity.getWeeklyReport));
export type { TeamCurrentWorkInput } from './progress';
export type { ChangesInput, ChangeField } from './changes';
export type { MemberActivityInput, WeeklyReportInput } from './activity';
