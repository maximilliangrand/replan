import { pool, type Connection } from './db.js';
import { principal } from './workspace.js';

export interface OperationAge {
  count: number;
  oldestAgeSeconds: number | null;
}

export interface OperationsHealth {
  observedAt: string;
  unresolved: OperationAge;
  cancellationPending: OperationAge;
  executing: OperationAge;
}

/** Read-only, workspace-scoped summary. It never retries or cancels an operation. */
export async function operationHealth(db: Connection = pool): Promise<OperationsHealth> {
  const actor = principal();
  // Read status and its history in one statement snapshot. Repeated attempts must
  // not make a long-running unresolved plan look new to the monitoring system.
  const result = await db.query(
    `WITH watched AS (
      SELECT p.id, p.status, p.cancel_reason, p.approved_at, p.created_at,
        min(e.at) FILTER (WHERE e.kind='plan.uncertain') AS uncertain_at,
        min(e.at) FILTER (WHERE e.kind='plan.cancellation_requested') AS cancellation_at,
        min(e.at) FILTER (WHERE e.kind='plan.executing') AS executing_at
      FROM plans p LEFT JOIN events e ON e.plan_id=p.id AND e.workspace_id=p.workspace_id
      WHERE p.workspace_id=$1 AND p.status IN ('approved','executing','uncertain')
      GROUP BY p.id
    )
    SELECT statement_timestamp() AS observed_at,
      count(*) FILTER (WHERE status='uncertain') AS unresolved_count,
      max(floor(greatest(0, extract(epoch FROM statement_timestamp() -
        coalesce(uncertain_at, approved_at, created_at)))))
        FILTER (WHERE status='uncertain') AS unresolved_age,
      count(*) FILTER (WHERE cancel_reason IS NOT NULL) AS cancellation_count,
      max(floor(greatest(0, extract(epoch FROM statement_timestamp() -
        coalesce(cancellation_at, approved_at, created_at)))))
        FILTER (WHERE cancel_reason IS NOT NULL) AS cancellation_age,
      count(*) FILTER (WHERE status='executing') AS executing_count,
      max(floor(greatest(0, extract(epoch FROM statement_timestamp() -
        coalesce(executing_at, approved_at, created_at)))))
        FILTER (WHERE status='executing') AS executing_age
    FROM watched`,
    [actor.workspaceId],
  );
  const row = result.rows[0];
  const age = (count: string, seconds: string | null): OperationAge => ({
    count: Number(count),
    oldestAgeSeconds: seconds === null ? null : Number(seconds),
  });
  return {
    observedAt: row.observed_at.toISOString(),
    unresolved: age(row.unresolved_count, row.unresolved_age),
    cancellationPending: age(row.cancellation_count, row.cancellation_age),
    executing: age(row.executing_count, row.executing_age),
  };
}
