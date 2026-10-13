# TD-BROWSER-15: Server policy engine (embedded Cedar)

**Status:** Planned
**Decision:** [ADR-024](../adr/024-server-policy-engine-cedar.md)

## Problem

Server policy is spread across environment variables (`AGENTBROWSER_ALLOW_LOOPBACK`,
`AGENTBROWSER_ALLOWED_CIDRS`, `AGENTBROWSER_APPROVAL_POLICY`, the CDP-attach acknowledgement and
others), is global to the process rather than per tenant, and cannot be queried by agents. ADR-024
has the analysis and the decision; this TD is the plan.

## Phases

Each phase is its own PR with its own adversarial review, test-first. Each phase leaves the server
behaving exactly as before unless a policy file is supplied.

### Phase 1: the `Authorizer` seam and the equivalence oracle (no behaviour change)

**Introduce the seam.** A new package `@agentbrowser/policy-engine` exports:

```ts
interface Authorizer {
  readonly version: string; // SHA-256 of the canonical policy document
  decide(request: AuthorizationRequest): PolicyDecision; // synchronous: pre-parsed
}
```

Its first implementation, `LegacyAuthorizer`, wraps **today's** logic: the loopback and CIDR
exceptions, the approval-rule matcher and the capability gates, moved behind the interface
unchanged and given rule ids such as `env.allow-loopback` and `env.approval.rule-<n>`.

**Route every existing decision through it:**

- the egress checks that consult the loopback and private-CIDR exceptions;
- `checkApproval`'s operator-rule lookup;
- capability gates: CDP attach (including the hosted and multi-tenant refusals), service workers,
  downloads, cookie export and seed, headed and delegated creation.

The floor (metadata, DNS pinning, cap enforcement, token binding, redaction) is **not** routed
through it; it stays where it is.

**Record the oracle.** A table-driven test enumerates the decision inputs the current test suites
exercise and records today's outcome for each. This table is the equivalence oracle phases 2 and 3
must match.

**Tests:** the oracle passes against `LegacyAuthorizer`; all existing suites pass unchanged.

### Phase 2: the Cedar schema and the generated policy set

**Schema.** `packages/protocol/src/policy/agentbrowser.cedarschema`, with a TypeBox schema for the
policy document (`version`, `policies`, `limits`).

- **Entities:** `Tenant`; `Session in [Tenant]` (attributes: engine, cdpAttach, controlMode,
  headless); `Host` (attribute: domain).
- **Actions:** `request`, `navigate`, `act`, `cdp.attach`, `serviceWorkers`, `downloads`,
  `cookie.export`, `cookie.seed`, `session.headed`, `session.delegated`.
- **Context:** each action declares its own, for example `addressClass`, `scheme` and `port` for
  `request`; `effect`, `role` and `name` for `act`.
- **Docs and test fixtures are generated from the schema** (ADR-015), not hand-copied.

**`CedarAuthorizer`.** It loads `@cedar-policy/cedar-wasm/nodejs` once.

- At construction it calls `preparseSchema` and `preparsePolicySet` (ids namespaced by policy
  version, since the WASM cache is process-global) and runs `validate` in strict mode.
- `decide` calls `statefulIsAuthorized`.
- Results map onto `PolicyDecision` as follows: decision → `allowed`; the deciding policy id →
  `ruleMatched`; `@reason` → `reason`.
- Cedar evaluation errors in a policy are surfaced at load wherever validation can find them. At
  request time they deny with `ruleMatched: "engine.error"`; they never allow.

**Generated policies.** `policiesFromEnvironment()` translates today's variables into Cedar text
with the same ids `LegacyAuthorizer` uses.

**Tests:**
- The phase-1 oracle passes against `CedarAuthorizer` loaded with the generated policies. This is
  the behaviour-equivalence gate.
- Strict validation rejects unknown attributes, mismatched types and unknown actions, with an error
  location and no document contents.
- An engine error denies.
- Decision reasons report the policy id, not Cedar's positional `policy<n>`.

### Phase 3: the policy file

- `AGENTBROWSER_POLICY_FILE` loads, parses, validates and canonicalizes the document. Its version
  is the SHA-256 of the canonical JSON.
- An invalid file, a file combined with any policy-bearing variable, or an unknown `limits` key
  aborts startup and names the problem.
