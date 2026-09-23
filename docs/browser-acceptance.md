# HTTPS browser acceptance

These tests run the built React application in an actual Chromium browser through
Caddy HTTPS, with the pilot API, a restricted runtime database role and separately
persisted synthetic inventory/carrier services. They do not mock browser fetch or
replace the UI with API calls for approval, dispatch or recovery.

## Reproduce

Install a Caddy 2.11.4 executable and set `CADDY_BIN` to its absolute path. The
harness also recognizes `.local/validation/caddy/caddy`. Use a supported Node
version and the dedicated local test cluster:

```sh
npm ci
npm run db:start
npx playwright install chromium
npm run test:browser
```

On Linux, Playwright may also need its documented browser system dependencies:
`npx playwright install --with-deps chromium`. CI installs the pinned Caddy release
and verifies its published SHA-256 before executing it.

`TEST_DATABASE_URL` selects an alternative test cluster and must name a database
ending in `_test`. Its administrator must be able to create the harness's three
random databases and temporary role. The harness only removes resources it
created; it does not reset an existing workspace or run against a live provider.

## Exercised behaviour

- A real browser receives and uses a `Secure`, `HttpOnly`, `SameSite=Strict`,
  `__Host-` session cookie. It is not available to JavaScript or local/session
  storage. Pilot fault controls are absent.
- The operator optimizes and approves the displayed plan, encounters a real
  provider response lost after commit, and recovers through the UI. The resulting
  export independently verifies three unique dispatches and no unresolved plan.
- A viewer cannot use mutation controls or bypass them with a same-origin browser
  request. Rotating an operator key invalidates an existing browser session;
  the old key is rejected. Logout removes the cookie and replaying the old cookie
  still returns 401, proving server-side invalidation.
- Changing the provider credential while the app retains its old credential
  makes readiness fail. Attempted execution remains unresolved with no recorded
  shipment; reconnecting the correctly configured app allows recovery and
  exactly three independently recorded shipments.
- Application and ingress logs are checked for the generated access/session
  secrets. Traces and video are disabled so authentication payloads are not
  written to test artifacts. A screenshot of the completed synthetic operation
  is saved under ignored `test-results/browser/`.

## Certificate and deployment limits

Each fixture creates a short-lived, self-signed certificate for loopback and
passes only that certificate's public-key hash to Chromium's test process.
`ignoreHTTPSErrors` remains false. Node's HTTPS checks trust that exact fixture
certificate and verify its hostname. No CA is installed into the operating
system, no ordinary browser profile is reused and no public DNS or certificate
account is changed. The temporary key and certificate are removed at teardown.

This verifies local HTTPS, browser behaviour, application permissions and the
synthetic provider contract. It does **not** verify a public certificate chain,
the selected host's firewall/allowlist, remote secret storage, external-provider
behaviour or a human operator's acceptance. Those require the actual target
host, provider sandbox and workflow owner.
