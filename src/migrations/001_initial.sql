CREATE TABLE IF NOT EXISTS scenario_state (
      singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
      scenario jsonb NOT NULL, snapshot jsonb NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(), crash_next boolean NOT NULL DEFAULT false
    );
    CREATE TABLE IF NOT EXISTS plans (
      id uuid PRIMARY KEY, scenario_id uuid NOT NULL, strategy text NOT NULL,
      snapshot jsonb NOT NULL, solution jsonb NOT NULL, hash text NOT NULL,
      status text NOT NULL CHECK(status IN ('proposed','approved','executing','uncertain','needs_replan','completed','superseded')),
      reason text, created_at timestamptz NOT NULL DEFAULT now(), approved_at timestamptz
    );
    CREATE UNIQUE INDEX IF NOT EXISTS one_live_plan ON plans(scenario_id)
      WHERE status IN ('approved','executing','uncertain');
    CREATE TABLE IF NOT EXISTS approvals (
      plan_id uuid PRIMARY KEY REFERENCES plans(id), plan_hash text NOT NULL,
      actor text NOT NULL, approved_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS actions (
      id text PRIMARY KEY, plan_id uuid NOT NULL REFERENCES plans(id), ordinal integer NOT NULL,
      allocation jsonb NOT NULL, stage text NOT NULL DEFAULT 'pending',
      reservation jsonb, shipment jsonb, error text,
      UNIQUE(plan_id,ordinal)
    );
    CREATE TABLE IF NOT EXISTS events (
      seq bigserial PRIMARY KEY, scenario_id uuid NOT NULL, at timestamptz NOT NULL DEFAULT now(),
      plan_id uuid REFERENCES plans(id), action_id text REFERENCES actions(id),
      kind text NOT NULL, message text NOT NULL, data jsonb NOT NULL DEFAULT '{}'
    );
    CREATE INDEX IF NOT EXISTS events_scenario ON events(scenario_id, seq);
