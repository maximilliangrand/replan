import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  Action,
  AppState,
  AuditEvent,
  Plan,
  PlanStatus,
  Stock,
  Strategy,
} from '../shared/contracts';
import { AuthBoundary, ApiError, type Session } from './AuthBoundary';

const dollars = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 0,
});
const number = new Intl.NumberFormat('en-US');
const time = (value: string) =>
  new Date(value).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
const planLabels: Record<PlanStatus, string> = {
  proposed: 'Ready for review',
  approved: 'Approved',
  executing: 'In progress',
  uncertain: 'Needs reconciliation',
  needs_replan: 'New plan needed',
  completed: 'Dispatched',
  superseded: 'Replaced',
};
const actionLabels: Record<Action['stage'], string> = {
  pending: 'Not started',
  reserving: 'Reserving stock',
  reserved: 'Stock reserved',
  dispatching: 'Dispatch requested',
  dispatch_unknown: 'Outcome unknown',
  dispatched: 'Dispatch confirmed',
  completed: 'Dispatch confirmed',
  blocked: 'Needs attention',
};

type IconName =
  | 'arrow'
  | 'check'
  | 'refresh'
  | 'download'
  | 'chevron'
  | 'box'
  | 'shield'
  | 'warning'
  | 'clock'
  | 'bolt'
  | 'activity'
  | 'x';
function Icon({
  name,
  size = 18,
  className = '',
}: {
  name: IconName;
  size?: number;
  className?: string;
}) {
  const paths: Record<IconName, React.ReactNode> = {
    arrow: (
      <>
        <path d="M4 12h15m-5-5 5 5-5 5" />
      </>
    ),
    check: <path d="m5 12 4 4L19 6" />,
    refresh: (
      <>
        <path d="M20 7v5h-5M4 17v-5h5" />
        <path d="M5.5 7a8 8 0 0 1 13-1L20 8M4 16l1.5 2a8 8 0 0 0 13-1" />
      </>
    ),
    download: (
      <>
        <path d="M12 3v12m-5-5 5 5 5-5M5 16v4h14v-4" />
      </>
    ),
    chevron: <path d="m6 9 6 6 6-6" />,
    box: (
      <>
        <path d="m12 3 9 5-9 5-9-5 9-5Z" />
        <path d="M3 8v9l9 5 9-5V8M12 13v9M7.5 5.5l9 5" />
      </>
    ),
    shield: (
      <>
        <path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6l8-3Z" />
        <path d="m8 12 3 3 5-6" />
      </>
    ),
    warning: (
      <>
        <path d="m12 3 10 18H2L12 3Z" />
        <path d="M12 9v5m0 3v.1" />
      </>
    ),
    clock: (
      <>
        <circle cx="12" cy="12" r="9" />
        <path d="M12 7v5l3 2" />
      </>
    ),
    bolt: <path d="m13 2-9 12h7l-1 8 10-13h-7l1-7Z" />,
    activity: <path d="M2 12h4l3-8 6 16 3-8h4" />,
    x: <path d="m6 6 12 12M6 18 18 6" />,
  };
  return (
    <svg
      width={size}
      height={size}
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths[name]}
    </svg>
  );
}

async function request(path: string, body?: object): Promise<AppState> {
  const response = await fetch(path, {
    signal: AbortSignal.timeout(15_000),
    ...(body === undefined
      ? {}
      : {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        }),
  });
  const data = (await response.json().catch(() => null)) as (AppState & { error?: string }) | null;
  if (!response.ok)
    throw new ApiError(
      response.status,
      data?.error ||
        (response.status >= 500
          ? 'The service was interrupted. A dispatch may already have happened. Wait for reconnection, then check and recover.'
          : `The service returned ${response.status}.`),
    );
  if (!data) throw new Error('The service returned an unreadable response.');
  return data;
}

function Status({ status }: { status: PlanStatus }) {
  const tone =
    status === 'completed'
      ? 'success'
      : ['uncertain', 'needs_replan'].includes(status)
        ? 'warning'
        : status === 'superseded'
          ? 'muted'
          : 'default';
  return (
    <span className={`status status-${tone}`}>
      <span />
      {planLabels[status]}
    </span>
  );
}

function AppHeader({
  busy,
  connected,
  onReset,
  onDownload,
  demoControls,
  session,
  onLogout,
}: {
  busy: boolean;
  connected: boolean;
  onReset: () => void;
  onDownload: () => void;
  demoControls: boolean;
  session: Session;
  onLogout: () => void;
}) {
  return (
    <header className={`app-header ${session.mode === 'pilot' ? 'pilot-header' : ''}`}>
      <a className="brand" href="/" aria-label="Replan home">
        <span className="brand-mark">
          <svg viewBox="0 0 32 32" fill="none" aria-hidden="true">
            <path
              d="M9 23V9h8c7 0 7 9 0 9H9m8 0 7 6"
              stroke="currentColor"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </span>
        replan<span className="brand-period">.</span>
      </a>
      <span className="header-caption">DECISIONS THAT SURVIVE REALITY</span>
      <div className="header-actions">
        {session.mode === 'pilot' && session.principal && (
          <span className="operator-identity">
            <strong>{session.principal.name}</strong>
            <span>
              {session.principal.role} · {session.principal.workspaceId}
            </span>
          </span>
        )}
        <span className={`connection ${connected ? '' : 'offline'}`}>
          <i />
          {connected ? 'System connected' : 'Reconnecting'}
        </span>
        <button className="button subtle small" onClick={onDownload} disabled={busy}>
          <Icon name="download" size={16} />
          <span>Export evidence</span>
        </button>
        {demoControls && (
          <button className="button subtle small" onClick={onReset} disabled={busy}>
            <Icon name="refresh" size={15} />
            <span>Reset demo</span>
          </button>
        )}
        {session.mode === 'pilot' && (
          <button className="button subtle small" onClick={onLogout} disabled={busy}>
            Sign out
          </button>
        )}
      </div>
    </header>
  );
}

