# Private pilot deployment and validation

This deployment boundary is for a small, invited pilot behind an office/VPN IP
allowlist. It adds authenticated people, workspace isolation, deliberate database
migrations and recovery controls. It does not turn the bundled inventory and
carrier simulators into live integrations. No hosted deployment is created by
these files.

## Provision infrastructure

- Use PostgreSQL 16 or newer, a dedicated `replan` database, and separate
  `replan_owner` and `replan_runtime` login roles. The owner performs migrations;
  the application does not receive its credential. Do not use a PostgreSQL
  superuser for the running application. Enable managed backups and network
  restrictions. For a remote database, configure a trusted CA and certificate
  verification; do not disable certificate validation.
- Supply inventory and carrier adapters implementing the contracts in
  `src/providers.ts`. Before enabling live execution, validate their atomic stock
  reservations, stable idempotency keys, reconciliation and cancellation fences
  against the provider's sandbox. A locally absent record is not proof that an
  outstanding request can never commit.
- Point a dedicated DNS name at the deployment host. Caddy is the direct ingress
  and obtains its HTTPS certificate using ports 80/443. Set an explicit list of
  office/VPN public IP ranges. The application and provider containers publish no
  host ports. Do not put another proxy in front without reviewing client-IP
  handling; this configuration intentionally ignores spoofable forwarded IPs.

Docker Compose and an externally provisioned database are required. Choose a
reviewed application image/revision; the local build command below tags the
checkout's image. The Caddy version is pinned in the compose file.

```sh
mkdir -p .local
cp deploy/pilot.env.example .local/pilot.env
chmod 600 .local/pilot.env
```

Fill in the file using a private editor or secret store. `APP_ORIGIN` must be the
exact HTTPS origin, with no path or trailing slash; `APP_DOMAIN` must be its DNS
hostname. Use one canonical hostname. Set `PILOT_ALLOWED_CIDRS` to your actual
office/VPN egress IPs, not the example or an allow-all CIDR. `DATABASE_URL` and
`MIGRATION_DATABASE_URL` point to the same database with different roles. Generate
`PROVIDER_TOKEN` with a password manager or at least 32 random bytes and provision
the matching credential at both adapters. Percent-encode special characters in
database URL credentials. Never commit the environment file or print a resolved
Compose configuration containing its secrets; use `config --quiet`.

## Migrate, grant privileges, and start

```sh
docker compose --env-file .local/pilot.env -f compose.pilot.yaml config --quiet
docker compose --env-file .local/pilot.env -f compose.pilot.yaml build replan
docker compose --env-file .local/pilot.env -f compose.pilot.yaml run --rm migrate
```

After migration, run `deploy/runtime-grants.sql` as the owner on the application
database. The sample assumes the database is named `replan`; adapt that one name
if necessary. The runtime role can read identity/ownership information and write
workflow/session records, but cannot create schema or change credentials, roles,
workspace membership or dataset ownership. PostgreSQL requires an update
privilege for the login row lock, so only the operator display-name column is
updateable by that role; actor UUIDs remain owner-only.

```sh
docker compose --env-file .local/pilot.env -f compose.pilot.yaml up -d --wait replan ingress
```

`MIGRATE_ON_START=false` makes startup verify the migration versions/checksums
without running DDL. Migration mismatch stops startup. The application image runs
as an unprivileged user with a read-only filesystem and temporary `/tmp`; the
solver uses the environment built into the image rather than installing packages
at runtime. Keep a single application replica for this first pilot.

`GET /api/health` is process liveness. `GET /api/ready` also checks the database and
both providers. The internal probe supplies the canonical Host header. Neither
endpoint reveals credentials or workspace data. Monitor readiness failures,
HTTP 5xx, database/connection exhaustion, expired certificates and operations
remaining uncertain. A failed readiness probe does not automatically restart a
Docker container; the host monitoring/on-call policy must act on it.

## Provision people and dataset ownership

The administration commands run with the migration/owner credential, not the
runtime application's identity. They verify/apply reviewed migrations before
changing administrative data.

```sh
docker compose --env-file .local/pilot.env -f compose.pilot.yaml run --rm migrate \
  node --import tsx scripts/workspace.mts create --name "Factory pilot"
```

Copy the returned workspace UUID into each person's provisioning command:

```sh
docker compose --env-file .local/pilot.env -f compose.pilot.yaml run --rm migrate \
  node --import tsx scripts/operator.mts create \
  --name "Jane Doe" --role admin --workspace WORKSPACE_UUID
```

Create separate `operator` and `viewer` identities where appropriate. Viewers
review state/evidence; operators can propose, approve and operate plans; admins
can also import operations. There is no public signup or shared default key.
The command prints the generated access key once; deliver it privately to its
person. Never record provisioning output in a shared terminal session or CI log.
Browser login exchanges that key for an eight-hour `HttpOnly`, `Secure`,
`SameSite=Strict` cookie. The database stores credential/session hashes, not the
plaintext keys. CLI callers can use an `Authorization: Bearer` header without
putting the key in command-line arguments. There is no SSO/MFA integration yet.

