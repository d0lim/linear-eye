export const changeFields = ['assignee', 'state', 'project', 'project_milestone', 'priority', 'estimate', 'due_date', 'title', 'cycle', 'parent'] as const;
export type ChangeField = typeof changeFields[number];
export const issueFieldNames: Readonly<Record<string, ChangeField>> = {
  assigneeId: 'assignee', stateId: 'state', projectId: 'project', projectMilestoneId: 'project_milestone',
  priority: 'priority', estimate: 'estimate', dueDate: 'due_date', title: 'title', cycleId: 'cycle', parentId: 'parent',
};