function Inventory({
  stock,
  world,
  observedAt,
  busy,
  onObserve,
}: {
  stock: Stock[];
  world: AppState['world'];
  observedAt: string;
  busy: boolean;
  onObserve: () => void;
}) {
  const stale = world
    ? stock.some(
        (s) =>
          world.stock.find((w) => w.warehouse === s.warehouse && w.part === s.part)?.version !==
          s.version,
      )
    : false;
  return (
    <section className="panel inventory-panel" aria-labelledby="inventory-title">
      <div className="panel-heading">
        <div>
          <span className="eyebrow">01 / OBSERVE</span>
          <h2 id="inventory-title">Known inventory</h2>
        </div>
        <span className="small-icon">
          <Icon name="box" />
        </span>
      </div>
      <p className="panel-description">
        Plans use this snapshot. Refreshing it never changes an approved decision.
      </p>
      <div className="stock-list">
        {stock.map((s) => (
          <div className="stock-row" key={`${s.warehouse}-${s.part}`}>
            <div>
              <strong>{s.warehouse}</strong>
              <span>{s.part}</span>
            </div>
            <div className="stock-value">
              <strong>
                {number.format(s.available)}
                <small> units</small>
              </strong>
              <span>version {s.version}</span>
            </div>
          </div>
        ))}
      </div>
      <div className="inventory-footer">
        <span>
          <Icon name="clock" size={13} />
          Observed {time(observedAt)}
        </span>
        <button className="text-button" disabled={busy} onClick={onObserve}>
          <Icon name="refresh" size={14} />
          Refresh
        </button>
      </div>
      {stale && (
        <div className="inline-note amber">
          <Icon name="warning" size={15} />
          <span>The simulator has newer inventory. The planner has not seen it yet.</span>
        </div>
      )}
    </section>
  );
}

