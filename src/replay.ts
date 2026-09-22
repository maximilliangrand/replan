import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { z } from 'zod';

// Offline inspection only: no application, database, or provider imports.
const text = z.string().min(1).max(4096);
const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const timestamp = z
  .string()
  .refine((value) => Number.isFinite(Date.parse(value)), 'Invalid timestamp');
const stockSchema = z.object({ warehouse: text, part: text, available: integer, version: integer });
const allocationSchema = z
  .object({
    orderId: text,
    warehouse: text,
    part: text,
    quantity: integer.positive(),
    laneId: text,
    mode: text,
    hours: z.number().nonnegative(),
    cost: z.number().nonnegative(),
    stockVersion: integer,
  })
  .passthrough();
const reservationSchema = z.object({
  key: text,
  scenarioId: text,
  warehouse: text,
  part: text,
  quantity: integer.positive(),
  version: integer,
  status: z.enum(['held', 'consumed', 'released']),
});
const shipmentSchema = z.object({
  key: text,
  scenarioId: text,
  orderId: text,
  warehouse: text,
  quantity: integer.positive(),
  laneId: text,
  cost: z.number().nonnegative(),
  status: z.literal('dispatched'),
  createdAt: timestamp,
});
const eventSchema = z.object({
  seq: integer.positive(),
  at: timestamp,
  planId: text.nullable(),
  actionId: text.nullable(),
  kind: text,
  message: z.string().max(100_000),
  data: z.record(z.string(), z.unknown()),
});
const solutionSchema = z
  .object({
    allocations: z.array(allocationSchema).max(20_000),
    unfilled: z.array(text).max(20_000),
    totalCost: z.number().nonnegative(),
    fulfilledPriority: integer,
    solverStatus: text,
    solveMs: z.number().nonnegative(),
    explanation: z.string(),
  })
  .passthrough();
const planSchema = z.object({
  id: text,
  scenarioId: text,
  strategy: z.enum(['optimized', 'greedy']),
  snapshot: z
    .object({ observedAt: timestamp, stock: z.array(stockSchema).max(20_000) })
    .passthrough(),
  solution: solutionSchema,
  hash: z.string().regex(/^[a-f0-9]{64}$/),
  status: text,
  createdAt: timestamp,
  approvedAt: timestamp.nullable(),
  actions: z
    .array(
      z.object({
        id: text,
        planId: text,
        allocation: allocationSchema,
        stage: text,
        reservation: reservationSchema.nullable(),
        shipment: shipmentSchema.nullable(),
      }),
    )
    .max(20_000),
});
const exportSchema = z.object({
  schemaVersion: z.literal(1),
  exportedAt: timestamp,
  scenario: z.object({ id: text }).passthrough(),
  plans: z.array(planSchema).max(20_000),
  events: z.array(eventSchema).max(100_000),
  world: z
    .object({
      stock: z.array(stockSchema).max(20_000),
      reservations: z.array(reservationSchema).max(20_000),
      shipments: z.array(shipmentSchema).max(20_000),
      carrierLookupAvailable: z.boolean(),
    })
    .nullable(),
});

export interface EvidenceReport {
  valid: boolean;
  errors: string[];
  timeline: {
    seq: number;
    at: string;
    kind: string;
    planId: string | null;
    actionId: string | null;
    message: string;
  }[];
  metrics: {
    plans: number;
    events: number;
    approvals: number;
    dispatchIntents: number;
    shipments: number;
    distinctDispatchedOrders: number;
    committedCost: number;
    stockItemsChecked: number;
    unresolvedPlans: number;
    blockedPlans: number;
    worldAvailable: boolean;
  };
}

