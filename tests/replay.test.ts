import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import type { AppState, AuditEvent, Plan, Reservation, Shipment } from '../shared/contracts.js';
import { verifyEvidence } from '../src/replay.js';

// Fixed signed-content bytes are unnecessary here: the format is intentionally
// unsigned. The fixture follows the documented canonical-JSON hash contract.
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object')
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(',')}}`;
  return JSON.stringify(value);
}
function fixture(): AppState & { schemaVersion: 1; exportedAt: string } {
  const at = (seconds: number) => `2026-01-01T00:00:${String(seconds).padStart(2, '0')}.000Z`;
  const scenario = {
    id: 'scenario-1',
    name: 'One repair',
    description: 'Synthetic verifier fixture',
    orders: [
      {
        id: 'repair-1',
        factory: 'Factory',
        part: 'bearing',
        quantity: 3,
        deadlineHours: 8,
        priority: 10,
      },
    ],
    lanes: [
      {
        id: 'lane-1',
        warehouse: 'Depot',
        factory: 'Factory',
        mode: 'Road',
        hours: 2,
        unitCost: 10,
        capacity: 8,
      },
    ],
  };
  const snapshot = {
    observedAt: at(0),
    stock: [{ warehouse: 'Depot', part: 'bearing', available: 8, version: 1 }],
  };
  const allocation = {
    orderId: 'repair-1',
    warehouse: 'Depot',
    part: 'bearing',
    quantity: 3,
    laneId: 'lane-1',
    mode: 'Road',
    hours: 2,
    cost: 30,
    stockVersion: 1,
  };
  const solution = {
    allocations: [allocation],
    unfilled: [],
    totalCost: 30,
    fulfilledPriority: 10,
    solverStatus: 'OPTIMAL',
    solveMs: 1,
    explanation: 'Synthetic fixture',
  };
  const hash = createHash('sha256')
    .update(canonical({ scenarioId: scenario.id, strategy: 'optimized', snapshot, solution }))
    .digest('hex');
  const reservation: Reservation = {
    key: 'plan-1:0',
    scenarioId: scenario.id,
    warehouse: 'Depot',
    part: 'bearing',
    quantity: 3,
    version: 2,
    status: 'consumed',
  };
  const shipment: Shipment = {
    key: 'plan-1:0',
    scenarioId: scenario.id,
    orderId: 'repair-1',
    warehouse: 'Depot',
    quantity: 3,
    laneId: 'lane-1',
    cost: 30,
    status: 'dispatched',
    createdAt: at(5),
  };
  const plan: Plan = {
    id: 'plan-1',
    scenarioId: scenario.id,
    strategy: 'optimized',
    snapshot,
    solution,
    hash,
    status: 'completed',
    reason: null,
    createdAt: at(0),
    approvedAt: at(1),
    actions: [
      {
        id: 'plan-1:0',
        planId: 'plan-1',
        allocation,
        stage: 'completed',
        reservation,
        shipment,
        error: null,
      },
    ],
  };
  const event = (
    seq: number,
    second: number,
    kind: string,
    data: Record<string, unknown> = {},
    actionId: string | null = null,
  ): AuditEvent => ({
    seq,
    at: at(second),
    kind,
    data,
    planId: 'plan-1',
    actionId,
    message: kind,
  });
  return {
    schemaVersion: 1,
    exportedAt: at(10),
    scenario,
    snapshot,
    plans: [plan],
    serviceWarning: null,
    events: [
      { ...event(1, 0, 'scenario.started', { scenario, stock: snapshot.stock }), planId: null },
      event(2, 0, 'plan.proposed', { hash, solution }),
      event(3, 1, 'plan.approved', { hash }),
      event(4, 2, 'action.reserving', {}, reservation.key),
      event(
        5,
        3,
        'action.reserved',
        { reservation: { ...reservation, status: 'held' } },
        reservation.key,
      ),
      event(6, 4, 'action.dispatching', {}, shipment.key),
      event(7, 6, 'action.dispatched', { shipment }, shipment.key),
      event(8, 7, 'action.completed', { shipment, reservation }, shipment.key),
    ],
    world: {
      stock: [{ warehouse: 'Depot', part: 'bearing', available: 5, version: 2 }],
      reservations: [reservation],
      shipments: [shipment],
      carrierLookupAvailable: true,
    },
  };
}

describe('offline exported-evidence verification', () => {
  it('reconstructs sequence order and verifies a completed commitment without mutating input', () => {
    const input = fixture();
    input.events.reverse();
    const before = JSON.stringify(input);
    const report = verifyEvidence(input);
    expect(report.valid, report.errors.join('\n')).toBe(true);
    expect(report.timeline.map((event) => event.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(report.metrics).toMatchObject({
      approvals: 1,
      dispatchIntents: 1,
      shipments: 1,
      distinctDispatchedOrders: 1,
      committedCost: 30,
      stockItemsChecked: 1,
      unresolvedPlans: 0,
    });
    expect(JSON.stringify(input)).toBe(before);
  });

  it('accepts consistent unknown outcomes without pretending the workflow completed', () => {
    const input = fixture();
    input.plans[0].status = 'uncertain';
    input.plans[0].actions[0].stage = 'dispatch_unknown';
    input.plans[0].actions[0].shipment = null;
    input.world!.reservations[0].status = 'held';
    input.world!.carrierLookupAvailable = false;
    input.events = input.events.filter((event) => event.seq < 7);
    const report = verifyEvidence(input);
    expect(report.valid, report.errors.join('\n')).toBe(true);
    expect(report.metrics.unresolvedPlans).toBe(1);
    expect(report.metrics.shipments).toBe(1);
  });

  it('accounts for independent stock consumption and excludes released reservations', () => {
    const input = fixture();
    input.world!.stock[0].available--;
    input.events.push({
      seq: 9,
      at: input.exportedAt,
      kind: 'simulation.stock_changed',
      planId: null,
      actionId: null,
      message: 'External consumption',
      data: { request: { warehouse: 'Depot', part: 'bearing', quantity: 1 } },
    });
    expect(verifyEvidence(input).valid).toBe(true);
    input.world!.reservations[0].status = 'released';
    input.world!.shipments = [];
    input.world!.stock[0].available = 7;
    input.plans[0].actions[0].stage = 'blocked';
    input.plans[0].actions[0].shipment = null;
    input.plans[0].status = 'needs_replan';
    input.events = input.events.filter((event) => event.seq < 6 || event.seq === 9);
    const released = verifyEvidence(input);
    expect(released.valid).toBe(true);
    expect(released.metrics).toMatchObject({ unresolvedPlans: 0, blockedPlans: 1 });
  });

  it.each([
    [
      'changed hash',
      (input: ReturnType<typeof fixture>) => {
        input.plans[0].hash = '0'.repeat(64);
      },
      /fingerprint/,
    ],
    [
      'changed allocation',
      (input: ReturnType<typeof fixture>) => {
        input.plans[0].actions[0].allocation = {
          ...input.plans[0].actions[0].allocation,
          cost: 31,
        };
      },
      /actions differ/,
    ],
    [
      'missing approval',
      (input: ReturnType<typeof fixture>) => {
        input.events = input.events.filter((event) => event.kind !== 'plan.approved');
      },
      /preceding matching approval/,
    ],
    [
      'approval after intent',
      (input: ReturnType<typeof fixture>) => {
        input.events.find((event) => event.kind === 'plan.approved')!.seq = 20;
      },
      /preceding matching approval/,
    ],
    [
      'shipment before intent',
      (input: ReturnType<typeof fixture>) => {
        input.world!.shipments[0].createdAt = '2026-01-01T00:00:01.000Z';
      },
      /preceding durable dispatch intent/,
    ],
    [
      'wrong shipment',
      (input: ReturnType<typeof fixture>) => {
        input.world!.shipments[0].cost = 31;
      },
      /differs from the approved allocation/,
    ],
    [
      'duplicate commitment',
      (input: ReturnType<typeof fixture>) => {
        input.world!.shipments.push({ ...input.world!.shipments[0], key: 'another-key' });
      },
      /more than one carrier commitment/,
    ],
    [
      'missing world',
      (input: ReturnType<typeof fixture>) => {
        input.world = null;
      },
      /Evidence incomplete: independent world/,
    ],
    [
      'stock mismatch',
      (input: ReturnType<typeof fixture>) => {
        input.world!.stock[0].available = 6;
      },
      /Inventory conservation/,
    ],
    [
      'missing initial stock',
      (input: ReturnType<typeof fixture>) => {
        input.events = input.events.filter((event) => event.kind !== 'scenario.started');
      },
      /scenario.started/,
    ],
    [
      'duplicate stock rows',
      (input: ReturnType<typeof fixture>) => {
        input.world!.stock.push({ ...input.world!.stock[0] });
      },
      /Duplicate current stock/,
    ],
    [
      'released committed stock',
      (input: ReturnType<typeof fixture>) => {
        input.world!.reservations[0].status = 'released';
      },
      /Released reservation/,
    ],
    [
      'absent provider receipt',
      (input: ReturnType<typeof fixture>) => {
        input.world!.shipments = [];
      },
      /no carrier commitment|absent from carrier/,
    ],
    [
      'negative stock',
      (input: ReturnType<typeof fixture>) => {
        input.world!.stock[0].available = -1;
      },
      /Malformed export/,
    ],
    [
      'negative reservation',
      (input: ReturnType<typeof fixture>) => {
        input.world!.reservations[0].quantity = -1;
      },
      /Malformed export/,
    ],
  ])('rejects %s', (_name, change, expected) => {
    const input = fixture();
    (change as (input: ReturnType<typeof fixture>) => void)(input);
    const report = verifyEvidence(input);
    expect(report.valid).toBe(false);
    expect(report.errors.join('\n')).toMatch(expected as RegExp);
  });

  it.each([null, {}, [], { schemaVersion: 2 }, 'not an export'])(
    'handles malformed values without throwing',
    (input) => {
      const report = verifyEvidence(input);
      expect(report.valid).toBe(false);
      expect(report.errors.length).toBeGreaterThan(0);
    },
  );

  it('runs the read-only CLI and returns a nonzero exit for incomplete evidence', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'replan-evidence-'));
    try {
      const path = join(directory, 'export.json');
      const data = fixture();
      const original = JSON.stringify(data);
      await writeFile(path, original);
      const success = spawnSync(process.execPath, ['--import', 'tsx', 'src/replay.ts', path], {
        encoding: 'utf8',
      });
      expect(success.status, success.stderr).toBe(0);
      expect(success.stdout).toContain('CONSISTENT EVIDENCE');
      expect(success.stdout).toContain('action.dispatching');
      expect(await readFile(path, 'utf8')).toBe(original);
      data.world = null;
      await writeFile(path, JSON.stringify(data));
      const failure = spawnSync(process.execPath, ['--import', 'tsx', 'src/replay.ts', path], {
        encoding: 'utf8',
      });
      expect(failure.status).toBe(1);
      expect(failure.stdout).toContain('EVIDENCE FAILED OR INCOMPLETE');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
