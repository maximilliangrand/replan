# Replan: protect the decision after approval

A factory repair planner needs the right spare part before a repair window
closes. When a supplier is late, the planner can transfer existing stock from
another warehouse. The task sounds like finding a route. In practice, stock is
shared, alternatives have different costs, observations go stale, and external
systems can commit an action without returning a usable response.

The operator's real question is: **What can I still safely commit to, given what
has already happened?** Replan makes that question inspectable in one workflow.

## Product choices from the underlying constraints

**Protect outcomes, not activity counts.** A dispatched transfer only helps if it
contains the entire required quantity and can meet the repair deadline. The model
therefore allocates complete orders and leaves unfillable work visible. Its
priority policy is explicit and testable; it is not disguised as an AI judgment.

**An approval needs a boundary.** An operator who approves a $440 plan has not
approved an arbitrary future substitute. Replan stores the exact proposal,
evidence versions and approval fingerprint. Changed remaining work is a new
decision requiring approval.

**Separate knowledge from reality.** A cached observation and the authoritative
inventory record answer different questions. The UI shows both for the demo,
without letting the planner secretly use evaluator-only truth. A stock mutation
must be observed or detected by a reservation conflict.

**Make uncertainty actionable.** A carrier timeout cannot be collapsed into
“failed.” The operator sees what is unresolved, can inspect receipts and can ask
the system to reconcile. The system preserves held stock when a previous dispatch
may still commit. It does not invent certainty to keep the screen green.

**Retain successful work.** A disruption to the second transfer should not erase
the first. Replanning excludes confirmed orders, accounts for consumed capacity
and exposes the cost of the remaining work separately from committed cost.

## The implemented slice

The demonstration is one operations workbench with three repairs, observed inventory,
two planning strategies, exact approval, durable execution, fault controls and an
exportable decision trail. It demonstrates one difficult slice end to end rather
than a general logistics platform. Its external services are independently
stateful simulators.

Authenticated pilot mode adds operator identities, viewer/operator/admin roles,
workspace-scoped operations, provider-confirmed cancellation and a read-only
monitoring probe. Fault controls stay in the local demo. A temporary hosted
deployment passed [acceptance checks](railway-acceptance.md), then was
intentionally taken offline on 2026-09-23. There is no live carrier integration,
customer deployment, delivery tracking or measured reduction in factory downtime.

The immediate user is a single repair planner; the second user is a reviewer who
must verify why a commitment occurred. The interface gives each a concrete job:
choose and approve a feasible proposal, then inspect the evidence for execution
and recovery. The benchmark and process-restart tests support the engineering
argument; they do not establish product-market fit.

## An independent acceptance drill

Give a reviewer a running fresh demo and this task, without narrating the clicks:

> Protect the three repair orders. Compare the proposed allocations, approve one,
> and attempt its first transfer with the carrier response-loss fault enabled.
> Make lookup unavailable, then consume four units of Vienna inventory. Restore
> service, resolve the first transfer and approve a feasible plan for the remaining
> orders. Export evidence proving what happened. Do not reset the scenario to
> escape uncertainty.

Have the reviewer record their interpretation before opening the evaluator view.
Then compare that interpretation with the provider receipts and event trail.

| Acceptance question                                                  | Observable evidence                                                                               |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Did the reviewer distinguish a lost response from a failed dispatch? | They identify the first outcome as unknown until reconciliation, then cite its carrier receipt    |
| Did unavailable lookup prevent a new commitment based on a guess?    | The plan stays uncertain, replacement approval is blocked, and shipment count does not increase   |
| Did the stock change invalidate unexecuted work?                     | The old observation remains visible until refresh; reservation conflict stops the stale remainder |
| Did completed work survive recovery?                                 | The first order keeps its original action and carrier key; the replacement excludes it            |
| Did changed cost require a decision?                                 | A separate replacement proposal and matching approval are present                                 |
| Can the reviewer explain the actual outcome?                         | They identify one dispatch per order and distinguish dispatch confirmation from delivery          |

Record completion time, places where the reviewer needed help, incorrect
assumptions, and whether they could reconstruct the final committed cost from the
evidence. A reviewer finishing only with builder coaching is a usability finding,
not a successful independent trial. This protocol is provided for future review;
no independent operator study is claimed here.

## What would justify the next investment

Before adding more automation, validate the workflow with real repair planners:
which deadlines and priorities matter, what approval authority means, how often
stock changes between review and reservation, and what evidence lets someone
resolve an ambiguous carrier outcome. Collect representative anonymized workloads
and evaluate both strategies using the same constraints.

Authenticated approvals, application-enforced workspace and role boundaries,
cancellation, and monitoring already have [engineering evidence](pilot-validation.md).
A real operational pilot still needs verified provider idempotency and
reconciliation guarantees, agreement on reservation expiry and cancellation,
tested alert delivery, and a staffed resolution path for effects that cannot be
confirmed automatically. The [provider assessment](provider-assessment.md)
explains why the simulator contracts are not interchangeable with vendor APIs.

With those conditions established, measure repair completion, expedite cost,
time spent investigating uncertainty and avoidable duplicate commitments. Those
outcomes, rather than the number of generated plans, should determine whether
the product deserves broader scope.
