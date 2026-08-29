# Threat Model (TD-006)

Written working backwards from the MVP spec's threat inventory (§17-§18):
every threat below maps to the control that addresses it and the test that
proves the control works. Residual risks are named, not hidden.

## Trust boundaries

1. **Caller -> service**: the HTTP surface. Untrusted by default; bearer
   keys identify tenants when configured (no-keys = trusted single-tenant
   local mode, loudly warned).
2. **Service -> engine**: in-process, trusted.
3. **Engine -> network**: the egress choke point. ALL page-originated
   traffic crosses this boundary.
4. **Page content -> agent**: everything the browser returns (text,
   names, values, titles) is hostile-injected data.

## Threats and controls

| Threat (spec) | Control | Proof |
| --- | --- | --- |
| SSRF to loopback / private ranges / cloud metadata via navigation | Service fast-fail + engine choke point (per-host verdicts, memoized) | `network-policy.test.ts` loopback/private/metadata suites; engine redirect test |
| Redirect-based policy bypass (public URL -> 302 -> blocked host) | Engine proxies every request with `maxRedirects: 0` and vets each hop's real hostname (continue()d requests' redirect targets bypass interception - the reason for the proxy pattern) | `engine-playwright` "block a redirect to a denied host" |
| Subresource / XHR / fetch bypass | Same context.route choke point intercepts every request the context makes; service workers blocked (they bypass routing) | `engine-playwright` "block in-page fetches" |
| Session policy weakening by tenant | `SessionHostPolicy` is restrict-only: the SSRF base always runs after session allow/blocked lists | `network-policy.test.ts` "still enforce the base SSRF policy" |
| Cross-tenant session/artifact access | Bearer-key tenancy: keys held hashed, sessions stamped with tenantId, every /v1 session-scoped route (incl. WS, 4403) verifies ownership | `server.test.ts` authentication and tenancy suite |
| Unauthorized use | 401 without/with-unknown key when AGENTBROWSER_API_KEYS configured; loud warning when unauthenticated | same suite |
| Credential theft via vault references | `SecretManager`: vault:// refs resolved at execution time only; values redacted from observations, errors, logs, and spans; `toJSON` leaks nothing | `secret-manager.test.ts`; service redaction tests |
| Prompt injection via page content | `untrustedContent: true` on every observation; CLI/MCP render banners; nothing page-derived is ever concatenated into instructions by the service | observation schema + CLI/MCP tests |
| Stale-target mis-clicks | Revision-scoped refs + fingerprint checks before every action; STALE_TARGET never auto-retried; old-revision refs classify STALE, not missing | `action-executor.test.ts`; workflows 3 & 6 |
| High-risk actions without consent | ApprovalGate: transaction/account-security/external-message/destructive elements require a single-use, session- and fingerprint-bound token (403 carries the tokenId) | `approval-gate.test.ts`; workflow 7 |
| Download bombs | Downloads denied by default; per-session byte cap; `ArtifactStore` refuses oversize payloads | `artifact-store.test.ts`; download suite |
| Excessive resource retention | TTL-expiring artifacts; session expiry sweeps reconcile service state; bounded histories and span buffers | `artifact-store.test.ts`; expiry-cleanup test; soak |
| Process leaks | Engine close ends event iterators (browser-level close wakes waiters); soak audit reports zero leaked sessions/engine sessions | `soak.test.ts` |

## Residual risks (accepted for the MVP, named honestly)

- **DNS rebinding (MITIGATED)**: the choke point now resolves every
  hostname (dns.lookup, all addresses) and validates each resolved IP
  against the SSRF rules (`RequestPolicy.checkResolvedAddresses`); the
  verdict cache keys on the resolved set, so a changed resolution
  re-validates. Proven against a real public rebinding-shaped DNS name
  (localtest.me -> 127.0.0.1). IPv6/pinning hardening remains future
  work.
- **WebSocket upgrades (MITIGATED, with an upstream caveat)**: the http
  choke point's fetch/fulfill proxy breaks page WebSocket connections
  outright (upstream Playwright limitation, verified empirically); under
  egress the engine therefore defaults to deny-all - every upgrade is
  closed cleanly with code 1014. Selective forwarding
  (routeWebSocket.connectToServer) is broken by the same coexistence
  bug; without an egress policy WebSockets pass through untouched.
- **Response-size caps (ENFORCED)**: content-length headers are checked
  at the choke point, and responses without content-length (chunked) are
  buffered - bounded by the policy cap - with actual bytes enforced
  (`RequestPolicy.checkBodySize`). Both paths carry real-Chromium
  blocking tests.
- **Unauthenticated infra planes (HARDENED)**: `/metrics` requires
  bearer auth when keys are configured; `/health/ready` answers
  unauthenticated probes with a minimal `{status}` (no engine/version
  disclosure) and returns the full payload only when authenticated;
  `/health/live` stays open (liveness must never depend on auth).
- **Obscura engine (NOT ENFORCEABLE, experimental-only)**: probe-verified
  against v0.2.1 (2026-08-29) - under its Fetch interception,
  `Fetch.fulfillRequest` is ignored (policy-denied hosts still receive
  the request) and `route.fetch` follows redirects internally, so the
  engine-level egress choke point cannot enforce on Obscura. The
  experimental adapter is therefore benchmark-only (spec §17.2); the
  deny-path tests skip with the gap named and a truth guard in CI flips
  red when upstream fixes it. Full gap list: `docs/engines.md`.
- **No-keys local mode** is trusted single-tenant by spec; the startup
  warning is the contract with the operator.
- **In-memory secrets**: the SecretManager registry lives in process
  memory; a full memory dump would contain values. Vault-backed storage
  is the hosted-milestone path.

## Test-strategy alignment (spec §18)

Unit (schemas, refs, truncation, policy, approvals, secrets) -> engine
contract (FakeEngine reference) -> deterministic E2E (fixture pages, no
external network) -> security (this document's suites) -> performance/
soak -> the 50-task agent benchmark gate.
