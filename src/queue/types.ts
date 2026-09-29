export type Resource = 'users' | 'teams' | 'workflow_states' | 'projects' |
  'project_milestones' | 'issues' | 'project_updates';
export type EntityType = 'User' | 'Team' | 'WorkflowState' | 'Project' |
  'ProjectMilestone' | 'Issue' | 'ProjectUpdate';
export type SyncMode = 'full' | 'reconcile';

export interface WebhookQueueMessage {
  kind: 'webhook';
  deliveryId: string;
  webhookId: string | null;
  organizationId: string;
  eventType: string;
  action: 'create' | 'update' | 'remove';
  occurredAt: string;
  receivedAt: string;
  actor: { id: string | null; type: string | null; name: string | null } | null;
  entityUrl: string | null;
  data: Record<string, unknown>;
  updatedFrom: Record<string, unknown> | null;
}

export interface SyncQueueMessage {
  kind: 'sync';
  runId: string;
  mode: SyncMode;
  resource: Resource;
  cursor: string | null;
  watermark: string | null;
}
export type QueueMessage = WebhookQueueMessage | SyncQueueMessage;
