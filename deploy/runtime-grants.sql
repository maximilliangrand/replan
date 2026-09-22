-- Run as the owner after each reviewed migration; provision these LOGIN roles
-- and their distinct passwords using your database administration workflow.
-- Runtime can use data, not create/alter schema or change authorization fields.
GRANT CONNECT ON DATABASE replan TO replan_runtime;
GRANT USAGE ON SCHEMA public TO replan_runtime;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO replan_runtime;
-- PostgreSQL requires UPDATE on at least one column for login's row lock.
-- The identity UUID, key hash, role, workspace and disabled flag stay owner-only.
GRANT UPDATE(name) ON operators TO replan_runtime;
GRANT INSERT, UPDATE ON scenario_state, plans, approvals, actions, events TO replan_runtime;
GRANT INSERT, DELETE ON auth_sessions TO replan_runtime;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO replan_runtime;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
