# Detecting stuck operations

`GET /api/operations/health` gives an authenticated workspace member a
small operational summary. It does not expose order details, provider receipts,
operator identities, cancellation reasons, plan IDs or other workspaces. Viewers,
operators and admins can read it. A workspace with no imported operation returns
zero counts. Reading this endpoint does not retry, release or cancel anything.

```json
{
  "observedAt": "2026-09-23T12:00:00.000Z",
  "unresolved": { "count": 1, "oldestAgeSeconds": 1020 },
  "cancellationPending": { "count": 1, "oldestAgeSeconds": 120 },
  "executing": { "count": 0, "oldestAgeSeconds": null }
}
```

- `unresolved` counts plans currently `uncertain`.
- `cancellationPending` counts approved/executing/uncertain plans that have a
  durable cancellation request. It can overlap `unresolved`; do not add the
  categories to obtain a number of distinct plans.
- `executing` counts plans currently executing, including a paused one-step
  execution. An old execution merits investigation but is not proof of a failure.

All counts include the workspace's active plans, including any older operation
that remains unresolved. Completed, superseded and `needs_replan` plans are
excluded. Approved work that has not started is not considered stuck.

Ages come from the database clock and the earliest corresponding plan event:
`plan.uncertain`, `plan.cancellation_requested` or `plan.executing`. Approval time,
then creation time, is the conservative fallback when history is absent. Ages
are floored to whole seconds and clamped at zero. The first event is retained
across retries, so repeatedly pressing recovery cannot reset an alert. If a plan
temporarily progresses and later becomes uncertain again, its reported age can
overstate the latest uncertain interval; it deliberately measures the earliest
such condition in that still-active plan. Counts and ages are read from one
database statement snapshot.

## Run the read-only probe

Use the deployment's canonical HTTPS origin and provision a dedicated `viewer`
identity in each workspace you monitor. A viewer key can read the summary without
granting the monitoring process permission to change operations. Store it as a
scheduler/secret-manager secret, not a command-line argument or a committed file.
Operator and admin keys also work but are unnecessary for this read-only probe.
The probe uses only GET requests and never requests an execution, recovery,
cancellation or notification.

Supply these environment variables through your existing secret/configuration
delivery mechanism:

| Variable                     | Meaning                                                                                                  |
| ---------------------------- | -------------------------------------------------------------------------------------------------------- |
| `REPLAN_MONITOR_ORIGIN`      | Exact HTTPS origin, without a path, query, credentials or trailing slash. `APP_ORIGIN` is also accepted. |
| `REPLAN_MONITOR_KEY`         | Provisioned access key for the workspace being monitored; use a dedicated viewer identity.               |
| `REPLAN_STALE_AFTER_SECONDS` | Alert threshold, default `900`; integer from `1` to `604800`.                                            |
| `REPLAN_MONITOR_TIMEOUT_MS`  | Per-request timeout, default `5000`; integer from `100` to `60000`.                                      |

```sh
npm run check:operations
```

The command independently checks `/api/ready` and
`/api/operations/health`. It validates the response shape, caps each JSON response
at 16 KiB, uses normal TLS certificate validation and refuses redirects. Trust a
private CA using your normal CA configuration, such as `NODE_EXTRA_CA_CERTS`;
never disable certificate validation. The probe requires no database credential
and does not load the application's database configuration.

One JSON report is printed. `ok` is true only when readiness succeeds, the
operational report is valid, and no reported age is greater than or equal to the
configured threshold. `stale` names the categories that exceeded that threshold;
`failures` contains fixed codes such as `authentication_failed`,
`readiness_unavailable`, `operations_unavailable` or `invalid_response`. Received
error pages, keys, URLs and free-text provider errors are not printed.

Exit code `0` means the checks passed, `1` means a check failed or an operation is
stale, and `2` means local configuration or command execution could not produce a
report. A recent uncertain operation remains visible in the JSON even before its
age reaches the failure threshold. This probe does not inspect repair deadlines
or certify that an operation is safe to dispatch.

The default fifteen-minute threshold is a starting configuration, not an
operational SLA. Choose a threshold and run frequency against your actual repair
windows and response capacity. Run one configured probe per workspace from an
approved network location. In an existing monitoring system, treat a nonzero
exit or missing scheduled run as actionable and route it to your designated
operator. Set up alert deduplication/escalation there. This repository supplies
the probe; it has not configured an external scheduler, recipient or hosted
monitoring service.

## Respond without losing the recovery evidence

1. Check the canonical application's readiness and recent deployment/database
   status. Authentication failures may indicate a revoked monitoring key; do not
   replace it with an unrelated workspace's key.
2. Open the affected workspace and inspect the durable action stage and audit
   evidence. Check the provider's independent ledger using the original action
   key. An absent lookup at one instant does not prove an outstanding request
   cannot still commit.
3. Use the existing recovery or cancellation action only after reviewing that
   evidence. An unresolved cancellation is still an unresolved external effect.
   Retain committed shipments and keep uncertain stock held until the provider
   supplies an authoritative result or terminal cancellation fence.
4. Run the probe again and verify the independent provider outcome. Never make an
   alert disappear by deleting a plan, changing its timestamps, generating a new
   commitment key or resetting provider data.

Readiness checks database connectivity and authenticated provider health
endpoints. The bundled adapters require their configured service token for health
requests in pilot mode, so mismatched tokens fail readiness. This does not prove
that a real provider authorizes every action, that its data is fresh, or that its
idempotency/cancellation contract holds. An external adapter must preserve that
authenticated health contract and pass its separate acceptance checks.

## Rotate credentials deliberately

For an operator or monitoring identity, use the provisioning CLI's `rotate`
command with the identity's existing UUID. It invalidates the old access key and
all sessions. Deliver the new key through the secret store, update the probe's
secret, and verify that the old key is rejected and the new probe succeeds. Use
`revoke` when removing access. Revocation does not cancel already-running work.

Provider authentication currently accepts one shared service token, without an
old/new overlap window. Coordinate its change across both providers and Replan
during a maintenance window after draining new execution. Restart the relevant
services with their new secrets. Verify authenticated health and a representative
authenticated provider read before reopening execution, and prove the old token
is rejected. Reconcile any operation interrupted by the rollout using its
original key.

See [the deployment and restore runbook](pilot-deployment.md) for migrations,
network boundaries and backup recovery. Real provider acceptance tests and a
hosted monitoring rehearsal are separate evidence from local simulation tests.
