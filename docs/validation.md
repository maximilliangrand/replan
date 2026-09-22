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

No operations practitioner has reviewed the domain assumptions or completed the acceptance drill. No real inventory/carrier integration, customer pilot, public hosting, or production load validation has occurred. Data volumes are deliberately small. The authored evaluation cases do not establish generalization to real disruptions. The pilot foundation adds provisioned identity and application-enforced workspace permissions; it has not received an independent security assessment. See [pilot validation gates](pilot-validation.md).
