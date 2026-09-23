# Railway hosted pilot

This profile runs the authenticated pilot on Railway with **synthetic inventory
and carrier providers**. Hosting the application does not establish real shipment
execution. The interface explicitly identifies the simulated providers.

See the [2026-09-23 hosted acceptance record](railway-acceptance.md) for the
actual deployment, recovery and backup checks.

## Runtime boundary

- One application replica, two private provider services and PostgreSQL 16 in
  the same Amsterdam region. PostgreSQL has a persistent volume. Each provider
  owns a separate database; the application uses a restricted runtime role.
- Only the application has a public HTTPS domain. PostgreSQL and providers have
  no public domain or TCP proxy. Internal connections use Railway's private
  network, not an internet-exposed database endpoint.
- Railway terminates HTTPS. Native edge rules admit the configured operator
  network and deny other networks. Application authentication is still required.
  Do not reuse the direct-ingress Caddy `remote_ip` rule behind Railway's proxy.
- CDN caching must remain disabled. `edgeConfig.enabled=true` alone does not mean
  caching is enabled; check that `caching` is absent or its mode is `off`.
- Use direct PostgreSQL connections. Transaction pooling is incompatible with
  the session advisory locks that serialize workspace operations.

See [Railway private networking](https://docs.railway.com/networking/private-networking),
[edge rules](https://docs.railway.com/networking/edge-rules) and the general
[pilot runbook](pilot-deployment.md).

## Fresh database bootstrap

`deploy/railway-bootstrap.mts` is an initial-install command for a new, dedicated
PostgreSQL 16 cluster. Run it in a temporary private administration container
built from the reviewed application revision. Supply through the secret store:

- `BOOTSTRAP_DATABASE_URL`: privileged connection to the `postgres` database.
- `REPLAN_OWNER_PASSWORD`, `REPLAN_RUNTIME_PASSWORD`,
  `INVENTORY_DATABASE_PASSWORD`, `CARRIER_DATABASE_PASSWORD`: distinct randomly
  generated secrets of at least 32 characters.

```sh
node --import tsx deploy/railway-bootstrap.mts
```

The command refuses any existing target role or database before making changes.
It creates four restricted login roles, three separately owned databases,
explicit connection privileges, the application migrations and runtime grants.
Provider schemas are initialized by their own services. It prints no passwords.
PostgreSQL database creation is not transactional: inspect a partial failure
instead of deleting data or rerunning the command. This command is **not** an
upgrade or restore procedure.

Provision workspaces and individual identities with the existing administration
CLIs, using the schema-owner credential. Capture generated operator keys into a
private secret store, never shared deployment logs. Remove the temporary
administration service and its credentials after provisioning.

## Service configuration

Build the existing Dockerfile for the app and providers. It includes the locked
Node/Python dependencies and solver. Use the following start commands:

| Service     | Start command                                      |
| ----------- | -------------------------------------------------- |
| Application | `node --import tsx src/server.ts`                  |
| Inventory   | `node --import tsx deploy/simulator.mts inventory` |
| Carrier     | `node --import tsx deploy/simulator.mts carrier`   |

Application configuration follows `deploy/pilot.env.example`, with:

- `REPLAN_MODE=pilot`, `NODE_ENV=production`, `HOST=::`, `PORT=4310`.
- Exact public HTTPS `APP_ORIGIN`; `MIGRATE_ON_START=false`.
- `DATABASE_URL` belonging only to `replan_runtime`.
- Private provider URLs and a shared random `PROVIDER_TOKEN`.
- `HEALTHCHECK_HOSTNAME=healthcheck.railway.app`, permitting only
  `GET /api/ready` under Railway's probe hostname. It grants no other route access.
- `REPLAN_SYNTHETIC_PROVIDERS=true`, exposing the simulation disclosure.
- `UV_NO_SYNC=1`, `UV_CACHE_DIR=/tmp/uv`, `PYTHONDONTWRITEBYTECODE=1`.

Each provider uses its own database credential, `SIMULATOR_TOKEN`, `HOST=::`
and `SIMULATOR_HOSTNAME` equal to its exact private Railway hostname. Hostname
configuration does not bypass token authentication, including on `/health`.
Provider services must remain private.

Railway allocates private DNS when each service is first deployed. Verify the
allocated endpoints before starting dependent services, then set the exact
provider hostnames and URLs. An unresolved service reference must not be treated
as a ready dependency. Initialize the database before starting the application;
its runtime role cannot bootstrap its own schema.

## Monitoring and operation

The [read-only monitor](operations.md) supports a dedicated viewer credential.
If it runs outside the operator network, an edge exception may admit only that
credential and the exact `/api/ready` and `/api/operations/health` paths. Place
that narrow exception before the network allow rule and final catch-all deny.
Never exempt arbitrary API paths or trust caller-supplied forwarding headers.

Railway deployment healthchecks run at startup; they are not continuous
monitoring. Verify the scheduled probe's execution and exit status separately.
Configure database-volume backups and retain evidence of an isolated restore.
Do not restore over the live database merely to test recovery.

Before broadening access or enabling external actions, complete the remaining
[provider and operator acceptance gates](pilot-validation.md). The pilot still
has one database host and one app replica; it is not a highly available service.
