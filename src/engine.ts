import type { PoolClient } from 'pg';
import type {
  Action,
  ActionStage,
  Plan,
  PlanStatus,
  Reservation,
  Shipment,
} from '../shared/contracts.js';
import { audit, Conflict, context, getPlan, getPlans, transaction } from './db.js';
import { canonicalJson, planHash } from './planner.js';
import { carrier, inventory, ProviderError } from './providers.js';
import { principal, workspaceId } from './workspace.js';
import { config } from './config.js';

async function status(db: PoolClient, plan: Plan, next: PlanStatus, reason: string | null) {
  await transaction(db, async () => {
    await db.query('UPDATE plans SET status=$2,reason=$3 WHERE id=$1', [plan.id, next, reason]);
    await audit(db, plan.scenarioId, `plan.${next}`, reason ?? `Plan ${next}.`, {}, plan.id);
  });
  plan.status = next;
  plan.reason = reason;
}
async function transition(
  db: PoolClient,
  plan: Plan,
  action: Action,
  stage: ActionStage,
  message: string,
  evidence: { reservation?: Reservation; shipment?: Shipment; error?: string | null } = {},
) {
  await transaction(db, async () => {
    await db.query('UPDATE actions SET stage=$2,reservation=$3,shipment=$4,error=$5 WHERE id=$1', [
      action.id,
      stage,
      evidence.reservation ?? action.reservation,
      evidence.shipment ?? action.shipment,
      evidence.error ?? null,
    ]);
    await audit(
      db,
      plan.scenarioId,
      `action.${stage}`,
      message,
      { ...evidence, orderId: action.allocation.orderId },
      plan.id,
      action.id,
    );
  });
  action.stage = stage;
  action.reservation = evidence.reservation ?? action.reservation;
  action.shipment = evidence.shipment ?? action.shipment;
  action.error = evidence.error ?? null;
}
async function block(db: PoolClient, plan: Plan, action: Action, message: string) {
  await transition(db, plan, action, 'blocked', message, { error: message });
  await status(db, plan, 'needs_replan', message);
}

function verifyReservation(
  reservation: Reservation,
  plan: Plan,
  action: Action,
  expected: Reservation['status'],
) {
  const a = action.allocation;
  if (
    reservation.key !== action.id ||
    reservation.scenarioId !== plan.scenarioId ||
    reservation.warehouse !== a.warehouse ||
    reservation.part !== a.part ||
    reservation.quantity !== a.quantity ||
    reservation.status !== expected
  )
    throw new Error(
      'Inventory evidence conflicts with the approved action. Manual review required.',
    );
}

export async function approve(db: PoolClient, id: string, hash: string) {
  const plan = await getPlan(id, db);
  if (hash !== plan.hash)
    throw new Conflict('The approval fingerprint does not match the displayed proposal.');
  if (planHash(plan.scenarioId, plan.strategy, plan.snapshot, plan.solution) !== plan.hash)
    throw new Conflict('Proposal integrity check failed. Generate a new proposal.');
  if (plan.status === 'approved') return;
  if (plan.status !== 'proposed') throw new Conflict('Only a proposed plan can be approved.');
  if (plan.solution.allocations.length === 0)
    throw new Conflict(
      'There are no feasible transfers to approve. Refresh observations or change the scenario.',
    );
  const ctx = await context(db);
  const plans = await getPlans(ctx.scenario.id, db);
  if (plans.some((p) => ['approved', 'executing', 'uncertain'].includes(p.status)))
    throw new Conflict('An approved plan is already in progress. Resolve it first.');
  const completedOrders = new Set(
    plans.flatMap((p) =>
      p.actions.filter((a) => a.stage === 'completed').map((a) => a.allocation.orderId),
    ),
  );
  if (plan.actions.some((a) => completedOrders.has(a.allocation.orderId)))
    throw new Conflict(
      'This proposal includes an order already dispatched. Create a new proposal.',
    );
  if (Date.now() - new Date(plan.snapshot.observedAt).getTime() > 10 * 60_000)
    throw new Conflict(
      'The proposal is over ten minutes old. Refresh stock and generate a new proposal.',
    );
  await transaction(db, async () => {
    await db.query('INSERT INTO approvals(plan_id,plan_hash,actor,actor_id) VALUES($1,$2,$3,$4)', [
      id,
      hash,
      principal().name,
      config.mode === 'pilot' ? principal().id : null,
    ]);
    await db.query("UPDATE plans SET status='approved',approved_at=now() WHERE id=$1", [id]);
    await db.query(
      "UPDATE plans SET status='superseded' WHERE scenario_id=$1 AND status='proposed' AND id<>$2",
      [plan.scenarioId, id],
    );
    await audit(
      db,
      plan.scenarioId,
      'plan.approved',
      'Operator approved the exact allocations, cost, and source versions.',
      { hash, totalCost: plan.solution.totalCost },
      id,
    );
  });
}

