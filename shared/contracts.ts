export type Strategy = 'optimized' | 'greedy';
export interface Order {
  id: string;
  factory: string;
  part: string;
  quantity: number;
  deadlineHours: number;
  priority: number;
}
export interface Stock {
  warehouse: string;
  part: string;
  available: number;
  version: number;
}
export interface Lane {
  id: string;
  warehouse: string;
  factory: string;
  mode: string;
  hours: number;
  unitCost: number;
  capacity: number;
}
export interface Scenario {
  id: string;
  name: string;
  description: string;
  orders: Order[];
  lanes: Lane[];
}
export interface Snapshot {
  observedAt: string;
  stock: Stock[];
}
export interface SolverInput {
  orders: Order[];
  stock: Stock[];
  lanes: Lane[];
  strategy: Strategy;
}
export interface Allocation {
  orderId: string;
  warehouse: string;
  part: string;
  quantity: number;
  laneId: string;
  mode: string;
  hours: number;
  cost: number;
  stockVersion: number;
}
export interface Solution {
  allocations: Allocation[];
  unfilled: string[];
  totalCost: number;
  fulfilledPriority: number;
  solverStatus: string;
  solveMs: number;
  explanation: string;
}
export type PlanStatus =
  | 'proposed'
  | 'approved'
  | 'executing'
  | 'uncertain'
  | 'needs_replan'
  | 'completed'
  | 'superseded';
export type ActionStage =
  | 'pending'
  | 'reserving'
  | 'reserved'
  | 'dispatching'
  | 'dispatch_unknown'
  | 'dispatched'
  | 'completed'
  | 'blocked';
export interface Action {
  id: string;
  planId: string;
  allocation: Allocation;
  stage: ActionStage;
  reservation: unknown | null;
  shipment: unknown | null;
  error: string | null;
}
export interface Plan {
  cancelReason?: string | null;
  id: string;
  scenarioId: string;
  strategy: Strategy;
  snapshot: Snapshot;
  solution: Solution;
  hash: string;
  status: PlanStatus;
  reason: string | null;
  createdAt: string;
  approvedAt: string | null;
  actions: Action[];
}
export interface AuditEvent {
  seq: number;
  at: string;
  planId: string | null;
  actionId: string | null;
  kind: string;
  message: string;
  data: Record<string, unknown>;
}
export interface Shipment {
  key: string;
  scenarioId: string;
  orderId: string;
  warehouse: string;
  quantity: number;
  laneId: string;
  cost: number;
  status: 'dispatched';
  createdAt: string;
}
export interface Reservation {
  key: string;
  scenarioId: string;
  warehouse: string;
  part: string;
  quantity: number;
  version: number;
  status: 'held' | 'consumed' | 'released';
}
export interface World {
  stock: Stock[];
  reservations: Reservation[];
  shipments: Shipment[];
  carrierLookupAvailable: boolean;
}
export interface AppState {
  runtime?: {
    mode: 'demo' | 'pilot';
    demoControls: boolean;
    workspaceId: string;
    syntheticProviders?: boolean;
  };
  scenario: Scenario;
  snapshot: Snapshot;
  plans: Plan[];
  events: AuditEvent[];
  world: World | null;
  serviceWarning: string | null;
}

/** Workflow mutations return AppState. Pilot access requires an authenticated workspace.
 * GET /api/state
 * POST /api/operations {scenario} -> admin imports a preassigned provider dataset
 * POST /api/demo/reset {} -> new independent scenario epoch
 * POST /api/observe {} -> refresh cached stock, never silently changes a plan
 * POST /api/plans {strategy: 'optimized'|'greedy'}
 * POST /api/plans/:id/approve {hash: exact displayed plan.hash}
 * POST /api/plans/:id/execute {} -> all remaining actions, stops on uncertainty/staleness
 * POST /api/plans/:id/step {} -> one action; useful to demonstrate partial progress
 * POST /api/plans/:id/recover {} -> reconcile durable intents and continue if authorized
 * POST /api/plans/:id/cancel {reason} -> terminal provider cancellation or retained commitments
 * POST /api/demo/consume {warehouse,part,quantity} -> external stock change, NOT observation
 * POST /api/demo/fault {fault: 'lost_response'|'crash_after_dispatch'|'lookup_unavailable'|'clear'}
 * GET /api/audit -> {scenario,plans,events,world} downloadable evidence
 * GET /api/session -> {mode,principal}; POST /api/auth/login {key}; POST /api/auth/logout {}
 * Demo routes are absent in pilot mode; viewers cannot mutate workflow state.
 * Error responses {error: string}, HTTP 400/401/403/404/409/503.
 */
