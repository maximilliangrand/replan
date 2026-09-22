# What the evidence establishes

Replan has two separate evaluation surfaces: snapshot allocation planning and the
application's external-effect recovery tests. This document describes the solver
evidence. It does not measure real factory downtime, production throughput, or
recovery latency.

## Reproduce

From the repository root, with Python 3.12 or 3.13 and `uv` installed:

```sh
uv sync --project solver --frozen
uv run --project solver python -m unittest discover -s solver/tests -v
uv run --project solver python solver/benchmark.py
```

The benchmark writes [the complete inputs and outputs](../solver/evidence/planning.json),
including interpreter and solver versions, source hashes, elapsed times, statuses,
and every independently detected feasibility violation. `--output PATH` selects a
different report path. Any feasibility violation makes the command fail.
Timings vary by machine; the report records the environment used for the checked-in
run. Native library loading can take longer on the first invocation on macOS.

## Planning contract

Orders are indivisible: one order must receive its entire quantity from one
warehouse on one lane, or remain explicitly unfilled. Stock is shared by all
orders with the same warehouse and part. Lane capacity is shared by all orders on
that lane, including different parts. A lane must connect the selected warehouse
to the order's factory, and its duration must not exceed the observed remaining
deadline. Costs are integer dollars in this deliberately small model; quantities,
capacities, priorities, and stock versions are integers. There is no transit-time
uncertainty, split shipment, replenishment forecast, or dynamic routing model.

The objective is lexicographic:

1. Maximize the sum of priorities of fully fulfilled orders.
2. Among those solutions, minimize transport cost.

This is an explicit product policy, not a physical truth. Two orders with priority
7 beat one order with priority 11. One extra priority point can justify expensive
transport. A real deployment would need the operator to define acceptable cost
limits and the business meaning of priority before trusting that policy.

The CP-SAT model solves these two objectives sequentially. It fixes the priority
objective only after proving its maximum. The two solves share a five-second
budget, including model construction; input validation and candidate enumeration
happen before that budget. Input size and candidate count are capped to limit
construction work. The caller should also impose a process timeout.

`OPTIMAL` means both objectives are proven for the supplied snapshot and model.
`FEASIBLE` means a valid incumbent exists but one objective is not proven; the
explanation states which. `FALLBACK_GREEDY` means CP-SAT returned no incumbent and
the system used its feasible baseline. No timeout is labeled optimal. An empty
allocation is valid when nothing can be fulfilled; this does not mean the original
orders were successfully satisfied.

The solver uses sorted input, one search worker, and a fixed seed. Tied plans are
stable under the tested input permutations with the pinned solver version. There
is no promise of identical tie choices across solver upgrades or machines under
time limits. Once approved, the application executes the stored plan, not a fresh
solve that happens to have the same objectives.

## Fair baseline and independent checks

The baseline visits orders in descending priority, then earliest deadline, then
ID, and selects the cheapest still-feasible route. Cost ties prefer shorter transit
time and stable IDs. Both strategies receive identical observed stock and enforce
identical stock, lane, deadline, and full-order constraints. The optimized solver
gets no privileged world-state data. Recovery safeguards are not turned off for
the baseline to manufacture a safety advantage.

The [independent checker](../solver/checks.py) does not import the optimizer or its
candidate enumeration. It recomputes order coverage, endpoints, part identity,
stock usage, lane usage, deadline feasibility, evidence versions, priority and cost
from the submitted allocations and original inputs. Tests corrupt successful
results to check that the checker catches substantive violations.

A separate brute-force test enumerates every lane choice for 64 seeded small
instances and compares the exact objective pair with CP-SAT. Other tests cover
shared stock, shared lane capacity across parts, missing stock, deadline equality,
no feasible route, indivisible orders, duplicate inputs, CLI behavior, empty demand,
and deliberately exhausting the solve budget.

## Dataset and results

All data is synthetic. There are three development cases: a flexible-source
allocation, abundant stock, and an unfulfillable workload. There are 24 additional
cases across three different families: shared lane capacity across parts,
indivisible demand packing, and sparse randomized networks.

Those additional families are labeled `holdout` to distinguish them from the
three development examples. They are authored in this repository, not collected
or blinded by an independent evaluator. They are useful regression coverage, not
proof of generalization to customer workloads. The definitions are versioned in
[scenarios.py](../solver/scenarios.py); report source hashes make changes visible.
No parameter is tuned separately for a case or family.

The checked-in run contains 27 cases and 54 strategy runs:

| Measure                                 | Greedy | Optimized |
| --------------------------------------- | -----: | --------: |
| Fully fulfilled orders                  |     53 |        70 |
| Unfilled orders                         |     57 |        40 |
| Fulfilled priority                      |    512 |       620 |
| Total transport cost, synthetic dollars |  1,582 |     1,881 |
| Checked feasibility violations          |      0 |         0 |

The optimized objective wins in 18 cases, ties in nine, and loses in zero. Within
the 24 additional cases it wins in 17 and ties in seven. All 27 optimized plans
were proven optimal. The optimized total cost is **higher**, because it fulfills
more demand; these results do not establish cost savings. Per-family reports and
raw cases retain ties, unfulfilled orders, and the all-unfulfillable case.

These are small instances (at most eight orders per case), deliberately chosen to
make the evidence inspectable. The sub-millisecond/millisecond planning timings
exclude interpreter startup and dependency imports and are not a scale claim.
Larger representative customer workloads, independently selected evaluation data,
and operator trials remain future work.

## Where this stops

Snapshot feasibility cannot prove a plan remains feasible after observations age.
That is the application and adapter layer's responsibility: reserve atomically,
check the approved plan's evidence, track effects durably, and reconcile unknown
outcomes before retry. The solver benchmark makes no duplicate-shipment or
recovery-time claim. Application integration tests exercise those separate
contracts against independently stored simulator state.

The mathematical solver and status semantics follow the official
[OR-Tools CP-SAT documentation](https://developers.google.com/optimization/cp/cp_solver)
and its [time-limit guidance](https://developers.google.com/optimization/cp/cp_tasks).
