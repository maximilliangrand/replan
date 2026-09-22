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

## Deployment acceptance still required

- Start the chosen host behind its real HTTPS ingress and verify browser login/logout, role denial and cookie behaviour from the allowed network.
- Test the chosen secret storage and application database role, rotate an operator key and the provider token, and confirm logs contain no credentials.
- Set an acceptable recovery point and recovery time, configure managed backups for all independently owned stores, and restore them in the target environment. The included synthetic drill is not a consistent distributed snapshot.
- Measure representative input sizes and concurrent operators. Current input bounds are 100 orders and 500 lanes; independent workspace locks are concurrency isolation, not a throughput result.
- Configure alerting for readiness failures and operations that remain uncertain. Recovery is operator-triggered; no unattended retry worker is implied.
- Have an operations practitioner challenge priorities, costs, deadlines, cancellation policy and the replacement-approval workflow. Run the [acceptance drill](product-brief.md) and record observations.

No live operational deployment or customer acceptance has been performed. Advancement through these gates requires the selected environment and provider evidence, not a larger synthetic test count.
