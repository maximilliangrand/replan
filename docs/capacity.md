# Bounded capacity acceptance

This run checks a specific local workload, including workspace isolation under
concurrent requests. It does not establish production capacity or a latency SLA.
The [machine-readable result](evidence/capacity.json) includes every measured
request, status code, solver result, environment and relevant source hashes.

## Reproduce safely

Start the project's owned test PostgreSQL cluster, install the locked Node and
solver dependencies, then run from the repository root:

```sh
node --import tsx scripts/capacity.mts
```

Connection precedence is `CAPACITY_ADMIN_DATABASE_URL`, then `TEST_DATABASE_URL`
(including CI), then the existing local `replan_test` database on port 55432.
The selected database name must end in `_test`, and its account must be able to
create temporary databases and a role. Keep credentials in the environment.

The harness creates three unpredictable database names, applies the application
migrations and provisions four synthetic workspaces. It runs the application
under a temporary restricted runtime role with the deployment grants, using
separately persisted inventory and carrier simulators. It never truncates,
restores into or drops an existing database. Cleanup drops only database and role
names that this invocation successfully created. Each owned resource gets an
independent cleanup attempt; failure does not skip the remaining resources. The
report records every cleanup result and fails acceptance if any cleanup fails.
The checked-in run confirms successful cleanup. Keys remain in memory; the report contains workspace ordinals
instead of random identities or credentials.

The script overwrites `docs/evidence/capacity.json`. A failing acceptance check or
cleanup failure produces a nonzero exit and remains visible in that report.

## Workload and acceptance rule

Four workspaces each contain **100 orders, 500 lanes and 50 stock records**.
Factories, warehouse connections, quantities, priorities and integer-dollar costs
are generated deterministically from four fixed fixture indices. Each order has
50 individually feasible transfers, giving **5,000 solver candidates per
workspace**, below the solver's 20,000-candidate construction limit. This exercises
the current operation import's order and lane count limits, not the maximum
possible solver candidate graph.

The fixture has generous total stock and multiple routes. It is an authored
capacity workload, not a customer-derived demand distribution or an adversarial
optimization problem. The small allocation benchmark covers different constraint
and infeasibility cases; see [evaluation](evaluation.md).

The measured sequence is:

1. Import the four operations concurrently through the authenticated pilot HTTP
   API, then request four optimized proposals concurrently.
2. Run one request per workspace at a time, alternating state and audit reads:
   ten of each per workspace, 80 requests total, concurrency four.
3. Send 12 simultaneous observation mutations to one workspace. Successful work
   and explicit HTTP 409 contention responses are acceptable; hidden failures,
   server errors and timeouts are not.
4. Attempt four approvals using another workspace's plan. Every attempt must
   return HTTP 409 without exposing a scenario or plan payload.
5. Export each workspace's evidence and independently verify its consistency.

Every successful state/export response must contain the requesting workspace's
scenario, scoped plans and scoped actor evidence. Every final export must pass
the offline verifier. No timeout, malformed response, cross-workspace data leak
or unexpected status is acceptable. The predeclared **15,000 ms client timeout**
is the bounded completion gate. Measured percentiles are reported without
inventing a faster passing threshold after seeing the results.

## Recorded result

The recorded run used Node **v26.7.0**, PostgreSQL **16.14**, macOS/Darwin on an
**Apple M4**, 10 logical CPUs and 16 GiB RAM. It made 108 measured HTTP requests.
All four planning requests returned `OPTIMAL`, with 100 orders allocated in each.
All acceptance checks passed.

| Phase                             | Requests |   p50 ms |   p95 ms | Maximum ms | HTTP outcomes     |
| --------------------------------- | -------: | -------: | -------: | ---------: | ----------------- |
| Operation import                  |        4 |    32.71 |    34.64 |      34.64 | 4 × 200           |
| Concurrent planning               |        4 | 1,612.61 | 1,627.99 |   1,627.99 | 4 × 200           |
| State reads                       |       40 |     7.28 |    13.11 |      14.87 | 40 × 200          |
| Audit exports                     |       40 |    10.55 |    15.51 |      21.09 | 40 × 200          |
| Same-workspace contention         |       12 |     3.52 |     8.69 |       8.69 | 1 × 200; 11 × 409 |
| Cross-workspace approval attempts |        4 |     3.91 |     3.97 |       3.97 | 4 × 409           |
| Final verified exports            |        4 |     8.67 |    11.10 |      11.10 | 4 × 200           |

Failures: **zero unexpected statuses, timeouts, invalid responses or detected
workspace leaks**. Eleven contention responses are recorded explicitly; they are
not counted as successful mutations. Rejected operations are not silently retried.
Quantiles use the nearest-rank method; for phases with four samples, p95 is simply
the maximum. These sample counts do not establish a stable tail-latency estimate.

## What remains unmeasured

All HTTP traffic stays on loopback. The client supplies the configured pilot Host
and Origin headers, but there is no TLS ingress, WAN, browser rendering or real
provider latency in this run. Inventory and carrier simulators run in the harness
process with separate databases; the pilot application runs in another process.
All share one host and PostgreSQL cluster. This is not independent infrastructure.

Dependencies are installed and the OR-Tools import is warmed before measurement.
Planning timings include each request's Python subprocess startup, solver work,
database writes and HTTP response; they exclude initial installation and setup.
Read/export timings include JSON parsing and the harness's evidence checks.

The run does not dispatch the 400 planned orders. It measures proposal generation,
scoped reads, export consistency and contention behavior, not sustained shipment
execution or recovery throughput. There is no long-duration soak, increasing-load
saturation search, multi-replica test or historical-data growth test. Zero observed
workspace leaks supports this fixture's acceptance checks; it is not a general
security proof.

A deployment gate still needs the actual host, TLS ingress, provider contracts,
representative customer workloads and an agreed latency/error budget. These local
numbers should not be extrapolated into that missing validation.