```sh
docker compose --env-file .local/pilot.env -f compose.pilot.yaml run --rm migrate \
  node --import tsx scripts/operator.mts rotate --id OPERATOR_UUID
docker compose --env-file .local/pilot.env -f compose.pilot.yaml run --rm migrate \
  node --import tsx scripts/operator.mts revoke --id OPERATOR_UUID
```

Rotation invalidates the old key and all sessions. Revocation disables the person.
Requests already in flight can finish, so credential revocation is not a carrier
cancellation mechanism. Login throttling is bounded and per process; behind this
direct proxy clients share its peer address and may share the ten-login-per-minute
budget. Before scaling replicas or expanding access, add reviewed ingress/shared
rate limiting and identity-provider integration.

A new workspace intentionally starts empty. An adapter administrator first
provisions a fresh dataset in both providers, then binds its UUID to one workspace:

```sh
docker compose --env-file .local/pilot.env -f compose.pilot.yaml run --rm migrate \
  node --import tsx scripts/workspace.mts assign \
  --id WORKSPACE_UUID --scenario SCENARIO_UUID --source "ERP import batch reference"
```

Assignment is an immutable insert: the same provider UUID cannot be reassigned,
even to the same workspace. Check its ownership before assigning it. A workspace
admin can then import `{ "scenario": ... }` through `POST
/api/operations`, using the `Scenario` structure in `shared/contracts.ts`. The
server requires the preassigned owner before contacting providers, validates the
operation, and fetches authoritative inventory. The dataset must have no prior
reservations/shipments. Import starts its relative repair windows; it must occur
when the operation actually begins. Re-import cannot restart those deadlines.

Pilot mode has no reset, consume-stock or injected-crash endpoints. Optional
simulators are enabled explicitly for validation:

```sh
docker compose --env-file .local/pilot.env -f compose.pilot.yaml --profile simulation \
  up -d --wait inventory carrier
```

For that profile set separate, nonempty `INVENTORY_DATABASE_URL` and
`CARRIER_DATABASE_URL`; each service owns its schema. Set application URLs to
`http://inventory:4311` and `http://carrier:4312`. Compose supplies the shared
`PROVIDER_TOKEN` as `SIMULATOR_TOKEN`. These private containers remain synthetic
evidence and are never a substitute for provider acceptance testing.

## Validate before enabling real execution

Use different workspaces and people to verify login, role denials, cross-workspace
denials and attribution. Run one complete transfer, concurrent requests, a stale
observation, a lost provider response, a process restart and cancellation racing
dispatch. Confirm actual provider ledgers, not just UI status. Cancellation must
preserve confirmed shipments and hold ambiguous commitments until a provider
fence resolves them. Never delete an uncertain row or create a replacement key
to bypass a blocked operation.

The repository tests exercise these boundaries against independently persistent
simulators. They establish application behavior under those contracts. The pilot
owner still needs real-adapter results, an independent operator walkthrough,
deployment/security review, capacity measurements and an incident owner before
approving live operational use.

## Backup, restore, and upgrades

On a development/CI host with Node, dependencies and matching PostgreSQL client
tools installed:

```sh
npm run db:start
npm run backup:drill
```

For another **test** cluster set `BACKUP_ADMIN_DATABASE_URL` to its database ending
in `_test`; the role needs `CREATEDB`. `PG_BIN` can select a PostgreSQL client
directory. The drill creates two randomly named databases, migrates a synthetic
source, records an approval and unknown dispatch, uses `pg_dump`/`pg_restore`,
compares every application's table contents and verifies the restored event
sequence. It deletes only its newly created databases and temporary dump. A
failure exits nonzero. Existing databases are neither dumped nor modified. This
is a reproducible application-restore check, not a measured production RPO/RTO,
point-in-time recovery test, or backup of provider systems.

For an actual deployment, configure encrypted retained backups and point-in-time
recovery with the database owner, then periodically restore an actual backup into
an isolated environment with outbound execution disabled. Database restore does
not undo carrier dispatches. Reconcile against independent provider ledgers,
especially all activity after the restored backup timestamp, before allowing any
execution. Application records lost after a backup cannot be reconstructed
automatically by this MVP. Revoke restored sessions and review key rotations that
occurred after the backup. Never run two copies of a restored operation against
the same live providers.

For upgrades: preserve a recoverable backup, drain in-flight requests, run the
explicit migration command, apply reviewed grants for any new objects, and start
the reviewed image. Applied migration checksums are immutable. Do not use an
older binary against a newer schema unless that compatibility has been tested;
there is no automatic destructive down-migration.

Relevant references: [PostgreSQL logical backups](https://www.postgresql.org/docs/16/app-pgdump.html),
[Caddy IP matching](https://caddyserver.com/docs/caddyfile/matchers#remote-ip), and
[Compose profiles](https://docs.docker.com/reference/compose-file/profiles/).
