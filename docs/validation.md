# Validation record

This record describes finite checks of the synthetic demonstration, not a production reliability claim.

## Released v0.1.0 verification, 2026-09-22

- macOS, Node 26.7.0, PostgreSQL 16.14, Python 3.12 and the locked OR-Tools dependency.
- TypeScript typecheck, Vite production build and formatting checks.
- 52 TypeScript tests and 14 Python tests passed.
- PostgreSQL-backed HTTP integration tests, including competing reservations and dispatches, stale observations, replacement approval, unavailable lookup and a real process restart after dispatch.
- Two delayed-commit regressions use PostgreSQL locks to establish that provider requests are already in flight before the client timeout. Repeated 404 responses do not permit releasing or replacing unresolved work.
- Python solver unit tests, including an independent exhaustive oracle for 64 small instances.
- Offline audit verification tests cover malformed evidence, modified fingerprints, missing approval, missing dispatch intent, duplicate shipments, and stock conservation failures.
- Dependency audit reports no known vulnerabilities for the installed lockfile at this check. This is not a general security certification.

The live **Safari** walkthrough exercised optimized and greedy proposals, exact approval, lost dispatch response, unavailable reconciliation, external stock consumption, preserved partial progress, replacement approval and completion. The final independent carrier state had three unique shipments costing $615. See the [actual exported evidence](evidence/browser-recovery.json); the offline verifier accepts it.

The separate browser crash walkthrough triggered the application's explicit exit after the carrier committed and before the application stored the result. The local runner restarted a new process. The application reported `uncertain`, retained `dispatching` intent with no local shipment receipt, and the carrier had exactly one shipment. Recovery then completed three unique shipments for $440. The [exported crash recovery evidence](evidence/browser-crash-recovery.json) also passes offline verification.

The local bootstrap was exercised from a checkout path containing spaces and correctly refused a changed port while its owned cluster was already running. Evidence export refuses to run while an application mutation holds the executor lock, avoiding an inconsistent mid-operation snapshot.

## Pilot engineering phase

The new phase adds PostgreSQL-backed authentication/session tests, real-HTTP workspace and permission tests, migration preservation checks, browser-component interaction tests, terminal-cancellation races, and actual process-kill recovery after cancellation intent. Local validation passed 139 TypeScript/browser tests, 15 Python tests, the build, dependency audit, and the synthetic backup/restore drill. The current CI run is the authority for the exact branch revision and test outcome. [Engineering acceptance and remaining external validation](pilot-validation.md) records the boundary of these checks.

## Local pilot acceptance, 2026-09-23

- All 156 TypeScript/UI tests and 15 Python tests pass. The TypeScript suite and three new Chromium browser scenarios also pass on Node 22.23.2, the CI runtime major version.
- The actual pilot application runs behind Caddy with HTTPS, a restricted database role and independently persisted synthetic providers. Browser tests cover login, secure cookies, viewer denial, key rotation, server-side logout, lost-response recovery and provider credential rotation. Final recovery evidence contains three unique confirmed dispatches and passes the offline verifier. See [browser acceptance](browser-acceptance.md) for the isolated test-certificate boundary.
- The credential-rotation scenario exposed a readiness bug: unauthenticated provider health checks could report ready when Replan held a stale token. Provider health now authenticates the configured token, and the browser test verifies readiness stays unavailable until reconnection.
- A read-only, workspace-scoped [monitoring probe](operations.md) reports dependency failures and stale unresolved, executing or cancellation-pending plans. Tests exercise real HTTPS, authentication, isolation, bounded responses, timeouts and sanitized failure output. At this local stage, no hosted scheduler or alert delivery had been configured.
- [Capacity acceptance](capacity.md) records 108 expected HTTP outcomes across four concurrent workspaces, each with 100 orders and 500 lanes. All four proposals are optimal; measured planning p95 is 1,627.99 ms on the documented local machine. The report includes source hashes and successful cleanup of all owned resources. This finite workload does not measure sustained dispatch throughput or establish a production SLA.
- Typecheck, production build, formatting and dependency audit pass; the installed lockfile has no reported vulnerabilities at this check.

These local checks use synthetic data and loopback infrastructure. Hosted acceptance is recorded separately in [the Railway deployment record](railway-acceptance.md). No real inventory/carrier adapter or customer acceptance has been validated. The [provider assessment](provider-assessment.md) identifies contract differences that must be resolved before enabling external execution.

## Reproduce

```sh
npm run db:start
npm ci
uv sync --frozen --project solver
npm run build
npm test
npm run test:solver
npm run evaluate
npm run verify:export -- docs/evidence/browser-recovery.json
```

The GitHub workflow runs the same contracts on Linux/Node 22/PostgreSQL 16 and separately builds Docker Compose and runs the complete lost-response smoke scenario. Consult the current workflow run for its actual status; the workflow's presence alone is not evidence of a successful run.

## Remaining validation

No operations practitioner has reviewed the domain assumptions or completed the acceptance drill. No real inventory/carrier integration, customer pilot, or production load validation has occurred. A temporary private hosted synthetic pilot passed the [Railway acceptance checks](railway-acceptance.md), then was intentionally taken offline on 2026-09-23. Data volumes are finite and authored; the evaluation and capacity cases do not establish generalization to real disruptions. The pilot foundation adds provisioned identity and application-enforced workspace permissions; it has not received an independent security assessment. See [pilot validation gates](pilot-validation.md).
