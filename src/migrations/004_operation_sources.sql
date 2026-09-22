CREATE TABLE operation_sources (
  scenario_id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  source text NOT NULL CHECK(char_length(source) BETWEEN 1 AND 500),
  created_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO operation_sources(scenario_id,workspace_id,source)
SELECT DISTINCT scenario_id,workspace_id,'Migrated synthetic demo'
FROM (
 SELECT (scenario->>'id')::uuid AS scenario_id,workspace_id FROM scenario_state
 UNION SELECT scenario_id,workspace_id FROM plans
 UNION SELECT scenario_id,workspace_id FROM events
) existing;
CREATE INDEX operation_sources_workspace ON operation_sources(workspace_id);
