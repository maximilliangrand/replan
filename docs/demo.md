# A five-minute walkthrough

Use the local setup in the README and open `http://127.0.0.1:4317` when running
`npm run dev`. The development supervisor restarts the application after the
intentional crash fault. Inventory, carrier and database state stay alive.

This script uses the seeded **The missing bearing** scenario. All factories,
quantities and dollars are synthetic. Start with **Reset demo**; do not reset
while demonstrating recovery. Complete the walkthrough promptly: repair windows
are measured from scenario start, and proposals become too old to approve after
ten minutes.

## 0:00–1:00 — Make a decision whose tradeoff is visible

Say: “Three factory repairs need bearing kits. The cheapest route for each order
in isolation can waste stock another order needs. The first task is to make the
tradeoff visible, then bind the operator's approval to that exact decision.”

1. Show **Keep the repair moving.** and **Known inventory**. The latter is the
   planner's observed snapshot, not a live promise of stock.
2. Click **Optimize a plan**, then **Compare greedy**. The fresh seeded scenario
   gives an optimized total of **$440** and greedy total of **$475**, both covering
   three orders. Select the **Optimized** proposal card again.
3. Show its transfers: Munich → Linz for $320, Vienna → Graz for $90, and
   Brno → Brno for $30. Open **Decision provenance** to inspect the fingerprint,
   stock versions and solver status.
4. Click **Approve $440**. Explain that this approves these allocations and source
   versions; it is not an unlimited budget or permission to substitute a new plan.

## 1:00–2:00 — Lose the reply after the commitment

1. In **Make reality change.**, click **Lose the carrier response**.
2. Click **Dispatch one**. The carrier commits the Linz transfer, but the reply
   is lost. The plan becomes **Needs reconciliation**.
3. The operational summary still shows **0 Confirmed dispatches** and **$0
   Confirmed transport cost**. Expand **What actually happened**: the evaluator
   should show **one carrier dispatch**. Compare that with the action's
   **Outcome unknown** execution state.
4. Open the relevant event in **Decision trail**.

Say: “A failed HTTP exchange is not proof that the business action failed. These
are separate records: the carrier committed a shipment, while the application
doesn't yet have confirmation. Retrying under a new identity would be a bug.”

## 2:00–3:00 — Make recovery wait for evidence

1. Click **Make lookup unavailable**, then **Check & recover**.
2. Show that the plan remains uncertain and the evaluator still shows one
   dispatch. A replacement proposal cannot bypass the unresolved outcome.
3. Under **Consume stock outside Replan**, choose **Vienna · BRG-42**, enter
   **4** units, and click **Consume stock**. The independent stock becomes two;
   **Known inventory** still shows its old observation. Do not refresh yet.
4. Click **Restore normal service**, then **Check & recover**.

Recovery confirms the existing Linz shipment without duplicating it. It then
tries the next approved transfer and discovers Vienna's stock version changed.
The plan becomes **New plan needed**, with Linz retained as confirmed.

Say: “Recovery has two responsibilities: finish recording what already happened,
then challenge the assumptions for work that hasn't happened yet. It doesn't
replay the whole plan or rewrite the approval.”

## 3:00–4:00 — Approve only the changed remainder

1. Click **Refresh** in **Known inventory**.
2. Click **Optimize a plan**. The replacement contains only Graz and Brno:
   Brno → Graz for $255 and Vienna → Brno for $40, a new total of **$295**.
3. Explain the cost difference: $320 was already committed for Linz; this proposal
   covers another $295. The eventual scenario total is **$615**, not $295. The
   system exposes the disruption's cost rather than hiding it in a silent retry.
4. Click **Approve $295**, then **Dispatch remaining**.
5. Check **What actually happened**: three distinct order commitments, with no
   second Linz shipment. The original partial plan and its evidence remain visible.
   The operational summary now shows **3 Confirmed dispatches** and **$615
   Confirmed transport cost**. Proposal controls are disabled because every order
   has a confirmed dispatch.
6. Click **Export evidence** for the current scenario, plans, events and provider
   records.

Say: “The acceptance condition is specific: all three orders have one dispatch,
the changed remainder received new approval, and every commitment can be traced
back to its evidence. Dispatch isn't delivery; that boundary remains explicit.”

## Optional fifth minute — Kill the application

After exporting the first run, click **Reset demo** and generate and approve a
fresh optimized proposal. Select **Crash after dispatch**, then **Dispatch one**.
The application process exits after the carrier commits and before the local
receipt is saved. With `npm run dev`, wait for the supervisor's restart message
and the browser to reconnect. With a manually managed backend, restart it against
the same databases. Do not reset the scenario or clear its database.

Click **Check & recover**. It should find the already committed shipment, retain
its original key, and finish the remaining plan. Inspect the first action's
receipt and the carrier's distinct order records. This checks durable recovery
across a new process, not recovery from an in-memory exception.

## If something differs

Read the displayed outcome before continuing. An unavailable service can leave
the UI showing its last known state; it does not prove an action failed. Keep the
same scenario and use **Check & recover** after connectivity returns. If the
deadline has expired or the evidence conflicts, a hold is an expected outcome,
not permission to force a retry. The exact price checkpoints above assume the
unchanged fresh seed and the four-unit Vienna consumption specified here.
