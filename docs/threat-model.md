# Threat Model (TD-006)

Written working backwards from the MVP spec's threat inventory (§17-§18):
every threat below maps to the control that addresses it and the test that
proves the control works. Residual risks are named, not hidden.

## Trust boundaries

1. **Caller -> service**: the HTTP surface. Untrusted by default; bearer
   keys identify tenants when configured (no-keys = trusted single-tenant
   local mode, loudly warned).
2. **Service -> engine**: in-process, trusted.
3. **Engine -> network**: intended egress boundary; HTTP redirect hops are
   covered by walking chains in the routing choke point (all-hop
   enforcement, 2026-09-30). OS-enforced containment is not provided. The
   loopback block is operator-opt-out at server startup
   (AGENTBROWSER_ALLOW_LOOPBACK) for local-machine testing; it is never
   settable from session or request input. The opt-in lets visited pages
   reach every loopback service including this server's own API — in
   no-keys local mode that is full unauthenticated control of all
   sessions; keyed mode auth-gates the service but other loopback
   services remain exposed.
4. **Page content -> agent**: everything the browser returns (text,
   names, values, titles) is hostile-injected data.

## Threats and controls

| Threat (spec) | Control | Proof |
| --- | --- | --- |
| SSRF to loopback / private ranges / cloud metadata via navigation | Service fast-fail + host/resolved-address checks on routed requests; no browser connection pinning | `network-policy.test.ts` loopback/private/metadata suites; initial-hop engine tests |
| Equivalent IP spellings / malformed resolver answers (R14) | Native IP identity classification under configured flags; strict resolved-literal syntax; direct downloads validate every address/family pair before selecting a connection | `address-policy.test.ts`; real `download-transport.test.ts` zero-TCP/HTTP denials plus permitted-local positive controls; not full browser containment |
| Redirect-based policy bypass (public URL -> 302 -> blocked host) | All-hop enforcement: chains walked in the choke point, fresh verdict + hop cap + loop detection per hop; a denied terminal is never fetched (body-bearing POST/PUT/PATCH still pass natively) | Real-Chromium chain test `redirect-gap-real-chromium.test.ts` (checked list includes the denied hop, zero hits); route-handler units `egress-boundaries.test.ts` |
| Subresource / XHR / fetch bypass | Routed requests checked including redirect chains (body-less); service workers blocked; body-bearing requests keep the native passthrough residual | `egress-boundaries.test.ts` chain-walk units; real-Chromium chain test |
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

## Open gaps and residual risks

- **Later-hop redirects (RESOLVED 2026-09-30 for body-less routed chains,
  was R4, not accepted debt)**: the routing choke point now walks redirect
  chains itself — fresh host/address verdict, a ten-hop cap, and loop
  detection per hop — and allowed chains complete in two phases: the
  verified terminal URL is handed back to the browser as a redirect, so
  the document lands at the right address and no unchecked hop is ever
  followed. Residuals: the browser's native fetch of the verified terminal
  is not re-capped (content TOCTOU, same residual class as the next item);
  body-bearing `POST`/`PUT/PATCH` requests still pass through natively
  (the 2026-09-12 fidelity exception), so their redirects remain
  unchecked; OS-enforced containment remains a separate layer.
- **DNS rebinding (PARTIAL)**: routed requests recheck all resolved addresses
  per hop, without hostname-verdict caching, and session policies delegate
  those checks. Browser connections are not pinned to those addresses.
  Direct downloads separately validate and pin each connection.
- **WebSocket upgrades (PARTIAL)**: root and session-only policies now install
  the same default page WebSocket deny handler — upgrades close with code
  `1014` / `blocked by egress policy` (the operator-facing diagnostic). The
  real Chromium page fixture
  has zero server connections; this does not establish worker coverage or a
  network-wide boundary. Selective forwarding remains unsupported under the
  fetch/fulfill combination; explicit `off` and no-policy modes are unguarded.
- **Response-size caps (PARTIAL)**: browser declared-length and actual-byte
  checks apply to the terminal response of walked chains; actual bytes are
  checked after buffering, not as a peak-memory bound; body-bearing
  passthrough responses are uncapped. Direct downloads separately enforce
  streaming decoded-byte limits.
- **Body-bearing request fidelity (RESOLVED 2026-09-12)**: the fetch/fulfill
  choke point's response-inspection benefit came at the cost of request-body
  fidelity for `POST`/`PUT`/`PATCH` — Playwright's `route.fetch()` re-issue does
  not preserve some request bodies byte-for-byte (confirmed: an S3 presigned-POST
  multipart upload, a common direct-to-cloud-storage pattern, fails S3's
  signature check when replayed this way, though it succeeds natively). Unlike
  the other gaps in this list, this was not a hole in the SSRF boundary itself —
  it was the enforcement mechanism corrupting traffic it already intended to
  allow. Fixed by routing these methods through `route.continue()` after the
  same target-verdict check, trading away redirect-hop re-checking and
  response-size capping for these methods specifically (see ADR-006).
- **Service-worker choke-point bypass (ACCEPTED, opt-in — 2026-09-13)**:
  service-worker-originated requests bypass `context.route()` entirely (a
  still-open Playwright limitation), so any session with a request policy
  attached blocks service workers by default — an unblocked one would be a
  hole in the choke point. This restriction was identified while investigating
  Ashby ATS rejections affecting both automated and human clicks in the same
  browser session; its contribution to those rejections remains unproven. `allowServiceWorkers` (ADR-019) is an explicit,
  off-by-default per-session option a caller sets to accept this trade-off
  for one session; the default session behavior is unchanged and still
  blocks service workers whenever a request policy applies.
- **OS containment (NOT SHIPPED)**: the accepted contained Chromium profile
  requires an external gateway and OS-enforced gateway-only egress. Native local
  operation remains available without that guarantee. Full ADR-008 multi-tenant
  isolation remains deferred; an ordinary Docker bridge is not forced egress.
  The pairing requirement (application layer + OS layer, neither a
  substitute for the other) is documented as the T7 prerequisite in
  [t7-os-egress-pairing](spec/design/t7-os-egress-pairing.md).
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
