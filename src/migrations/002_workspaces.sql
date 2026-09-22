CREATE TABLE workspaces (
  id uuid PRIMARY KEY,
  lock_id serial UNIQUE NOT NULL,
  name text NOT NULL CHECK(length(name) BETWEEN 1 AND 120),
  created_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO workspaces(id,name) VALUES('00000000-0000-4000-8000-000000000001','Local demonstration');

ALTER TABLE scenario_state ADD COLUMN workspace_id uuid NOT NULL DEFAULT '00000000-0000-4000-8000-000000000001' REFERENCES workspaces(id);
ALTER TABLE scenario_state DROP CONSTRAINT scenario_state_pkey;
ALTER TABLE scenario_state DROP COLUMN singleton;
ALTER TABLE scenario_state ADD PRIMARY KEY(workspace_id);
ALTER TABLE scenario_state ALTER COLUMN workspace_id DROP DEFAULT;

ALTER TABLE plans ADD COLUMN workspace_id uuid NOT NULL DEFAULT '00000000-0000-4000-8000-000000000001' REFERENCES workspaces(id);
ALTER TABLE plans ALTER COLUMN workspace_id DROP DEFAULT;
CREATE INDEX plans_workspace ON plans(workspace_id,scenario_id);
ALTER TABLE events ADD COLUMN workspace_id uuid NOT NULL DEFAULT '00000000-0000-4000-8000-000000000001' REFERENCES workspaces(id);
ALTER TABLE events ALTER COLUMN workspace_id DROP DEFAULT;
CREATE INDEX events_workspace ON events(workspace_id,scenario_id,seq);
ALTER TABLE approvals ADD COLUMN actor_id uuid;
ALTER TABLE plans ADD COLUMN cancel_reason text;
