# Hosted pilot acceptance — 2026-09-23

Replan is deployed at **https://replan-production.up.railway.app** as a private
pilot. Access requires the configured operator network and a provisioned account.
The interface labels both providers as simulated. No real shipment or customer
acceptance is established by this deployment.

The deployed application, providers and monitor use source revision
[`7162daf`](https://github.com/maximilliangrand/replan/commit/7162daf857cbf6156219aba5733f492dea475763).
Later documentation commits record the observed results without changing that
runtime. The [source revision's CI run](https://github.com/maximilliangrand/replan/actions/runs/35871864911)
passed the contracts/recovery and container smoke jobs. Local verification passed
185 TypeScript/UI tests, three HTTPS browser scenarios, typecheck, build and
format checks; CI also runs the Python solver, capacity and backup drills.

## Deployment boundary

- Railway Amsterdam, one application replica, two private synthetic providers,
  PostgreSQL 16.14 with a persistent volume, and a scheduled read-only monitor.
- Only the application has a public domain. Live metadata confirmed no public
  domain or TCP proxy on the database or providers.
- The application connects as `replan_runtime`, with no schema creation,
  temporary-table, role-creation, database-creation or superuser privileges.
  Its environment contains no schema-owner or bootstrap passwords. Startup
  verifies the schema with `MIGRATE_ON_START=false`.
- Provider databases have separate owners and credentials. The fresh-cluster
  bootstrap creates explicit connection grants and refuses existing target names.
- Native edge rules admit the operator network, then deny other sources. A
  separate exception permits only the two exact health paths with the monitor's
  viewer credential. CDN caching is absent.
- Resource ceilings are 1 GB / 2 vCPU for the app, 0.5 GB / 1 vCPU for the database,
  0.25 GB / 1 vCPU for each provider, and 0.25 GB / 0.25 vCPU for the monitor.
  These are configured ceilings, not measured utilization or availability promises.

## Actual HTTPS and recovery checks

Chromium connected to the public HTTPS origin using normal certificate
verification, with no certificate exception or TLS bypass. An isolated acceptance
workspace was used; the operator's workspace was left with zero plans,
reservations and shipments.

1. Browser login established a `Secure`, `HttpOnly`, `SameSite=Strict`, host-only
   session cookie. Credentials were absent from browser storage. Logout
   invalidated the session. The simulation disclosure was visible and demo
   controls were absent.
2. Unauthenticated state access returned 401; viewer mutation returned 403;
   pilot demo reset returned 404. A forged workspace header did not change
   scope. Approval of a foreign-workspace plan was rejected with 409.
3. The browser optimized and approved the $440 proposal. A private simulator
   fault discarded the next carrier response. Dispatch left the application
   uncertain while the provider independently held one shipment.
4. Railway restarted the application. Startup log entries at 14:23:54 and
   14:32:59 UTC establish the restart; the approved fingerprint and uncertain
   action survived. With lookup unavailable, a recovery attempt kept the
   outcome unknown and the reservation held. It did not add a shipment.
5. Lookup was restored. The browser recovered the existing shipment before
   continuing the remaining transfers. Final evidence has **three unique
   dispatches, $440 committed cost, zero unresolved plans and 27 audit events**.
   The browser download passed the offline verifier. No browser page errors
   occurred.
6. Both acceptance identities were revoked; their keys subsequently returned 401. The acceptance audit remains stored. No test credential is published.

The [actual synthetic audit export](evidence/hosted-browser-recovery.json) includes
both failed lookup and successful reconciliation. Verify it without a running
service:

```sh
npm run verify:export -- docs/evidence/hosted-browser-recovery.json
```

This proves a planned hosted restart after an unknown response. It does not add a
claim of arbitrary crash tolerance beyond the separate process-kill tests in the
repository. Audit exports are unsigned snapshots, not independent attestations.

## Network and monitoring checks

An HTTP probe from a Railway container outside the operator network checked
11 outcomes: bare requests, wrong credentials and forged forwarding headers
received 403; the monitor credential reached exactly `/api/ready` and
`/api/operations/health`; `/api/state` and nested paths stayed blocked. Unsupported
POSTs on the allowed health paths returned 404/403. Railway's edge schema has no
method matcher, so the application enforces the methods after the exact path and
credential checks.

The read-only probe ran outside the operator network and exited 0 with readiness
true and no stale, executing or cancellation-pending work. The deployed monitor
is configured to run every five minutes with a dedicated viewer account, a
10-second request timeout, and no database or provider credential. It observes
the operator workspace, not every workspace. It does not initiate recovery.
Its own hosted run at 14:35:18 UTC reported healthy and exited successfully;
Railway reported the next run at 14:40 UTC. Alert delivery is not configured or
tested.

## Backup and restore checks

A native Railway volume snapshot was created and its backup entry verified at
14:27:20 UTC. Daily and weekly backup schedules were configured and read back,
with reported retention of six and 27 days respectively. Future scheduled
execution and retention expiry have not yet been observed.

While operator mutations were paused, PostgreSQL 16.14 produced separate logical
archives of the three actual hosted databases. Table fingerprints were stable
before and after capture. All archives were restored with `pg_restore
--exit-on-error --single-transaction` into newly created, isolated databases on
the same private cluster:

| Store       | Tables | Rows at capture | Archive bytes |
| ----------- | -----: | --------------: | ------------: |
| Application |     10 |              17 |        27,079 |
| Inventory   |      4 |               8 |         7,718 |
| Carrier     |      3 |               2 |         5,955 |

Data fingerprints, schemas, database ownership/permissions and archive checksums
matched. All three temporary databases and their archive directories were
removed, then absence was checked independently. Capture preceded dispatch
acceptance; the restored provider commitment tables were empty at that point.
The separate repository backup drill covers a synthetic approval and unknown
dispatch.

The retained native snapshot was **not restored**. Logical restore was tested on
the existing host, not a replacement service or region; there is no tested
point-in-time recovery, recovery-time SLA or distributed-snapshot guarantee.
Restoring application data cannot undo provider actions or preserve later key
revocations automatically. Follow the [recovery runbook](pilot-deployment.md#backup-restore-and-upgrades)
before enabling execution from any restored database.

## Operational handoff

The temporary bootstrap service and its privileged environment were removed
after provisioning. The temporary SSH registration, key files and source upload
archive were also removed.

Deployment credentials and operator login instructions are kept in owner-only,
ignored local files and Railway's service variables. Neither the operator's
network address nor credentials are part of this repository. The operator
network rule needs an authenticated Railway change when that network changes;
forwarding headers must not be used as an access workaround.

The pilot has one database host, no failover and no production SLA. It uses
synthetic costs, deadlines and carrier semantics. Provider selection, contract
validation, representative capacity, practitioner acceptance and alert delivery
remain prerequisites for live operational use. See the [remaining gates](pilot-validation.md)
and [deployment recipe](railway-deployment.md).
