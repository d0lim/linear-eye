import type { SyncRun as DatabaseSyncRun } from '../../src/db/sync-runs';

export interface Team { id: string; name: string; key: string }
export interface ProjectOption { id: string; name: string }
export interface MemberOption { id: string; name: string; displayName: string | null; email: string | null }
export interface SyncRun {
  id: string; mode: DatabaseSyncRun['mode']; status: DatabaseSyncRun['status']; startedAt: string | null; completedAt: string | null;
  pagesProcessed: number; entitiesProcessed: number; error: string | null;
}
export interface Bootstrap {
  viewer: { email: string }; timezone: string; trackingStartedAt: string | null;
  lastFullSyncCompletedAt: string | null; lastReconcileCompletedAt: string | null;
  latestSync: SyncRun | null; teams: Team[]; projects: ProjectOption[]; members: MemberOption[];
}
export interface Coverage { complete: boolean; trackingStartedAt: string | null }
export interface Issue {
  id: string; identifier: string; title: string; state: string | null; stateType: string | null;
  project: string | null; milestone: string | null; priority: number | null; estimate: number | null;
  updatedAt: string; url: string | null; stale?: boolean; daysSinceActivity?: number | null; lastActivityAt?: string | null;
}
export interface TeamWork {
  generatedAt: string; coverage: Coverage; lastFullSyncCompletedAt: string | null;
  members: Array<{ user: { id: string; name: string; displayName?: string | null; email?: string | null }; issues: Issue[] }>;
}
export interface Progress {
  issueCount: { total: number; completed: number; started: number; unstarted: number; backlog: number; canceled: number; unknown: number };
  progress: { byCount: number | null; byEstimate: number | null };
  estimates: { total: number; completed: number };
}
export interface ProjectProgress extends Progress {
  generatedAt: string; coverage: Coverage; lastFullSyncCompletedAt: string | null;
  project: { id: string; name: string; url?: string | null };
  milestones: Array<{ milestone: { id: string; name: string; targetDate: string | null } } & Progress>;
}
export interface MilestoneProgress extends Progress {
  project: { id: string; name: string; url?: string | null };
  milestone: { id: string; name: string; targetDate: string | null };
  issues: { completed: Issue[]; started: Issue[]; remaining: Issue[] };
}
export interface Change {
  id: string; occurredAt: string; field: string; before: unknown; after: unknown;
  issue: { id: string; identifier: string | null; title: string | null; url: string | null };
  actor: { id: string | null; name: string | null; type: string | null };
}
export interface ChangesResult {
  generatedAt: string; period: { from: string; to: string; timezone: string }; coverage: Coverage;
  changes: Change[]; truncated: boolean; nextCursor: string | null;
}
