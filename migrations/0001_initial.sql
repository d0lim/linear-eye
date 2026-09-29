CREATE TABLE meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

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

CREATE TABLE teams (
    id TEXT PRIMARY KEY,

    key TEXT NOT NULL,
    name TEXT NOT NULL,

    created_at TEXT,
    updated_at TEXT,
    archived_at TEXT,
    deleted_at TEXT
);

CREATE TABLE workflow_states (
    id TEXT PRIMARY KEY,

    team_id TEXT NOT NULL,

    name TEXT NOT NULL,
    type TEXT NOT NULL,

    created_at TEXT,
    updated_at TEXT,
    deleted_at TEXT
);

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

CREATE TABLE project_milestones (
    id TEXT PRIMARY KEY,

    project_id TEXT NOT NULL,

    name TEXT NOT NULL,

    target_date TEXT,

    created_at TEXT,
    updated_at TEXT,
    deleted_at TEXT
);

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

-- Versions survive a remove that arrives before a create or bootstrap row.
CREATE TABLE entity_versions (
    entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    version_at TEXT NOT NULL,
    deleted_at TEXT,
    PRIMARY KEY(entity_type, entity_id)
);

CREATE TABLE sync_runs (
    id TEXT PRIMARY KEY,
    mode TEXT NOT NULL CHECK(mode IN ('full','reconcile')),
    status TEXT NOT NULL CHECK(status IN ('running','completed','failed')),
    started_at TEXT NOT NULL,
    completed_at TEXT,
    pages_processed INTEGER NOT NULL DEFAULT 0,
    entities_processed INTEGER NOT NULL DEFAULT 0,
    error TEXT,
    watermark TEXT
);
CREATE INDEX idx_sync_runs_status ON sync_runs(status, started_at);

-- Page receipts double as a durable continuation outbox. Retrying a page can
-- resend its continuation without applying counters or snapshots twice.
CREATE TABLE sync_pages (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    next_message TEXT,
    processed_at TEXT NOT NULL
);
CREATE INDEX idx_sync_pages_run ON sync_pages(run_id);

CREATE INDEX idx_changes_occurred ON field_changes(occurred_at, id);
CREATE INDEX idx_changes_assignee_history ON field_changes(entity_type, entity_id, field_name, occurred_at);
CREATE INDEX idx_users_email ON users(email);
CREATE INDEX idx_users_display_name ON users(display_name);
CREATE INDEX idx_users_name ON users(name);
CREATE INDEX idx_projects_name ON projects(name);
CREATE INDEX idx_issues_identifier ON issues(identifier);
CREATE INDEX idx_teams_key ON teams(key);
CREATE INDEX idx_teams_name ON teams(name);