function AllocationTable({ plan, state }: { plan: Plan; state: AppState }) {
  return (
    <div className="table-scroll">
      <table className="allocation-table">
        <caption className="sr-only">Transfer allocations in the selected plan</caption>
        <thead>
          <tr>
            <th>Transfer</th>
            <th>Quantity</th>
            <th>Arrival</th>
            <th className="align-right">Cost</th>
          </tr>
        </thead>
        <tbody>
          {plan.solution.allocations.map((a, i) => {
            const order = state.scenario.orders.find((o) => o.id === a.orderId);
            return (
              <tr key={`${a.orderId}-${a.laneId}-${i}`}>
                <td>
                  <strong>
                    {a.warehouse}
                    <span className="route-arrow">→</span>
                    {order?.factory || a.orderId}
                  </strong>
                  <span className="cell-detail">
                    {a.part} · {a.mode}
                  </span>
                </td>
                <td>
                  {number.format(a.quantity)}
                  <span className="cell-detail">units</span>
                </td>
                <td>
                  <span className="arrival-time">{a.hours}h</span>
                  <span className="cell-detail">
                    {order ? `${order.deadlineHours}h deadline` : a.orderId}
                  </span>
                </td>
                <td className="align-right">
                  <strong>{dollars.format(a.cost)}</strong>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function ExecutionProgress({ plan, state }: { plan: Plan; state: AppState }) {
  if (!plan.actions.length) return null;
  const confirmed = plan.actions.filter((a) =>
    ['dispatched', 'completed'].includes(a.stage),
  ).length;
  return (
    <div className="execution-block">
      <div className="section-caption">
        <span>Execution record</span>
        <span>
          {confirmed} / {plan.actions.length} transfers confirmed
        </span>
      </div>
      <ol className="execution-list">
        {plan.actions.map((a) => {
          const done = ['dispatched', 'completed'].includes(a.stage);
          const warning = ['dispatch_unknown', 'blocked'].includes(a.stage);
          const order = state.scenario.orders.find((o) => o.id === a.allocation.orderId);
          return (
            <li
              className={`execution-row ${done ? 'done' : ''} ${warning ? 'attention' : ''}`}
              key={a.id}
            >
              <span className="step-icon">
                <Icon name={done ? 'check' : warning ? 'warning' : 'clock'} size={16} />
              </span>
              <div className="execution-info">
                <strong>
                  {a.allocation.warehouse} → {order?.factory || a.allocation.orderId}
                </strong>
                <span>
                  {a.allocation.quantity} units · {actionLabels[a.stage]}
                </span>
                {a.error && <p className="action-error">{a.error}</p>}
              </div>
              <details className="action-evidence">
                <summary
                  aria-label={`Show evidence for ${a.allocation.warehouse} to ${order?.factory || a.allocation.orderId}`}
                >
                  Evidence
                </summary>
                <pre>
                  {JSON.stringify(
                    {
                      actionId: a.id,
                      stage: a.stage,
                      reservation: a.reservation,
                      shipment: a.shipment,
                    },
                    null,
                    2,
                  )}
                </pre>
              </details>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

function PlanDetail({
  plan,
  state,
  busy,
  confirmedOrders,
  mutate,
  demoControls,
}: {
  plan: Plan;
  state: AppState;
  busy: boolean;
  confirmedOrders: ReadonlySet<string>;
  mutate: (path: string, body?: object, notice?: string) => Promise<void>;
  demoControls: boolean;
}) {
  const [cancelReason, setCancelReason] = useState('');
  const active = ['approved', 'executing'].includes(plan.status);
  const recovery = ['uncertain', 'executing'].includes(plan.status);
  const remainderHandled = plan.solution.allocations.every((allocation) =>
    confirmedOrders.has(allocation.orderId),
  );
  return (
    <div className="plan-detail">
      <div className="plan-detail-heading">
        <div>
          <span className="eyebrow">SELECTED DECISION</span>
          <h3>
            {plan.strategy === 'optimized' ? 'Optimized transfer plan' : 'Greedy transfer plan'}
          </h3>
        </div>
        <Status status={plan.status} />
      </div>
      <p className="plan-explanation">{plan.solution.explanation}</p>
      {!!plan.solution.unfilled.length && (
        <div className="inline-note amber">
          <Icon name="warning" size={16} />
          <span>
            This plan leaves {plan.solution.unfilled.length} order
            {plan.solution.unfilled.length === 1 ? '' : 's'} unfilled:{' '}
            {plan.solution.unfilled
              .map((id) => state.scenario.orders.find((o) => o.id === id)?.factory || id)
              .join(', ')}
            .
          </span>
        </div>
      )}
      <AllocationTable plan={plan} state={state} />
      <div className="plan-total">
        <span>
          {plan.approvedAt ? 'Approved' : 'Proposed'} transport cost{' '}
          <small>Dispatch is a commitment; it is not proof of delivery.</small>
        </span>
        <strong>{dollars.format(plan.solution.totalCost)}</strong>
      </div>
      {plan.reason && (
        <div
          className={`inline-note ${['uncertain', 'needs_replan'].includes(plan.status) ? 'amber' : ''}`}
        >
          <Icon name="warning" size={16} />
          <span>{plan.reason}</span>
        </div>
      )}
      {plan.status === 'proposed' && (
        <div className="approval-block">
          <div>
            <Icon name="shield" size={19} />
            <p>
              <strong>Your approval is specific.</strong>
              <span>
                It covers these allocations, stock versions and this cost. A changed plan needs a
                new approval.
              </span>
            </p>
          </div>
          <button
            className="button primary"
            disabled={busy || !plan.solution.allocations.length}
            onClick={() =>
              void mutate(
                `/api/plans/${plan.id}/approve`,
                { hash: plan.hash },
                'Plan approved. You can now dispatch it.',
              )
            }
          >
            <Icon name="check" />
            Approve {dollars.format(plan.solution.totalCost)}
          </button>
        </div>
      )}
      {(active || recovery) && (
        <div className="execution-controls">
          <div>
            <span className="eyebrow">03 / EXECUTE & RECOVER</span>
            <p>
              {recovery
                ? 'Check the carrier record before continuing. An unknown result is not a failed dispatch.'
                : 'Inventory is checked again before each reservation.'}
            </p>
          </div>
          <div className="button-group">
            {active && (
              <>
                <button
                  className="button secondary"
                  disabled={busy}
                  onClick={() =>
                    void mutate(
                      `/api/plans/${plan.id}/step`,
                      {},
                      'One transfer attempted. Review its recorded outcome below.',
                    )
                  }
                >
                  Dispatch one
                </button>
                <button
                  className="button primary"
                  disabled={busy}
                  onClick={() =>
                    void mutate(
                      `/api/plans/${plan.id}/execute`,
                      {},
                      'Execution attempt recorded. Review the transfer outcomes.',
                    )
                  }
                >
                  <Icon name="arrow" />
                  Dispatch remaining
                </button>
              </>
            )}
            {recovery && (
              <button
                className="button primary"
                disabled={busy}
                onClick={() =>
                  void mutate(
                    `/api/plans/${plan.id}/recover`,
                    {},
                    'Recovery attempt recorded. Review confirmed transfers and any remaining holds.',
                  )
                }
              >
                <Icon name="refresh" />
                Check & recover
              </button>
            )}
          </div>
        </div>
      )}
      {(active || recovery) && (
        <details className="cancellation-block">
          <summary>Cancel remaining transfers</summary>
          <p>
            Replan asks the carrier to close unconfirmed requests before releasing stock. Confirmed
            shipments remain committed. Any changed remaining work needs a new plan and approval. If
            the carrier cannot confirm cancellation, the plan stays on hold.
          </p>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (busy || cancelReason.trim().length < 10) return;
              void mutate(
                `/api/plans/${plan.id}/cancel`,
                { reason: cancelReason.trim() },
                'Cancellation attempt recorded. Review confirmed shipments and any remaining holds.',
              );
            }}
          >
            <label htmlFor={`cancel-${plan.id}`}>Reason for cancellation</label>
            <textarea
              id={`cancel-${plan.id}`}
              value={cancelReason}
              onChange={(event) => setCancelReason(event.target.value)}
              minLength={10}
              maxLength={1000}
              required
              disabled={busy}
              placeholder="Explain why the remaining transfers should stop."
            />
            <button
              className="button secondary small"
              type="submit"
              disabled={busy || cancelReason.trim().length < 10}
            >
              Cancel remaining transfers
            </button>
          </form>
        </details>
      )}
      {plan.status === 'needs_replan' && (
        <div className={`recovery-hint ${remainderHandled ? 'completed' : ''}`}>
          <Icon name={remainderHandled ? 'check' : 'refresh'} size={20} />
          <div>
            <strong>
              {remainderHandled
                ? 'The remaining orders were handled by later plans.'
                : 'Replan the remaining work.'}
            </strong>
            <p>
              {remainderHandled
                ? 'This original decision remains available with its approval and execution evidence.'
                : 'Refresh inventory and compare new proposals. Confirmed transfers stay in the execution record.'}
            </p>
          </div>
        </div>
      )}
      {plan.status === 'completed' && (
        <div className="recovery-hint completed">
          <Icon name="check" size={21} />
          <div>
            <strong>All transfers in this plan are confirmed.</strong>
            <p>
              Carrier dispatch records are attached to each action below. No delivery confirmation
              {demoControls ? 'is simulated.' : 'has been recorded.'}
            </p>
          </div>
        </div>
      )}
      <ExecutionProgress plan={plan} state={state} />
      <details className="decision-details">
        <summary>
          Decision provenance <Icon name="chevron" size={14} />
        </summary>
        <dl>
          <div>
            <dt>Approval fingerprint</dt>
            <dd className="hash">{plan.hash}</dd>
          </div>
          <div>
            <dt>Created</dt>
            <dd>{new Date(plan.createdAt).toLocaleString()}</dd>
          </div>
          <div>
            <dt>Approved</dt>
            <dd>
              {plan.approvedAt ? new Date(plan.approvedAt).toLocaleString() : 'Awaiting review'}
            </dd>
          </div>
          <div>
            <dt>Stock evidence</dt>
            <dd>
              {plan.snapshot.stock
                .map((s) => `${s.warehouse}: ${s.available} ${s.part} (v${s.version})`)
                .join(' · ')}
            </dd>
          </div>
          <div>
            <dt>Solver</dt>
            <dd>
              {plan.solution.solverStatus} · {Math.round(plan.solution.solveMs)} ms
            </dd>
          </div>
          <div>
            <dt>Plan ID</dt>
            <dd className="hash">{plan.id}</dd>
          </div>
        </dl>
      </details>
    </div>
  );
}

function Simulation({
  state,
  busy,
  mutate,
}: {
  state: AppState;
  busy: boolean;
  mutate: (path: string, body?: object, notice?: string) => Promise<void>;
}) {
  const [stockKey, setStockKey] = useState('');
  const [quantity, setQuantity] = useState('1');
  const available = state.world?.stock || state.snapshot.stock;
  const selectedStock =
    available.find((s) => JSON.stringify([s.warehouse, s.part]) === stockKey) || available[0];
  const faults = [
    {
      key: 'lost_response',
      title: 'Lose the carrier response',
      description: 'Carrier accepts the next dispatch; its reply never reaches Replan.',
      icon: 'activity' as const,
    },
    {
      key: 'crash_after_dispatch',
      title: 'Crash after dispatch',
      description: 'Stop the application after the carrier commits, before local confirmation.',
      icon: 'bolt' as const,
    },
    {
      key: 'lookup_unavailable',
      title: 'Make lookup unavailable',
      description: 'Recovery must hold if it cannot verify the carrier outcome.',
      icon: 'warning' as const,
    },
  ];
  return (
    <section className="panel simulation-panel" aria-labelledby="simulation-title">
      <div className="panel-heading">
        <div>
          <span className="eyebrow">CONTROLLED FAILURE LAB</span>
          <h2 id="simulation-title">Make reality change.</h2>
        </div>
        <span className="lab-pill">SIMULATION</span>
      </div>
      <p className="panel-description">
        Introduce a real state change in the demo services. Watch the approved decision respond.
      </p>
      <div className="fault-options">
        {faults.map((f) => (
          <button
            className="fault-option"
            key={f.key}
            disabled={busy}
            onClick={() => {
              void mutate(
                '/api/demo/fault',
                { fault: f.key },
                f.key === 'lookup_unavailable'
                  ? 'Carrier lookup is unavailable. Recovery must wait until it can verify the outcome.'
                  : 'Fault set for the next dispatch. Approve a plan, then dispatch a transfer.',
              );
            }}
          >
            <span className="fault-icon">
              <Icon name={f.icon} size={17} />
            </span>
            <span>
              <strong>{f.title}</strong>
              <small>{f.description}</small>
            </span>
            <Icon name="arrow" size={16} />
          </button>
        ))}
      </div>
      <div className="consume-control">
        <span className="section-caption">Consume stock outside Replan</span>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (selectedStock && Number.isInteger(Number(quantity)) && Number(quantity) > 0)
              void mutate(
                '/api/demo/consume',
                {
                  warehouse: selectedStock.warehouse,
                  part: selectedStock.part,
                  quantity: Number(quantity),
                },
                'External stock changed. The observation and approved plan were not silently updated.',
              );
          }}
        >
          <label className="sr-only" htmlFor="consume-warehouse">
            Inventory item to consume
          </label>
          <select
            id="consume-warehouse"
            disabled={busy || !available.length}
            value={
              selectedStock ? JSON.stringify([selectedStock.warehouse, selectedStock.part]) : ''
            }
            onChange={(e) => setStockKey(e.target.value)}
          >
            {available.map((s) => (
              <option
                value={JSON.stringify([s.warehouse, s.part])}
                key={`${s.warehouse}-${s.part}`}
              >
                {s.warehouse} · {s.part}
              </option>
            ))}
          </select>
          <div className="consume-input-row">
            <label htmlFor="consume-quantity">Units</label>
            <input
              id="consume-quantity"
              type="number"
              min="1"
              step="1"
              required
              value={quantity}
              onChange={(e) => setQuantity(e.target.value)}
              disabled={busy}
            />
            <button
              className="button secondary small"
              type="submit"
              disabled={busy || !selectedStock}
            >
              Consume stock
            </button>
          </div>
        </form>
      </div>
      <button
        className="text-button clear-faults"
        disabled={busy}
        onClick={() => {
          void mutate(
            '/api/demo/fault',
            { fault: 'clear' },
            'Faults cleared; carrier lookup is available again.',
          );
        }}
      >
        <Icon name="refresh" size={14} />
        Restore normal service
      </button>
      <p className="crash-note">
        The local development runner restarts the backend after a crash. Wait for reconnection, then
        check and recover. Do not reset the demo.
      </p>
    </section>
  );
}

function WorldTruth({ world }: { world: AppState['world'] }) {
  return (
    <details className="panel truth-panel">
      <summary>
        <div>
          <span className="eyebrow">EVALUATOR VIEW</span>
          <h2>What actually happened</h2>
        </div>
        <Icon name="chevron" size={18} />
      </summary>
      <div className="truth-content">
        <p className="panel-description">
          Independent simulator records. These are shown for inspection and are not the planner’s
          inventory snapshot.
        </p>
        {world ? (
          <>
            <div className="truth-summary">
              <div>
                <strong>{world.shipments.length}</strong>
                <span>carrier dispatches</span>
              </div>
              <div>
                <strong>{world.reservations.filter((r) => r.status === 'held').length}</strong>
                <span>held reservations</span>
              </div>
            </div>
            <p className="truth-lookup">
              <span className={`connection ${world.carrierLookupAvailable ? '' : 'offline'}`}>
                <i />
                Carrier lookup {world.carrierLookupAvailable ? 'available' : 'unavailable'}
              </span>
            </p>
            <div className="stock-list">
              {world.stock.map((s) => (
                <div className="stock-row" key={`${s.warehouse}-${s.part}`}>
                  <div>
                    <strong>{s.warehouse}</strong>
                    <span>{s.part}</span>
                  </div>
                  <div className="stock-value">
                    <strong>
                      {s.available}
                      <small> units</small>
                    </strong>
                    <span>version {s.version}</span>
                  </div>
                </div>
              ))}
            </div>
            {world.shipments.length > 0 && (
              <div className="truth-shipments">
                <span className="section-caption">Carrier commitments</span>
                {world.shipments.map((s) => (
                  <div className="truth-shipment" key={s.key}>
                    <Icon name="check" size={14} />
                    <div>
                      <strong>
                        {s.orderId} · {s.quantity} units
                      </strong>
                      <span>
                        {s.warehouse} · {dollars.format(s.cost)}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </>
        ) : (
          <div className="inline-note amber">Simulator records are currently unavailable.</div>
        )}
      </div>
    </details>
  );
}

function EventLog({ events }: { events: AuditEvent[] }) {
  const [all, setAll] = useState(false);
  const ordered = [...events].sort((a, b) => b.seq - a.seq);
  const visible = all ? ordered : ordered.slice(0, 8);
  return (
    <section className="panel audit-panel" aria-labelledby="audit-title">
      <div className="panel-heading">
        <div>
          <span className="eyebrow">EVERY DECISION HAS A RECEIPT</span>
          <h2 id="audit-title">Decision trail</h2>
        </div>
        <span className="count-badge">{events.length} events</span>
      </div>
      <p className="panel-description">
        A chronological record of observations, approvals and external outcomes. Open an event to
        inspect its evidence.
      </p>
      {events.length ? (
        <ol className="audit-list">
          {visible.map((event) => (
            <li key={event.seq}>
              <details>
                <summary>
                  <span
                    className={`event-dot ${/unknown|blocked|stale|fail|crash/.test(event.kind) ? 'event-warning' : /complete|confirmed|approv/.test(event.kind) ? 'event-success' : ''}`}
                  />
                  <span className="event-content">
                    <span className="event-kind">
                      {event.kind.replaceAll('_', ' ').replaceAll('.', ' / ')}
                    </span>
                    <span className="event-message">{event.message}</span>
                  </span>
                  <time dateTime={event.at}>{time(event.at)}</time>
                  <Icon name="chevron" size={14} />
                </summary>
                <div className="event-evidence">
                  <div className="event-reference">
                    Event #{event.seq}
                    {event.planId ? ` · Plan ${event.planId}` : ''}
                    {event.actionId ? ` · Action ${event.actionId}` : ''}
                  </div>
                  <pre>{JSON.stringify(event.data, null, 2)}</pre>
                </div>
              </details>
            </li>
          ))}
        </ol>
      ) : (
        <div className="empty-small">Your first observation will start the decision trail.</div>
      )}
      {ordered.length > 8 && (
        <button className="text-button show-events" onClick={() => setAll((v) => !v)}>
          {all ? 'Show recent events' : `Show all ${ordered.length} events`}
          <Icon name="chevron" size={14} />
        </button>
      )}
    </section>
  );
}

export function App() {
  return (
    <AuthBoundary>
      {(session, onUnauthorized, onLogout) => (
        <Workbench session={session} onUnauthorized={onUnauthorized} onLogout={onLogout} />
      )}
    </AuthBoundary>
  );
}

export function Workbench({
  session,
  onUnauthorized,
  onLogout,
}: {
  session: Session;
  onUnauthorized: (mutationInFlight: boolean) => void;
  onLogout: () => void;
}) {
  const [state, setState] = useState<AppState | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const busyRef = useRef(false);
  const unconfirmedRequest = useRef(false);
  const refreshingRef = useRef(false);
  const requestNumber = useRef(0);

  const refresh = useCallback(
    async (explicit = false) => {
      if (busyRef.current || refreshingRef.current) return;
      refreshingRef.current = true;
      const current = ++requestNumber.current;
      try {
        const data = await request('/api/state');
        if (current !== requestNumber.current) return;
        setState(data);
        setConnected(true);
        if (explicit) setError(null);
      } catch (cause) {
        if (current !== requestNumber.current) return;
        if (cause instanceof ApiError && cause.status === 401) {
          onUnauthorized(busyRef.current || unconfirmedRequest.current);
          return;
        }
        setConnected(false);
        if (explicit || cause instanceof ApiError)
          setError(cause instanceof Error ? cause.message : 'Unable to reach the service.');
      } finally {
        refreshingRef.current = false;
        if (current === requestNumber.current) setLoading(false);
      }
    },
    [onUnauthorized],
  );

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void refresh();
    }, 4000);
    const focus = () => void refresh();
    window.addEventListener('focus', focus);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('focus', focus);
    };
  }, [refresh]);

  const mutate = useCallback(
    async (path: string, body: object = {}, success?: string) => {
      if (busyRef.current || session.principal?.role === 'viewer') return;
      busyRef.current = true;
      unconfirmedRequest.current = true;
      setBusy(true);
      setError(null);
      setNotice(null);
      ++requestNumber.current;
      try {
        const data = await request(path, body);
        unconfirmedRequest.current = false;
        setState(data);
        setConnected(true);
        if (path === '/api/plans')
          setSelectedId(
            [...data.plans].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]?.id || null,
          );
        if (path === '/api/demo/reset') setSelectedId(null);
        if (success) setNotice(success);
      } catch (cause) {
        if (cause instanceof ApiError && cause.status === 401) {
          onUnauthorized(true);
          return;
        }
        if (cause instanceof ApiError && cause.status < 500) unconfirmedRequest.current = false;
        const message =
          cause instanceof Error ? cause.message : 'The action could not be confirmed.';
        const network =
          cause instanceof TypeError ||
          (cause instanceof DOMException && ['TimeoutError', 'AbortError'].includes(cause.name));
        if (network) setConnected(false);
        setError(
          network
            ? 'Connection interrupted. A dispatch may already have happened. Wait for reconnection, then use “Check & recover” to verify the outcome before continuing.'
            : message,
        );
      } finally {
        busyRef.current = false;
        setBusy(false);
        setLoading(false);
        void refresh();
      }
    },
    [refresh, onUnauthorized, session.principal?.role],
  );

  const download = async () => {
    try {
      const response = await fetch('/api/audit', {
        signal: AbortSignal.timeout(15_000),
      });
      if (response.status === 401) {
        onUnauthorized(busyRef.current || unconfirmedRequest.current);
        return;
      }
      if (!response.ok) throw new Error('Evidence export is currently unavailable.');
      const data: unknown = await response.json();
      const blob = new Blob([JSON.stringify(data, null, 2)], {
        type: 'application/json',
      });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = 'replan-evidence.json';
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Evidence export failed.');
    }
  };
  const plans = state
    ? [...state.plans].sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    : [];
  const unresolved = plans.find((p) => ['approved', 'uncertain', 'executing'].includes(p.status));
  const readOnly = session.principal?.role === 'viewer';
  const controlsBlocked = busy || !connected || readOnly;
  const demoControls = session.mode === 'demo' && state?.runtime?.demoControls !== false;
  const propose = (strategy: Strategy) =>
    void mutate(
      '/api/plans',
      { strategy },
      'Proposal ready. Review its allocations and evidence before approving.',
    );
  // Operational totals use durable application evidence. Simulator truth may
  // already contain a dispatch whose response the application never received.
  const confirmedActions = [
    ...new Map(
      plans.flatMap((plan) =>
        plan.actions
          .filter(
            (action) =>
              action.shipment !== null && ['dispatched', 'completed'].includes(action.stage),
          )
          .map((action) => [action.id, action] as const),
      ),
    ).values(),
  ];
  const confirmedOrders = new Set(confirmedActions.map((action) => action.allocation.orderId));
  const selected =
    plans.find((p) => p.id === selectedId) ||
    unresolved ||
    plans.find(
      (p) =>
        p.status === 'needs_replan' &&
        p.solution.allocations.some((allocation) => !confirmedOrders.has(allocation.orderId)),
    ) ||
    plans.find((p) => p.status === 'proposed') ||
    plans[0];
  const confirmedCost = confirmedActions.reduce((sum, action) => sum + action.allocation.cost, 0);
  const allOrdersDispatched =
    state !== null &&
    state.scenario.orders.length > 0 &&
    state.scenario.orders.every((order) => confirmedOrders.has(order.id));
  const canPropose = !controlsBlocked && !unresolved && !allOrdersDispatched;

  return (
    <>
      <AppHeader
        busy={busy}
        connected={connected}
        onReset={() =>
          void mutate(
            '/api/demo/reset',
            {},
            'A fresh synthetic scenario is ready. Earlier scenario evidence remains stored separately.',
          )
        }
        onDownload={() => void download()}
        demoControls={demoControls}
        session={session}
        onLogout={onLogout}
      />
      <main className="app-main">
        {demoControls ? (
          <div className="demo-ribbon">
            <span className="demo-tag">PUBLIC DEMO</span>
            <span>
              Synthetic factories. Independent inventory and carrier services. Real failure
              recovery.
            </span>
            <span className="ribbon-end">NO LIVE SHIPMENTS</span>
          </div>
        ) : (
          <div className="demo-ribbon pilot-ribbon">
            <span className="demo-tag">PRIVATE PILOT</span>
            <span>
              {readOnly
                ? 'Read-only access. An operator must approve and execute changes.'
                : 'Actions are attributed to your operator identity.'}
            </span>
            <span className="ribbon-end">{session.principal?.workspaceId}</span>
          </div>
        )}
        {session.mode === 'pilot' && state?.runtime?.syntheticProviders && (
          <div className="notice-banner" role="note" aria-label="Provider environment">
            <Icon name="box" />
            <span>Simulated inventory and carrier. No real shipments.</span>
          </div>
        )}
        {error && (
          <div className="notice-banner error" role="alert">
            <Icon name="warning" />
            <span>{error}</span>
            <button aria-label="Dismiss error" onClick={() => setError(null)}>
              <Icon name="x" size={16} />
            </button>
          </div>
        )}
        {notice && (
          <div className="notice-banner success" role="status">
            <Icon name="check" />
            <span>{notice}</span>
            <button aria-label="Dismiss notification" onClick={() => setNotice(null)}>
              <Icon name="x" size={16} />
            </button>
          </div>
        )}
        {state && !connected && (
          <div className="notice-banner warning" role="status">
            <Icon name="activity" />
            <span>
              Showing the last known state. The service is reconnecting; do not assume an
              unconfirmed dispatch failed.
            </span>
            <button className="text-button" onClick={() => void refresh(true)}>
              Retry connection
            </button>
          </div>
        )}
        {state?.serviceWarning && (
          <div className="notice-banner warning" role="status">
            <Icon name="warning" />
            <span>{state.serviceWarning}</span>
          </div>
        )}
        {!state ? (
          <section className="startup">
            <span className="eyebrow">A SMALL INTERRUPTION. A BETTER DECISION.</span>
            <h1>Plans meet reality here.</h1>
            <p>
              Replan turns disrupted parts transfers into approved, traceable actions — and recovers
              when the world changes halfway through.
            </p>
            <div className="startup-state">
              {loading ? (
                <>
                  <span className="spinner" />
                  Connecting to the local services…
                </>
              ) : (
                <>
                  <Icon name="activity" />
                  <span>
                    {demoControls
                      ? 'The demo is not ready yet. Start the services, or create a fresh scenario once they are running.'
                      : 'This workspace is not ready yet. If it is empty, an administrator must import its scenario before planning can begin.'}
                  </span>
                </>
              )}
            </div>
            <div className="button-group">
              {demoControls && (
                <button
                  className="button primary"
                  disabled={busy || loading}
                  onClick={() =>
                    void mutate('/api/demo/reset', {}, 'Your synthetic scenario is ready.')
                  }
                >
                  Start demo
                  <Icon name="arrow" />
                </button>
              )}
              <button
                className="button secondary"
                disabled={busy}
                onClick={() => void refresh(true)}
              >
                Retry connection
              </button>
            </div>
          </section>
        ) : (
          <>
            <section className="hero">
              <div>
                <div className="hero-kicker">
                  <span className="live-dot" />
                  OPERATIONS WORKBENCH
                  <span className="kicker-separator">/</span>CRITICAL PARTS
                </div>
                <h1>A disruption is a decision.</h1>
                <p>Make a plan. Approve the tradeoffs. Recover without losing the truth.</p>
              </div>
              <div className="hero-symbol" aria-hidden="true">
                <span className="orbit orbit-1" />
                <span className="orbit orbit-2" />
                <div className="hero-symbol-box">
                  <Icon name="box" size={30} />
                </div>
                <div className="hero-symbol-check">
                  <Icon name="check" size={16} />
                </div>
              </div>
            </section>
            <section className="scenario-strip" aria-labelledby="scenario-title">
              <div className="scenario-description">
                <span className="eyebrow">CURRENT DISRUPTION</span>
                <h2 id="scenario-title">{state.scenario.name}</h2>
                <p>{state.scenario.description}</p>
              </div>
              <div className="scenario-metrics">
                <div>
                  <span>Repair orders</span>
                  <strong>
                    {state.scenario.orders.length}
                    <small> to protect</small>
                  </strong>
                </div>
                <div>
                  <span>Confirmed dispatches</span>
                  <strong>
                    {confirmedActions.length}
                    <small> recorded</small>
                  </strong>
                </div>
                <div>
                  <span>Confirmed transport cost</span>
                  <strong>{dollars.format(confirmedCost)}</strong>
                </div>
              </div>
            </section>
            <div className="workbench-grid">
              <div className="primary-column">
                <section className="panel demand-panel" aria-labelledby="demand-title">
                  <div className="panel-heading">
                    <div>
                      <span className="eyebrow">THE OUTCOME TO PROTECT</span>
                      <h2 id="demand-title">Keep the repair moving.</h2>
                    </div>
                    <span className="count-badge">
                      {state.scenario.orders.reduce((sum, o) => sum + o.quantity, 0)} parts needed
                    </span>
                  </div>
                  <div className="demand-grid">
                    {state.scenario.orders.map((order) => (
                      <div className="demand-item" key={order.id}>
                        <div className="demand-top">
                          <span className="factory-label">{order.factory}</span>
                          {confirmedOrders.has(order.id) && (
                            <span
                              className="tiny-check"
                              title="At least one carrier dispatch recorded"
                              aria-label="At least one carrier dispatch recorded"
                            >
                              <Icon name="check" size={13} />
                            </span>
                          )}
                        </div>
                        <strong>
                          {order.quantity} <span>{order.part}</span>
                        </strong>
                        <div className="demand-bottom">
                          <span>
                            <Icon name="clock" size={13} />
                            {order.deadlineHours}h deadline
                          </span>
                          <span>Priority {order.priority}</span>
                        </div>
                      </div>
                    ))}
                  </div>
                </section>
                <section
                  className="panel decision-panel"
                  aria-labelledby="decision-title"
                  aria-busy={busy}
                >
                  <div className="panel-heading">
                    <div>
                      <span className="eyebrow">02 / DECIDE</span>
                      <h2 id="decision-title">Choose the next best move.</h2>
                    </div>
                    <span className="small-icon">
                      <Icon name="arrow" />
                    </span>
                  </div>
                  <p className="panel-description">
                    Compare allocation strategies against the same observed inventory. Review every
                    commitment before it leaves the system.
                  </p>
                  <div className="proposal-controls">
                    <button
                      className="button primary"
                      onClick={() => propose('optimized')}
                      disabled={!canPropose}
                    >
                      <Icon name="bolt" size={16} />
                      Optimize a plan
                    </button>
                    <button
                      className="button secondary"
                      onClick={() => propose('greedy')}
                      disabled={!canPropose}
                    >
                      Compare greedy
                    </button>
                    <span>Deadline-aware · capacity constrained</span>
                  </div>
                  {unresolved && (
                    <div className="inline-note amber">
                      <Icon name="shield" size={16} />
                      <span>
                        Finish or recover the approved decision before proposing another.{' '}
                        <button
                          className="inline-button"
                          onClick={() => setSelectedId(unresolved.id)}
                        >
                          Inspect its outcome
                        </button>
                      </span>
                    </div>
                  )}
                  {allOrdersDispatched && !unresolved && (
                    <div className="inline-note">
                      <Icon name="check" size={16} />
                      <span>
                        All repair orders have confirmed dispatches.
                        {demoControls
                          ? ' Reset the demo to explore another disruption.'
                          : ' Their execution evidence remains available below.'}
                      </span>
                    </div>
                  )}
                  {!plans.length ? (
                    <div className="no-plans">
                      <div className="no-plans-mark">
                        <Icon name="arrow" size={26} />
                      </div>
                      <h3>Good decisions start with the constraints.</h3>
                      <p>
                        Generate an optimized proposal to see which warehouses and transport lanes
                        can protect the repair deadlines.
                      </p>
                      <div className="empty-constraints">
                        <span>
                          <Icon name="check" size={13} />
                          Available stock
                        </span>
                        <span>
                          <Icon name="check" size={13} />
                          Lane capacity
                        </span>
                        <span>
                          <Icon name="check" size={13} />
                          Repair deadlines
                        </span>
                      </div>
                    </div>
                  ) : (
                    <>
                      <div className="plan-selector" aria-label="Plan proposals">
                        {plans.map((plan, i) => (
                          <button
                            className={`plan-card ${selected?.id === plan.id ? 'is-selected' : ''}`}
                            key={plan.id}
                            aria-pressed={selected?.id === plan.id}
                            onClick={() => setSelectedId(plan.id)}
                          >
                            <span className="plan-card-top">
                              <span>
                                {plan.strategy === 'optimized' ? 'Optimized' : 'Greedy'}
                                <small>#{plans.length - i}</small>
                              </span>
                              <Icon name={selected?.id === plan.id ? 'check' : 'arrow'} size={15} />
                            </span>
                            <strong>{dollars.format(plan.solution.totalCost)}</strong>
                            <span className="plan-card-bottom">
                              {plan.solution.allocations.length} allocation
                              {plan.solution.allocations.length === 1 ? '' : 's'} ·{' '}
                              {plan.solution.unfilled.length
                                ? `${plan.solution.unfilled.length} unfilled`
                                : 'all remaining orders planned'}
                            </span>
                            <Status status={plan.status} />
                          </button>
                        ))}
                      </div>
                      {selected && (
                        <PlanDetail
                          key={selected.id}
                          plan={selected}
                          state={state}
                          busy={controlsBlocked}
                          confirmedOrders={confirmedOrders}
                          mutate={mutate}
                          demoControls={demoControls}
                        />
                      )}
                    </>
                  )}
                </section>
                <EventLog events={state.events} />
              </div>
              <aside className="secondary-column">
                <Inventory
                  stock={state.snapshot.stock}
                  world={demoControls ? state.world : null}
                  observedAt={state.snapshot.observedAt}
                  busy={controlsBlocked}
                  onObserve={() =>
                    void mutate(
                      '/api/observe',
                      {},
                      'Inventory observation refreshed. Existing decisions keep their original evidence.',
                    )
                  }
                />
                {demoControls && (
                  <Simulation
                    key={state.scenario.id}
                    state={state}
                    busy={controlsBlocked}
                    mutate={mutate}
                  />
                )}
                {demoControls && <WorldTruth world={state.world} />}
                <div className="principle-note">
                  <Icon name="shield" size={20} />
                  <p>
                    <strong>Uncertainty is a state, not an excuse to retry.</strong> Replan asks
                    what happened before deciding what should happen next.
                  </p>
                </div>
              </aside>
            </div>
          </>
        )}
        <footer className="app-footer">
          <span>
            <strong>replan.</strong> Built for the moment after the happy path.
          </span>
          <span>
            {demoControls
              ? 'Local demonstration · Synthetic data'
              : 'Private pilot · Scoped access'}{' '}
            · Human-approved decisions
          </span>
        </footer>
      </main>
      {busy && (
        <div className="busy-indicator" role="status">
          <span className="spinner" />
          Recording the next step…
        </div>
      )}
    </>
  );
}