async function verifyApproval(db: PoolClient, plan: Plan) {
  const id = plan.id;
  const approval = (await db.query('SELECT plan_hash FROM approvals WHERE plan_id=$1', [id]))
    .rows[0];
  if (
    approval?.plan_hash !== plan.hash ||
    planHash(plan.scenarioId, plan.strategy, plan.snapshot, plan.solution) !== plan.hash ||
    canonicalJson(plan.actions.map((a) => a.allocation)) !==
      canonicalJson(plan.solution.allocations)
  )
    throw new Conflict('Approved plan integrity check failed. No actions were sent.');
}

export async function execute(db: PoolClient, id: string, oneStep = false) {
  const plan = await getPlan(id, db);
  if (plan.status === 'completed') return;
  if (plan.cancelReason) return cancelPlan(db, id, plan.cancelReason);
  if (!['approved', 'executing', 'uncertain'].includes(plan.status))
    throw new Conflict(
      'Approve this proposal before execution, or create a new plan after invalidation.',
    );
  await verifyApproval(db, plan);
  const ctx = await context(db);
  await status(db, plan, 'executing', null);
  for (const action of plan.actions) {
    if (action.stage === 'completed') continue;
    if (action.stage === 'blocked') {
      await status(db, plan, 'needs_replan', action.error);
      return;
    }
    const a = action.allocation;
    // A lookup reporting absence is point-in-time evidence, not cancellation of
    // a timed-out request that may still be processing inside the provider.
    const dispatchWasAttempted = ['dispatching', 'dispatch_unknown', 'dispatched'].includes(
      action.stage,
    );
    try {
      // Read the authoritative provider, including when local state says pending:
      // a previous process may have died before recording the external response.
      let reservation = await inventory.find(action.id);
      if (
        reservation &&
        (reservation.key !== action.id ||
          reservation.warehouse !== a.warehouse ||
          reservation.part !== a.part ||
          reservation.quantity !== a.quantity ||
          reservation.scenarioId !== plan.scenarioId)
      )
        throw new Error(
          'Reservation evidence conflicts with the approved action. Manual review required.',
        );
      if (reservation?.status === 'released') {
        await block(
          db,
          plan,
          action,
          'This reservation was released; a fresh proposal is required.',
        );
        return;
      }
      if (!reservation) {
        const order = ctx.scenario.orders.find((o) => o.id === a.orderId)!;
        if ((Date.now() - ctx.createdAt.getTime()) / 3_600_000 + a.hours > order.deadlineHours) {
          if (action.stage === 'reserving')
            throw new Error(
              'A previous reservation may still commit after the deadline. Reconcile inventory before approving a replacement.',
            );
          await block(
            db,
            plan,
            action,
            `The approved route for ${a.orderId} can no longer meet its repair window.`,
          );
          return;
        }
        const previous = plan.actions.filter(
          (x) =>
            x.stage === 'completed' &&
            x.allocation.warehouse === a.warehouse &&
            x.allocation.part === a.part,
        ).length;
        await transition(
          db,
          plan,
          action,
          'reserving',
          `Reserving ${a.quantity} kits at ${a.warehouse}.`,
        );
        try {
          reservation = await inventory.reserve({
            key: action.id,
            scenarioId: plan.scenarioId,
            warehouse: a.warehouse,
            part: a.part,
            quantity: a.quantity,
            expectedVersion: a.stockVersion + previous,
          });
          verifyReservation(reservation, plan, action, 'held');
        } catch (error) {
          if (error instanceof ProviderError && error.status === 409) {
            await block(
              db,
              plan,
              action,
              `Inventory changed at ${a.warehouse}. Refresh stock and approve a replacement for the remaining orders.`,
            );
            return;
          }
          throw error;
        }
      }
      if (!dispatchWasAttempted)
        await transition(db, plan, action, 'reserved', `Reservation confirmed at ${a.warehouse}.`, {
          reservation,
        });
      let shipment = await carrier.find(action.id, plan.scenarioId);
      if (!shipment) {
        if (reservation.status === 'consumed' || action.shipment)
          throw new Error(
            'Carrier lookup contradicts recorded dispatch evidence. Manual review required; no retry sent.',
          );
        const order = ctx.scenario.orders.find((o) => o.id === a.orderId)!;
        if ((Date.now() - ctx.createdAt.getTime()) / 3_600_000 + a.hours > order.deadlineHours) {
          if (dispatchWasAttempted)
            throw new Error(
              'A previous dispatch may still commit after the deadline. Inventory remains held pending carrier confirmation or manual review.',
            );
          const released = await inventory.release(action.id);
          verifyReservation(released, plan, action, 'released');
          await block(
            db,
            plan,
            action,
            `The repair window for ${a.orderId} expired before dispatch. The uncommitted reservation was released.`,
          );
          return;
        }
        await transition(
          db,
          plan,
          action,
          'dispatching',
          `Sending ${a.orderId} to the carrier with a stable commitment key.`,
        );
        shipment = await carrier.dispatch({
          key: action.id,
          scenarioId: plan.scenarioId,
          orderId: a.orderId,
          warehouse: a.warehouse,
          quantity: a.quantity,
          laneId: a.laneId,
          cost: a.cost,
        });
        // Intentionally die after the irreversible effect but before recording it.
        // The supervisor/test restarts a NEW process; no in-memory recovery shortcut.
        const crash = await db.query(
          'UPDATE scenario_state SET crash_next=false WHERE workspace_id=$1 AND crash_next=true RETURNING workspace_id',
          [workspaceId()],
        );
        if (crash.rowCount) process.exit(86);
      } else {
        await audit(
          db,
          plan.scenarioId,
          'carrier.reconciled',
          `Carrier confirms ${a.orderId} was already dispatched. No duplicate request sent.`,
          { shipment },
          plan.id,
          action.id,
        );
      }
      if (
        shipment.key !== action.id ||
        shipment.scenarioId !== plan.scenarioId ||
        shipment.orderId !== a.orderId ||
        shipment.warehouse !== a.warehouse ||
        shipment.quantity !== a.quantity ||
        shipment.laneId !== a.laneId ||
        shipment.cost !== a.cost
      )
        throw new Error(
          'Carrier evidence conflicts with the approved action. Manual review required.',
        );
      await transition(
        db,
        plan,
        action,
        'dispatched',
        `Carrier committed ${a.orderId}. This physical action is not rolled back.`,
        { shipment },
      );
      const consumed = await inventory.consume(action.id);
      verifyReservation(consumed, plan, action, 'consumed');
      await transition(
        db,
        plan,
        action,
        'completed',
        `${a.orderId} dispatched; inventory movement recorded.`,
        { reservation: consumed, shipment },
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : 'External outcome is unknown.';
      const next = action.stage === 'dispatching' ? 'dispatch_unknown' : action.stage;
      await transition(db, plan, action, next, message, { error: message });
      await status(
        db,
        plan,
        'uncertain',
        'An external outcome is unresolved. Reconcile before retrying or approving a replacement.',
      );
      return;
    }
    if (oneStep) break;
  }
  if (plan.actions.every((a) => a.stage === 'completed'))
    await status(
      db,
      plan,
      'completed',
      'All transfers in this approved plan were dispatched. Delivery is not simulated.',
    );
}

export async function markInterrupted(db: PoolClient) {
  const ctx = await context(db);
  for (const plan of await getPlans(ctx.scenario.id, db)) {
    if (plan.status === 'executing')
      await status(
        db,
        plan,
        'uncertain',
        'The executor restarted. Reconcile external outcomes before resuming.',
      );
  }
}

/** Terminal provider cancellation wins the same per-key lock as creation.
 * A missing receipt alone never authorizes releasing potentially committed stock.
 * The durable intent routes every subsequent retry back through cancellation.
 */
export async function cancelPlan(db: PoolClient, id: string, reason: string) {
  const plan = await getPlan(id, db);
  if (plan.status === 'completed' || (plan.status === 'needs_replan' && plan.cancelReason)) return;
  if (!['approved', 'executing', 'uncertain'].includes(plan.status))
    throw new Conflict('Only an approved or unresolved operation can be cancelled.');
  await verifyApproval(db, plan);
  const originalReason = plan.cancelReason ?? reason;
  if (!plan.cancelReason) {
    await transaction(db, async () => {
      await db.query(
        "UPDATE plans SET cancel_reason=$2,status='uncertain',reason='Cancellation requested; provider outcomes are being reconciled.' WHERE id=$1",
        [id, originalReason],
      );
      await audit(
        db,
        plan.scenarioId,
        'plan.cancellation_requested',
        'Operator requested terminal cancellation of the remaining work.',
        { reason: originalReason },
        id,
      );
    });
  }
  for (const action of plan.actions) {
    if (action.stage === 'completed') continue;
    try {
      const outcome = await carrier.cancel(action.id, plan.scenarioId, originalReason);
      if (outcome.outcome === 'dispatched') {
        const s = outcome.shipment;
        const a = action.allocation;
        if (
          s.key !== action.id ||
          s.scenarioId !== plan.scenarioId ||
          s.orderId !== a.orderId ||
          s.warehouse !== a.warehouse ||
          s.quantity !== a.quantity ||
          s.laneId !== a.laneId ||
          s.cost !== a.cost
        )
          throw new Error('Carrier cancellation returned conflicting dispatch evidence.');
        await transition(
          db,
          plan,
          action,
          'dispatched',
          'Cancellation reconciled an already committed shipment; it is retained.',
          { shipment: s },
        );
        const reservation = await inventory.consume(action.id);
        verifyReservation(reservation, plan, action, 'consumed');
        await transition(
          db,
          plan,
          action,
          'completed',
          'The committed transfer is retained and inventory bookkeeping is complete.',
          { shipment: s, reservation },
        );
      } else {
        if (action.shipment || action.stage === 'dispatched')
          throw new Error(
            'Cancellation contradicts recorded dispatch evidence. Manual review required.',
          );
        if (outcome.key !== action.id || outcome.scenarioId !== plan.scenarioId)
          throw new Error('Carrier cancellation receipt does not match this operation.');
        await audit(
          db,
          plan.scenarioId,
          'carrier.cancelled',
          'Carrier guarantees this action key cannot commit a future shipment.',
          { receipt: outcome },
          id,
          action.id,
        );
        const cancelled = await inventory.cancel(action.id, plan.scenarioId, originalReason);
        if (cancelled.key !== action.id || cancelled.scenarioId !== plan.scenarioId)
          throw new Error('Inventory cancellation receipt does not match this operation.');
        if (cancelled.reservation)
          verifyReservation(cancelled.reservation, plan, action, 'released');
        await transition(
          db,
          plan,
          action,
          'blocked',
          'Transfer cancelled with terminal provider receipts.',
          {
            ...(cancelled.reservation ? { reservation: cancelled.reservation } : {}),
            error: originalReason,
          },
        );
        await audit(
          db,
          plan.scenarioId,
          'inventory.cancelled',
          'Inventory reservation is terminally cancelled; any held units were released.',
          { receipt: cancelled },
          id,
          action.id,
        );
      }
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Cancellation outcome is unresolved.';
      await status(
        db,
        plan,
        'uncertain',
        `Cancellation is pending: ${message} Retry recovery; a new plan remains blocked.`,
      );
      return;
    }
  }
  await status(
    db,
    plan,
    plan.actions.every((a) => a.stage === 'completed') ? 'completed' : 'needs_replan',
    'Cancellation reconciled. Confirmed transfers are retained; remaining demand requires a fresh proposal and approval.',
  );
}
