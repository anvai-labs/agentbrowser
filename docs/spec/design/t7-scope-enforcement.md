# T7 slice 2: engagement scope enforcement

Status: in progress (slice 2a — synthetic gates). Task packet:
[t7-audit-security](../tasks/t7-audit-security.md). The bounty use case
(vision priority 5) is blocked on this slice ("it blocks dependent active
testing if incomplete"); T4's remaining production gates need live-target
authorization, so the scope primitive lands first and is qualified
entirely on local fixtures — no live targets, consistent with the
use-case gate ("permits live targets only with explicit authorization").

## Problem

An agent doing authorized security testing must be unable to leave the
engagement's declared scope: hosts, paths, methods, identities, time
window and request budget. Today the egress policy restricts
*destination safety* (SSRF: loopback/private/metadata) and session host
rules restrict *which hosts* a session may reach — but there is no
engagement-scoped model: no path scoping, no method scoping, no expiry,
no request budget, no identity binding, and no enforcement across
redirect hops as a single unit.

## Design

`EngagementScopePolicy` (packages/policy) — a stateful `RequestPolicy`
decorator composed OVER the session's base policy. The existing
invariant holds: scope rules can only RESTRICT; the base policy always
runs. Denial throws `NetworkPolicyError('POLICY_DENIED', ...)`, matching
the engine's typed-refusal contract (ADR-015 B9).

Scope dimensions (all checked per request, on the initial request AND on
every redirect hop — the F1 all-hop walker calls `checkRequest` per hop,
so each hop is a first-class scope check, never a free ride):

- **Hosts** (`allowedHosts`): exact or `.suffix` entries, same semantics
  as `SessionHostRules` — a `.suffix` entry matches SUBDOMAINS ONLY (the
  apex is not covered; list both `example.com` and `.example.com` when
  the apex is in scope, exactly as with session host rules). Exhaustive
  when set: everything else is denied (`SCOPE_HOST_DENIED`).
- **Paths** (`pathRules`): `{hostSuffix?, prefix}` entries; a request's
  pathname must match some rule bound to its host on PATH-SEGMENT
  boundaries — prefix `/api` admits `/api` and `/api/users` but never
  `/apix` (`SCOPE_PATH_DENIED`). A host with no binding rule is fully in
  scope for paths; absent rules mean all paths on allowed hosts are in
  scope.
- **Methods** (`allowedMethods`): uppercase-compared allow-list
  (`SCOPE_METHOD_DENIED`); absent means all methods.
- **Identities** (`identityBindings`): `{header, value, allowedHosts}` —
  a request carrying that header/value pair must target one of the
  binding's hosts, else the identity would leak to an unbound host
  (`SCOPE_IDENTITY_DENIED`). This is the enforceable form of "identities
  do not leak" at the transport layer: the credential-marking request is
  denied before the browser sends it. Scope of the guarantee: it holds
  on every walker-checked lane (initial requests and redirect hops);
  the body-bearing redirect residual below is the recorded exception —
  an allowed identity-marked POST whose redirect target is unbound is
  followed natively without a hop check, so identity binding is only as
  strong as that residual allows.
- **Time** (`expiresAt`, injected `now`): a scope is expired AT OR AFTER
  the boundary; an expired scope denies every
  check with `SCOPE_EXPIRED`. The clock is injected (default `Date.now`)
  so movement is testable (the F2 lesson: no hidden wall-clock reads in
  gate paths); verdicts are never cached, so expiry takes effect on the
  first request after the boundary.
- **Budget** (`requestBudget`): counts choke-point requests, redirect
  hops included, monotonically; exhaustion denies further traffic with
  `SCOPE_BUDGET_EXHAUSTED` — a spent budget is spent, including for
  previously-allowed hosts.

### Engine touchpoints (additive)

- `RequestPolicy.checkRequest` gains optional `method?: string` and
  `headers?: Record<string, string>`; the Playwright engine passes
  `route.request().method()` and the request headers at the choke point
  (initial request and per-hop, the hop reusing the original request
  headers — a redirect re-issues the same headers by specification).
  Existing policies ignore the new fields.
- No other engine change: frames inherit context-scoped routing, so
  child-frame requests are scope-checked exactly like top-level.
- `checkRedirectChain` on the wrapper re-derives per-hop `checkRequest`
  (scope + base verdict per hop) and deliberately does NOT double-invoke
  a base `checkRedirectChain`: the engine's walker calls `checkRequest`
  per hop, and the download lane walks chains with its own cap and loop
  detection without routing through this wrapper.

## Acceptance gates (real Chromium, local fixtures only)

Fixture transport note: the in-scope fixture binds 127.0.0.1; the
out-of-scope target is an unrouted TEST-NET-1 literal (192.0.2.7) —
denial precedes the wire, so the excluded host is never contacted, and
zero-leak is asserted by the `blocked` result plus the in-fixture's hit
log. Hostname-pattern matching (suffix rules, lookalikes) is pinned by
the policy package's unit tests; these gates prove enforcement through
the real choke point.

1. In-scope navigation allowed; out-of-scope host navigation blocked
   (`POLICY_DENIED`), zero server hits on the excluded host.
2. In-scope host redirecting to an out-of-scope host is blocked
   MID-CHAIN (the hop check), excluded host records zero hits.
3. A child-frame request to an out-of-scope host is blocked
   (context-scoped routing covers frames).
4. Path scoping: in-scope host, non-matching pathname denied.
5. Method scoping: a disallowed method is denied while allowed methods
   pass.
6. Expiry: a scope already past `expiresAt` denies the first request;
   a scope expiring mid-session denies the next request after the
   boundary (injected clock).
7. Budget: the request past the budget is denied and the fixture server
   records no further hits — exhaustion prevents further traffic.
8. Identity binding: a request carrying an identity marker to an
   unbound host is denied, and the unbound fixture never receives the
   identity header; the bound host receives it.
9. Composition: scope runs over the base policy and both independently
   deny (scope can never weaken the base).

## Residuals and prerequisite notes (stated, not hidden)

- **Operator cdp-attach lane**: navigation-preflight-only by contract;
  scope enforcement is not installed there (same lane exception as the
  WebSocket deny handler).
- **Body-bearing redirect residual** (ADR-006): POST/PUT/PATCH
  passthrough requests are scope-checked on the initial request;
  their native redirects are not re-checked — the pre-existing,
  documented residual, unchanged by this slice.
- **Workers**: service-worker and dedicated-worker traffic outside
  Playwright's page routing is not scope-checked — the same coverage
  boundary as the egress choke point itself; not represented as complete
  containment (T7 packet rule).
- **Gateway program**: `EngagementScopePolicy` does not participate in
  gateway snapshots; if scope enforcement is wanted in that lane it is a
  prerequisite to report, not an implicit restart (packet stop rule).
- **N2 prerequisite (OS-enforced egress pairing)**: hostile multi-tenancy
  requires the OS-level layer per the threat model; this slice is
  application-layer enforcement for authorized single-operator use and
  explicitly not a substitute — the pairing requirement stays recorded
  as the T7 prerequisite.
- **Methods on the passthrough lane**: method denial for POST/PUT/PATCH
  happens at the initial verdict (before passthrough), so a disallowed
  method never reaches the wire; response-side method semantics are out
  of scope.

## Service surface (delivered with the primitive)

- Wire shape: `policy.scope` on session create (REST/SDK), the
  `scope` object on MCP `browser_create`, and `--scope-file PATH` on
  the CLI (bounded 1 MiB reader, no symlink follow — identity-binding
  markers stay out of process arguments). Additive optional schema
  fields; no protocol version bump.
- Composition: the service wraps the session's host policy (or the SSRF
  base) with EngagementScopePolicy as the outermost layer; the download
  transport inherits the same wrapped policy.
- Preflight: the service navigates through a non-spending preflight
  (`preflightCheck`) — full denial checks, budget-exhaustion included,
  without consuming budget, so a navigation is charged once at the wire
  and denials surface as typed `POLICY_DENIED` ServiceErrors carrying
  the `SCOPE_*` sub-code before the request reaches the engine.

## Deliberately out of scope (later slices)

- Slice 1 (audit adapters with baseline/versioned measurements), slice 3
  (scanner regression adapters + role/business-logic fixtures), slice 4
  (SARIF/report templates) — on demand, per the packet.
