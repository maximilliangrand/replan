import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import type { Allocation, Solution, SolverInput, Strategy } from '../shared/contracts.js';
import { audit, Conflict, context, getPlans, transaction } from './db.js';

const solutionSchema = z.object({
  allocations: z.array(
    z.object({
      orderId: z.string(),
      warehouse: z.string(),
      part: z.string(),
      quantity: z.number().int().positive(),
      laneId: z.string(),
      mode: z.string(),
      hours: z.number().nonnegative(),
      cost: z.number().nonnegative(),
      stockVersion: z.number().int().nonnegative(),
    }),
  ),
  unfilled: z.array(z.string()),
  totalCost: z.number().nonnegative(),
  fulfilledPriority: z.number().nonnegative(),
  solverStatus: z.string(),
  solveMs: z.number().nonnegative(),
  explanation: z.string(),
});
export async function solve(input: SolverInput): Promise<Solution> {
  const result = await new Promise<string>((resolve, reject) => {
    const child = spawn(
      'uv',
      ['run', '--frozen', '--project', 'solver', 'python', 'solver/main.py'],
      { stdio: ['pipe', 'pipe', 'pipe'] },
    );
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('Solver exceeded the 15 second execution limit.'));
    }, 15000);
    child.stdout.on('data', (data) => {
      out += data;
      if (out.length > 1_000_000) child.kill('SIGKILL');
    });
    child.stderr.on('data', (data) => {
      if (err.length < 8000) err += data;
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(new Error(`Solver failed (${code}): ${err.slice(0, 500)}`));
    });
    child.stdin.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.stdin.end(JSON.stringify(input));
  });
  const solution = solutionSchema.parse(JSON.parse(result));
  validateSolution(input, solution);
  return solution;
}

// This independent boundary check does not trust either strategy's output.
export function validateSolution(input: SolverInput, solution: Solution) {
  const seen = new Set<string>();
  const stocks = new Map<string, number>();
  const lanes = new Map<string, number>();
  let cost = 0;
  let priority = 0;
  for (const a of solution.allocations) {
    const order = input.orders.find((o) => o.id === a.orderId);
    const lane = input.lanes.find((l) => l.id === a.laneId);
    const stock = input.stock.find((s) => s.warehouse === a.warehouse && s.part === a.part);
    if (
      !order ||
      !lane ||
      !stock ||
      seen.has(a.orderId) ||
      a.quantity !== order.quantity ||
      a.part !== order.part ||
      lane.factory !== order.factory ||
      lane.warehouse !== a.warehouse ||
      a.hours !== lane.hours ||
      a.mode !== lane.mode ||
      a.hours > order.deadlineHours ||
      a.cost !== lane.unitCost * a.quantity ||
      a.stockVersion !== stock.version
    )
      throw new Error('Solver returned an invalid allocation.');
    seen.add(a.orderId);
    cost += a.cost;
    priority += order.priority;
    const key = `${a.warehouse}\0${a.part}`;
    stocks.set(key, (stocks.get(key) ?? 0) + a.quantity);
    lanes.set(lane.id, (lanes.get(lane.id) ?? 0) + a.quantity);
    if (stocks.get(key)! > stock.available || lanes.get(lane.id)! > lane.capacity)
      throw new Error('Solver violated a capacity constraint.');
  }
  const unfilled = input.orders
    .filter((o) => !seen.has(o.id))
    .map((o) => o.id)
    .sort();
  if (
    solution.totalCost !== cost ||
    solution.fulfilledPriority !== priority ||
    JSON.stringify([...solution.unfilled].sort()) !== JSON.stringify(unfilled)
  )
    throw new Error('Solver returned inconsistent totals.');
}
export function planHash(
  scenarioId: string,
  strategy: Strategy,
  snapshot: unknown,
  solution: Solution,
): string {
  return createHash('sha256')
    .update(canonicalJson({ scenarioId, strategy, snapshot, solution }))
    .digest('hex');
}
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object')
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`)
      .join(',')}}`;
  return JSON.stringify(value);
}
export async function propose(db: PoolClient, strategy: Strategy) {
  const ctx = await context(db);
  const plans = await getPlans(ctx.scenario.id, db);
  if (plans.some((p) => ['approved', 'executing', 'uncertain'].includes(p.status)))
    throw new Conflict(
      'Resolve the approved plan before proposing a replacement. Unknown external effects must be reconciled first.',
    );
  const done = new Set(
    plans.flatMap((p) =>
      p.actions.filter((a) => a.stage === 'completed').map((a) => a.allocation.orderId),
    ),
  );
  const elapsedHours = (Date.now() - ctx.createdAt.getTime()) / 3_600_000;
  const orders = ctx.scenario.orders
    .filter((o) => !done.has(o.id))
    .map((o) => ({ ...o, deadlineHours: Math.max(0, o.deadlineHours - elapsedHours) }));
  if (!orders.length) throw new Conflict('Every repair order already has a dispatched transfer.');
  const used = new Map<string, number>();
  for (const a of plans.flatMap((p) => p.actions.filter((a) => a.stage === 'completed')))
    used.set(a.allocation.laneId, (used.get(a.allocation.laneId) ?? 0) + a.allocation.quantity);
  const lanes = ctx.scenario.lanes.map((l) => ({
    ...l,
    capacity: l.capacity - (used.get(l.id) ?? 0),
  }));
  const solution = await solve({ orders, stock: ctx.snapshot.stock, lanes, strategy });
  const id = randomUUID();
  const hash = planHash(ctx.scenario.id, strategy, ctx.snapshot, solution);
  await transaction(db, async () => {
    await db.query(
      "INSERT INTO plans(id,scenario_id,strategy,snapshot,solution,hash,status) VALUES($1,$2,$3,$4,$5,$6,'proposed')",
      [id, ctx.scenario.id, strategy, ctx.snapshot, solution, hash],
    );
    for (const [i, a] of solution.allocations.entries())
      await db.query('INSERT INTO actions(id,plan_id,ordinal,allocation) VALUES($1,$2,$3,$4)', [
        `${id}:${i}`,
        id,
        i,
        a satisfies Allocation,
      ]);
    await audit(
      db,
      ctx.scenario.id,
      'plan.proposed',
      `${strategy === 'optimized' ? 'Optimized' : 'Greedy'} proposal: ${solution.allocations.length} transfers, $${solution.totalCost}.`,
      { hash, solution, observedAt: ctx.snapshot.observedAt },
      id,
    );
  });
}
