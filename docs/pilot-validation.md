# Pilot validation gates

This phase establishes an authenticated, isolated application foundation and tests its recovery protocol against independently persisted synthetic providers. It does not certify a real carrier integration or authorize live shipments.

## Engineering acceptance

| Boundary          | Required evidence                                                                                                                          | Automated check                                      |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------- |
| Identity          | Provisioned keys become fixed-duration secure sessions; revocation and rotation invalidate sessions, including concurrent login            | `tests/auth.test.ts`                                 |
| Authorization     | Viewers cannot mutate; only workspace admins import assigned datasets; request headers cannot choose identity/workspace                    | `tests/pilot.test.ts`                                |
| Isolation         | Foreign plans, datasets, events and exports are inaccessible; holding one workspace lock does not block another                            | `tests/pilot.test.ts`                                |
| Approval          | The actual authenticated operator is stored with the exact approved fingerprint                                                            | `tests/pilot.test.ts`, `tests/recovery.test.ts`      |
| Cancellation      | Carrier cancellation fences a late dispatch before inventory release; committed shipments survive; restart resumes the cancellation intent | `tests/simulators.test.ts`, `tests/recovery.test.ts` |
| Provider boundary | Malformed, oversized and contradictory responses cannot count as successful execution                                                      | `tests/providers.test.ts`, `tests/recovery.test.ts`  |
| Schema upgrades   | Released approvals, unknown actions and audit data survive; repeated migration is safe; changed migration history fails closed             | `tests/migrations.test.ts`                           |
| Operator UI       | Session precedes workspace loading; expired sessions remove data; uncertain actions retain a warning; pilot hides fault controls           | `web/App.test.tsx`                                   |
| Dependency health | Dependency outage fails readiness while liveness remains responsive                                                                        | `tests/pilot.test.ts`                                |
| Restore           | A synthetic application database is dumped, restored into a fresh temporary database and checked                                           | `npm run backup:drill`                               |

The default demo remains a separate mode. Production startup refuses demo mode. The deployment recipe uses HTTPS ingress, a source-IP allowlist, provisioned operator keys and an application role without DDL privileges. These are a private pilot's controls, not an internet-scale multi-tenant service or SSO/MFA implementation.

## Before connecting an actual provider

Choose one workflow owner, inventory system and carrier. Record their supported operations and verify the following against a sandbox or explicit test account:

1. Stable action keys are durable across retries and service restarts. Reusing a key with changed arguments must fail.
2. Inventory reservations check authoritative quantity and version atomically. Release/consume semantics and any expiry must be documented.
3. A positive carrier receipt identifies the exact approved order, quantity, lane and cost. Determine whether it means accepted, dispatched or delivered; Replan currently models dispatch only.
4. Terminal cancellation must serialize against creation for that key and forbid future late commits. A missing receipt or HTTP 404 is insufficient. If the provider cannot guarantee this, keep the operation uncertain and design a different reconciliation contract before enabling the cancellation path.
5. Provider dataset ownership and credentials must map to the intended workspace. The application must never import an unrelated tenant's data.
6. Exercise actual timeout, outage and restart behaviour. A simulator test cannot establish a provider's guarantee.

The adapter is trusted to attest these guarantees. The offline export verifier checks proposal/approval/dispatch consistency and conservation; it does not prove the provider's cancellation tombstones are permanent.

## Deployment acceptance and remaining gates

- Local Caddy/Chromium HTTPS acceptance now verifies browser login/logout, role denial and secure-cookie behaviour. The [Railway acceptance record](railway-acceptance.md) repeats login, secure-cookie, role and recovery checks on real hosting with a public CA certificate.
- The restricted runtime database role, operator-key rotation, provider-token rotation and log redaction are now exercised locally. Verify the chosen host secret store and its rotation procedure.
- Railway volume backup schedules and isolated logical restores of all three hosted stores have been verified. Still agree on recovery-point/recovery-time targets and test restoration onto a replacement host. The per-database logical drill is not a consistent distributed snapshot.
- [Capacity acceptance](capacity.md) now measures four concurrent synthetic workspaces at 100 orders and 500 lanes each, including isolation and contention. Repeat with representative customer inputs and target-host/provider latency before setting capacity promises.
- A [read-only monitoring probe](operations.md) now detects readiness failures and stale unresolved/executing/cancellation states. The temporary Railway pilot configured it every five minutes for its operator workspace and verified one successful hosted run. Configure monitoring for any future deployment, connect failures to an agreed alert destination and test delivery. Alert delivery has not been tested; recovery stays operator-triggered.
- Have an operations practitioner challenge priorities, costs, deadlines, cancellation policy and the replacement-approval workflow. Run the [acceptance drill](product-brief.md) and record observations.

The [provider assessment](provider-assessment.md) found no drop-in vendor pair that establishes every current execution and cancellation guarantee. Provider selection and lifecycle mapping must precede a connected adapter.

A temporary private hosted deployment using synthetic providers was validated, then intentionally taken offline on 2026-09-23. The record is historical evidence, not an active environment. No live shipment execution or customer acceptance has been performed. Advancement through these gates requires the selected environment and provider evidence, not a larger synthetic test count.