- The policy version is stamped on the session view at creation.
- Limits from the file replace the corresponding variables (`maxResponseBytes`, `extractMaxBytes`,
  …), with their existing bounds.
- **Deprecation:** the policy-bearing variables log a one-line startup warning that names the
  replacement; they keep working.
- **Server switch:** with no file, the server uses `CedarAuthorizer` with generated policies.
  `LegacyAuthorizer` stays only as the oracle's reference implementation in tests.

**Tests:** startup refusals; the version is stable across key order and whitespace; per-tenant
loopback (tenant A reaches a loopback fixture; tenant B is denied with `ruleMatched: "default.deny"`,
because no policy permits it); deny-wins composition with session `allowedHosts` and engagement scope.

### Phase 4: query surface

- **`GET /v1/policy`:** version, limits, and a capability summary per tenant. Each capability is
  evaluated with the caller's tenant principal and returns `{ allowed, ruleMatched, reason }`. No
  raw policy text.
- **`POST /v1/policy/check`:** `{ action, url?, context? }` → `PolicyDecision`.
  - There is no DNS resolution. A hostname is checked as declared, an IP literal is classified, and
    answers that depend on resolution say so.
  - Request-size bounds come from the schema; the route is rate-limited per tenant.
- **Errors:** `POLICY_DENIED` and `APPROVAL_REQUIRED` populate `policyDecision` from the deciding
  rule. Floor denials report `floor.<rule>`.
- **Surfaces:** SDK `client.policy.get()` and `client.policy.check()`; the CLI's `agentbrowser
  policy` and `agentbrowser policy check <action> [url]`; a read-only MCP `policy` tool in every
  mode.
- **Tests:**
  - A tenant cannot see another tenant's decisions or text.
  - `check` never resolves DNS. The test uses a resolver spy that must not be called.
  - `check` agrees with real enforcement on IP literals and on every oracle row.
  - The MCP tool appears in all modes; `structuredContent` matches the REST shape.

### Phase 5: per-session cache, logging and the performance gate

- **Session-scoped decision memo**, keyed by action, host, address class and the action's declared
  context fields. It is cleared at session close.
- **Logging:** a deny logs at `warn` and an approval-required decision at `info`, through
  `StructuredLogger`, carrying the policy version and rule id.
- **Benchmark:** a page with 300 subresources, uncached and cached. The gate (the maximum share of
  load time spent in policy evaluation) is set from the first measured run and recorded here.
  - The spike measured about 78 µs per uncached pre-parsed decision.
  - The cache should make repeated hosts nearly free.
- **Packaging:** `@cedar-policy/cedar-wasm` enters the server tarball and Windows bundle via the
  existing deploy.
  - **Size:** the install-size gates gain the measured delta, about 4.3 MB for the Node build.
  - **Shipped files:** only the `nodejs/` build is shipped; the web and ESM builds are pruned at
    packaging time.
  - **Shipped-path gate:** it still passes (the package contains no build-machine paths).
  - **Windows smoke:** the bundle smoke checks evaluate a decision on Windows.

### Phase 6: documentation

- **Policy guide** (`docs/policy.md`): the schema reference (generated), examples replacing each
  deprecated variable, the per-tenant pattern, how to test a policy with `policy check`, and the
  floor's fixed rules.
- **`docs/operations.md`:** policy-bearing variables marked deprecated with their replacement.
- **Threat model:** the policy file is trusted operator configuration. A tenant can query only its
  own decisions, and `check` is not a DNS oracle.
- **ADR-024 status → Accepted** when phase 5 ships.

## Non-goals

- Reloading policy without restart (a later decision; a reload must never relax a live session).
- Policy over page content, or Cedar in the CLI or MCP executables.
- Replacing `SessionPolicySchema` or engagement scope.
- Making the safety floor configurable.

## Risks

- **Equivalence drift between generated policies and legacy code.** Mitigated by the phase-1
  oracle gating phases 2 and 3.
- **WASM cache is process-global.** Policy-set ids are namespaced by version so concurrent loads in
  tests cannot collide.
- **Hot-path cost on pages with many hosts.** Mitigated by the per-session memo and the phase-5
  gate; decisions stay synchronous and in-process.
- **Operators writing an over-broad permit.** The floor still holds, and `GET /v1/policy` makes the
  effective capabilities visible. The guide includes a review checklist.