// Same serialization contract as approval, deliberately independent of the executor.
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object')
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(',')}}`;
  return JSON.stringify(value);
}
const stockKey = (item: { warehouse: string; part: string }) =>
  JSON.stringify([item.warehouse, item.part]);

export function verifyEvidence(input: unknown): EvidenceReport {
  const report: EvidenceReport = {
    valid: false,
    errors: [],
    timeline: [],
    metrics: {
      plans: 0,
      events: 0,
      approvals: 0,
      dispatchIntents: 0,
      shipments: 0,
      distinctDispatchedOrders: 0,
      committedCost: 0,
      stockItemsChecked: 0,
      unresolvedPlans: 0,
      blockedPlans: 0,
      worldAvailable: false,
    },
  };
  try {
    const parsed = exportSchema.safeParse(input);
    if (!parsed.success) {
      report.errors = parsed.error.issues
        .slice(0, 20)
        .map((issue) => `Malformed export at ${issue.path.join('.') || 'root'}: ${issue.message}`);
      return report;
    }
    const evidence = parsed.data;
    const fail = (message: string) => {
      report.errors.push(message);
    };
    const events = [...evidence.events].sort((a, b) => a.seq - b.seq);
    report.timeline = events.map(({ data: _data, ...event }) => event);
    report.metrics.plans = evidence.plans.length;
    report.metrics.events = events.length;
    report.metrics.unresolvedPlans = evidence.plans.filter((plan) =>
      ['approved', 'executing', 'uncertain'].includes(plan.status),
    ).length;
    // Historical invalidations remain visible even after a replacement finishes.
    report.metrics.blockedPlans = evidence.plans.filter(
      (plan) => plan.status === 'needs_replan',
    ).length;
    const plans = new Map(evidence.plans.map((plan) => [plan.id, plan]));
    if (plans.size !== evidence.plans.length) fail('Duplicate plan IDs.');
    const actions = new Map<
      string,
      { plan: z.infer<typeof planSchema>; action: z.infer<typeof planSchema>['actions'][number] }
    >();
    for (const plan of evidence.plans) {
      if (plan.scenarioId !== evidence.scenario.id)
        fail(`Plan ${plan.id} belongs to another scenario.`);
      const hash = createHash('sha256')
        .update(
          canonicalJson({
            scenarioId: plan.scenarioId,
            strategy: plan.strategy,
            snapshot: plan.snapshot,
            solution: plan.solution,
          }),
        )
        .digest('hex');
      if (hash !== plan.hash) fail(`Plan ${plan.id} fingerprint does not match its proposal.`);
      if (
        canonicalJson(plan.actions.map((action) => action.allocation)) !==
        canonicalJson(plan.solution.allocations)
      )
        fail(`Plan ${plan.id} actions differ from its proposal.`);
      if (
        plan.solution.totalCost !==
        plan.solution.allocations.reduce((total, allocation) => total + allocation.cost, 0)
      )
        fail(`Plan ${plan.id} has inconsistent total cost.`);
      for (const [index, action] of plan.actions.entries()) {
        if (actions.has(action.id)) fail(`Duplicate action key ${action.id}.`);
        if (action.planId !== plan.id || action.id !== `${plan.id}:${index}`)
          fail(`Action ${action.id} has an invalid plan binding.`);
        actions.set(action.id, { plan, action });
      }
    }

    const approvals = new Map<string, number>();
    const intents = new Map<string, z.infer<typeof eventSchema>[]>();
    const reservationsAttempted = new Set<string>();
    const sequences = new Set<number>();
    const starts = events.filter((event) => event.kind === 'scenario.started');
    if (starts.length !== 1)
      fail('Evidence incomplete: exactly one scenario.started event is required.');
    for (const event of events) {
      if (sequences.has(event.seq)) fail(`Duplicate event sequence ${event.seq}.`);
      sequences.add(event.seq);
      if (event.planId && !plans.has(event.planId))
        fail(`Event ${event.seq} references an unknown plan.`);
      if (event.actionId && actions.get(event.actionId)?.plan.id !== event.planId)
        fail(`Event ${event.seq} has an unknown or mismatched action.`);
      if (event.kind === 'plan.approved') {
        const plan = event.planId ? plans.get(event.planId) : undefined;
        if (!plan || event.data.hash !== plan.hash || !plan.approvedAt)
          fail(`Approval event ${event.seq} does not match an approved plan fingerprint.`);
        else {
          if (approvals.has(plan.id)) fail(`Plan ${plan.id} has duplicate approval events.`);
          approvals.set(plan.id, event.seq);
          report.metrics.approvals++;
        }
      }
      if (event.kind === 'action.reserving' && event.actionId)
        reservationsAttempted.add(event.actionId);
      if (event.kind === 'action.dispatching') {
        report.metrics.dispatchIntents++;
        const binding = event.actionId ? actions.get(event.actionId) : undefined;
        const approval = event.planId ? approvals.get(event.planId) : undefined;
        if (!binding || approval === undefined || approval >= event.seq)
          fail(`Dispatch intent ${event.seq} lacks a preceding matching approval.`);
        if (binding && Date.parse(event.at) < Date.parse(binding.plan.approvedAt ?? ''))
          fail(`Dispatch intent ${event.seq} predates approval time.`);
        if (event.actionId)
          intents.set(event.actionId, [...(intents.get(event.actionId) ?? []), event]);
      }
    }
    for (const plan of evidence.plans) {
      if (plan.approvedAt && !approvals.has(plan.id))
        fail(`Evidence incomplete: plan ${plan.id} has no approval event.`);
    }

    const world = evidence.world;
    if (!world) {
      fail(
        'Evidence incomplete: independent world records are missing; commitments and stock cannot be verified.',
      );
      return report;
    }
    report.metrics.worldAvailable = true;
    report.metrics.shipments = world.shipments.length;
    report.metrics.committedCost = world.shipments.reduce(
      (sum, shipment) => sum + shipment.cost,
      0,
    );
    const shippedOrders = new Set<string>();
    const shipmentKeys = new Set<string>();
    for (const shipment of world.shipments) {
      if (shippedOrders.has(shipment.orderId))
        fail(`Order ${shipment.orderId} has more than one carrier commitment.`);
      if (shipmentKeys.has(shipment.key)) fail(`Duplicate shipment key ${shipment.key}.`);
      shippedOrders.add(shipment.orderId);
      shipmentKeys.add(shipment.key);
      const binding = actions.get(shipment.key);
      if (!binding) {
        fail(`Shipment ${shipment.key} has no approved action.`);
        continue;
      }
      const allocation = binding.action.allocation;
      if (
        shipment.scenarioId !== evidence.scenario.id ||
        shipment.orderId !== allocation.orderId ||
        shipment.warehouse !== allocation.warehouse ||
        shipment.quantity !== allocation.quantity ||
        shipment.laneId !== allocation.laneId ||
        shipment.cost !== allocation.cost
      )
        fail(`Shipment ${shipment.key} differs from the approved allocation.`);
      if (!approvals.has(binding.plan.id))
        fail(`Shipment ${shipment.key} has no matching approval.`);
      if (
        !(intents.get(shipment.key) ?? []).some(
          (event) => Date.parse(event.at) <= Date.parse(shipment.createdAt),
        )
      )
        fail(`Shipment ${shipment.key} lacks a preceding durable dispatch intent.`);
      if (
        binding.action.shipment &&
        canonicalJson(binding.action.shipment) !== canonicalJson(shipment)
      )
        fail(`Local shipment receipt ${shipment.key} contradicts independent carrier evidence.`);
    }
    report.metrics.distinctDispatchedOrders = shippedOrders.size;

    const initial = z
      .object({ scenario: z.object({ id: text }), stock: z.array(stockSchema) })
      .safeParse(starts[0]?.data);
    if (!initial.success || initial.data.scenario.id !== evidence.scenario.id) {
      fail('Evidence incomplete: valid initial inventory for this scenario is missing.');
      return report;
    }
    const expectedStock = new Map<string, number>();
    for (const item of initial.data.stock) {
      const key = stockKey(item);
      if (expectedStock.has(key)) fail(`Duplicate initial stock record ${key}.`);
      expectedStock.set(key, item.available);
    }
    const subtract = (
      item: { warehouse: string; part: string; quantity: number },
      source: string,
    ) => {
      const key = stockKey(item);
      const previous = expectedStock.get(key);
      if (previous === undefined) fail(`${source} references unknown initial stock ${key}.`);
      else expectedStock.set(key, previous - item.quantity);
    };
    for (const event of events.filter((event) => event.kind === 'simulation.stock_changed')) {
      const changed = z
        .object({
          request: z.object({ warehouse: text, part: text, quantity: integer.positive() }),
        })
        .safeParse(event.data);
      if (!changed.success)
        fail(`Stock change event ${event.seq} has malformed consumption evidence.`);
      else subtract(changed.data.request, `Stock change event ${event.seq}`);
    }
    const reservationKeys = new Set<string>();
    for (const reservation of world.reservations) {
      if (reservationKeys.has(reservation.key))
        fail(`Duplicate reservation key ${reservation.key}.`);
      reservationKeys.add(reservation.key);
      const binding = actions.get(reservation.key);
      if (
        !binding ||
        reservation.scenarioId !== evidence.scenario.id ||
        reservation.warehouse !== binding.action.allocation.warehouse ||
        reservation.part !== binding.action.allocation.part ||
        reservation.quantity !== binding.action.allocation.quantity
      )
        fail(`Reservation ${reservation.key} differs from its action.`);
      if (!reservationsAttempted.has(reservation.key))
        fail(`Reservation ${reservation.key} lacks durable reservation intent.`);
      if (reservation.status !== 'released')
        subtract(reservation, `Reservation ${reservation.key}`);
      if (reservation.status === 'consumed' && !shipmentKeys.has(reservation.key))
        fail(`Consumed reservation ${reservation.key} has no carrier commitment.`);
      if (reservation.status === 'released' && shipmentKeys.has(reservation.key))
        fail(`Released reservation ${reservation.key} also has a carrier commitment.`);
    }
    for (const shipment of world.shipments) {
      if (!reservationKeys.has(shipment.key))
        fail(`Shipment ${shipment.key} has no inventory reservation.`);
    }
    for (const { action } of actions.values()) {
      if (action.shipment && !shipmentKeys.has(action.id))
        fail(`Local shipment receipt ${action.id} is absent from carrier records.`);
      if (
        action.stage === 'completed' &&
        (!shipmentKeys.has(action.id) ||
          !world.reservations.some(
            (reservation) => reservation.key === action.id && reservation.status === 'consumed',
          ))
      )
        fail(`Completed action ${action.id} lacks complete provider evidence.`);
    }
    const actualKeys = new Set<string>();
    for (const actual of world.stock) {
      const key = stockKey(actual);
      if (actualKeys.has(key)) fail(`Duplicate current stock record ${key}.`);
      actualKeys.add(key);
      if (expectedStock.get(key) !== actual.available)
        fail(
          `Inventory conservation failed for ${key}: expected ${expectedStock.get(key) ?? 'no record'}, found ${actual.available}.`,
        );
      report.metrics.stockItemsChecked++;
    }
    for (const key of expectedStock.keys())
      if (!actualKeys.has(key)) fail(`Evidence incomplete: current stock is missing ${key}.`);
    report.valid = report.errors.length === 0;
  } catch (error) {
    report.errors.push(
      `Malformed export could not be inspected: ${error instanceof Error ? error.message : 'invalid value'}`,
    );
  }
  return report;
}

async function main() {
  const path = process.argv[2];
  if (!path || process.argv.length !== 3) {
    console.error('Usage: npm run verify:export -- /path/to/replan-evidence.json');
    process.exitCode = 2;
    return;
  }
  try {
    const report = verifyEvidence(JSON.parse(await readFile(path, 'utf8')) as unknown);
    console.log(
      report.valid
        ? 'CONSISTENT EVIDENCE — unsigned export; this is not a certificate of completed work.'
        : 'EVIDENCE FAILED OR INCOMPLETE',
    );
    console.log('Offline inspection only. No actions are executed or retried.');
    for (const event of report.timeline)
      console.log(`${String(event.seq).padStart(5)}  ${event.at}  ${event.kind}  ${event.message}`);
    console.log(
      JSON.stringify(
        { valid: report.valid, metrics: report.metrics, errors: report.errors },
        null,
        2,
      ),
    );
    process.exitCode = report.valid ? 0 : 1;
  } catch (error) {
    console.error(
      `Cannot read evidence: ${error instanceof Error ? error.message : 'invalid JSON'}`,
    );
    process.exitCode = 2;
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === import.meta.filename) void main();
