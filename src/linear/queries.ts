import type { EntityType, Resource } from '../queue/types';

// Validated against Linear's public GraphQL schema on 2026-09-29.
// All collections expose updatedAt.gte, including projectMilestones.
export const resources: ReadonlyArray<Resource> = [
  'users', 'teams', 'workflow_states', 'projects', 'project_milestones', 'issues', 'project_updates',
];
export const reconcileResources: ReadonlyArray<Resource> = ['users', 'workflow_states', 'projects', 'project_milestones', 'issues'];

export const resourceDefinitions: Record<Resource, { field: string; filter: string; entityType: EntityType; selection: string }> = {
  users: { field: 'users', filter: 'UserFilter', entityType: 'User', selection: 'id name displayName email avatarUrl active createdAt updatedAt' },
  teams: { field: 'teams', filter: 'TeamFilter', entityType: 'Team', selection: 'id key name createdAt updatedAt archivedAt' },
  workflow_states: { field: 'workflowStates', filter: 'WorkflowStateFilter', entityType: 'WorkflowState', selection: 'id name type team { id } createdAt updatedAt' },
  projects: { field: 'projects', filter: 'ProjectFilter', entityType: 'Project', selection: 'id name url status { id name type } lead { id } startDate targetDate createdAt updatedAt completedAt canceledAt archivedAt' },
  project_milestones: { field: 'projectMilestones', filter: 'ProjectMilestoneFilter', entityType: 'ProjectMilestone', selection: 'id name project { id } targetDate createdAt updatedAt' },
  issues: { field: 'issues', filter: 'IssueFilter', entityType: 'Issue', selection: 'id identifier title team { id } assignee { id } creator { id } state { id } project { id } projectMilestone { id } cycle { id } priority estimate dueDate parent { id } url createdAt updatedAt startedAt completedAt canceledAt archivedAt' },
  project_updates: { field: 'projectUpdates', filter: 'ProjectUpdateFilter', entityType: 'ProjectUpdate', selection: 'id project { id } user { id } health body url createdAt updatedAt archivedAt' },
};

export function pageQuery(resource: Resource): string {
  const def = resourceDefinitions[resource];
  return `query SyncPage($after: String, $filter: ${def.filter}) {
    ${def.field}(first: 50, after: $after, includeArchived: true, orderBy: updatedAt, filter: $filter${resource === 'users' ? ', includeDisabled: true' : ''}) {
      nodes { ${def.selection} }
      pageInfo { hasNextPage endCursor }
    }
  }`;
}
