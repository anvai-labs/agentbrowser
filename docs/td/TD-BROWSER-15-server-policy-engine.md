# TD-BROWSER-15: Server policy engine (embedded Cedar)

**Status:** Planned
**Decision:** [ADR-024](../adr/024-server-policy-engine-cedar.md)

## Problem

Server policy is spread across environment variables, embedder options and code, applies to the
whole process rather than per tenant, and cannot be queried by agents. ADR-024 has the analysis and
the decision; this TD is the plan.

## Phases

Each phase is its own PR with its own adversarial review, test-first. **No phase changes the
behaviour of a server started without `AGENTBROWSER_POLICY_FILE`**, except phase 0, which only
hardens the floor.

### Phase 0: harden the floor (before anything becomes grantable)

**Wider metadata set.** `NetworkPolicy`'s metadata set gains:
- `fd00:ec2::254` (AWS IMDS over IPv6);
- `100.100.100.200` (Alibaba Cloud);
- `168.63.129.16` (Azure wire server);
- the IPv4 link-local range `169.254.0.0/16`.

The classifier marks all of these `metadata`.
- **Tests:** each address, IPv4-mapped IPv6 forms, and decimal, octal and hex literals are refused
  under every option combination, including `AGENTBROWSER_ALLOWED_CIDRS=fd00::/8`, which today
  reaches `fd00:ec2::254`.
- **Release notes:** call this out as a tightening.

**Unconditional refusals made explicit.** The CDP-attach refusals (hosted, multiple tenants,
missing bearer, non-loopback listener or peer, delegated sessions, cookie export or seed on an
attached profile) and the delegated-session operator requirement move into one `floor` module.
Each refusal gets an id (`floor.cdp.hosted`, …) that error responses report. **No behaviour
change**, and the existing tests pass unchanged.

### Phase 1: the `Authorizer` seam (no behaviour change)

`@agentbrowser/policy-engine` exports:

```ts
interface Authorizer {
  readonly version: string;
  decide(request: AuthorizationRequest): PolicyDecision; // synchronous
}
```

`LegacyAuthorizer` wraps today's operator-chosen decisions behind it, unchanged:
- the loopback and private-CIDR exceptions;
- the approval outcome per classified effect (`ActionRiskPolicy`'s classifier stays where it is
  and feeds the effect in);
- the capability grants (`allowServiceWorkers`, `allowDownloads`, cookie export and seed, headed).

The floor (phase 0) is not routed through it.

**Address classes become sets.** The classifier returns every class an address belongs to, for
example `::1` → `{loopback, private}`. `LegacyAuthorizer` reproduces today's decisions exactly,
including the quirk where `ALLOW_LOOPBACK` alone still denies `[::1]`, `::` and `0.0.0.0` because
they are also private. A multi-address hostname is decided per address, and every address must be
allowed.

**Tests:** all existing suites pass unchanged; the set classifier has its own table.

### Phase 2: the differential oracle (before Cedar exists)

A property-based harness generates the inputs below. It adds `fast-check` as a new dev-only
dependency; none exists today.
- **Addresses:** IPv4, IPv6, mapped, the edge literals, every class combination.
- **Hostnames:** these resolve to address sets through a fake resolver.
- **Approval rule lists and actions:** host, action, role, name, effect.
- **Option combinations:** loopback, CIDRs, `unknownRisk`, session tightening.

Its oracle is `LegacyAuthorizer`, and any `Authorizer` can be plugged in as the subject. The
harness is committed and green against `LegacyAuthorizer` itself (a tautology for now) before
phase 3 adds its real subject.

### Phase 3: Cedar schema, `CedarAuthorizer`, generator, baseline

**Schema** (`packages/protocol/src/policy/agentbrowser.cedarschema`), with TypeBox for the
document (`version`, `baseline`, `policies`, `approvalRules`, `limits`):
- **Entities:** `Tenant`; `Session in [Tenant]` (engine, cdpAttach, controlMode, headless); `Host`
  (domain).
- **Actions:**
  - egress: `request`, `request.loopback`, `request.private`;
  - acting: `act`, `act.unattended`;
  - capabilities: `cdp.attach`, `serviceWorkers`, `downloads`, `cookie.export`, `cookie.seed`,
    `session.headed`.
- **Context:** declared per action. `addressClasses` is a `Set<String>`; `effect`, `hostname`,
  `action`, `role` and `name` belong to the `act*` actions.
- **Generated from the schema:** docs and fixtures.

**`CedarAuthorizer`.** It applies every Cedar API trap rule from ADR-024 §2:
- **Validation:** valid only if `validate` reports `type: "success"` **and** `validationErrors` is
  empty; strict mode.
- **Request checking:** `preparseSchema` plus `validateRequest: true` on every call.
- **Fail closed:** any `diagnostics.errors`, any `type: "failure"`, or any thrown exception means
  deny with `engine.error`. A trap marks the authorizer unhealthy, `/health` reports it, and every
  policy-gated decision denies until restart.
- **Rule ids:** `ruleMatched` is the deciding ids, sorted. `@reason` and `@internal` come from an
  id → annotation map built at load with `policyToJson`.
- **Pre-parsed set ids:** namespaced by the policy version.
- **Reserved prefixes:** ids starting `floor.`, `default.`, `engine.` or `env.` are rejected.

**Generator and baseline.**
- `policyDocumentFromEnvironment()` writes a complete document from today's variables. It is also
  exposed as `agentbrowser-server policy export`, so operators migrate by generating, not by
  hand-writing.
- `agentbrowser:baseline/v1` is a versioned, built-in policy set equal to an unconfigured server.

**Tests:**
- **The differential oracle** (phase 2) passes with `CedarAuthorizer`, loaded with generated
  documents, as its subject. This is the equivalence gate, and it uses generated inputs, not only
  the existing test cases.
- **The erroring-forbid case** from review: a `permit` plus a `forbid` whose condition overflows
  must **deny** with `engine.error`, not allow.
- **Validation:** `validate` success-with-errors is rejected, and a mistyped request context is
  rejected.
- **Annotations and ids:** `@reason` and `@internal` are mapped; reserved prefixes are rejected.
- **Exception actions:** a plain `permit(principal, action == request, resource)` does **not**
  reach loopback or private addresses.

### Phase 4: the policy file, opt-in, with shadow mode and the performance gate

- **Loading.** `AGENTBROWSER_POLICY_FILE` loads, validates and canonicalizes the document; its
  version is the SHA-256, including the baseline version. Cedar is loaded **only** in this case.
- **Refusals at startup:**
  - an invalid document;
  - a file combined with any policy-bearing variable or embedder option (ADR-024 §4 table); all
    conflicts are named;
  - an unknown `limits` key;
  - tenant constraints other than `local` while no API keys are configured.
- **No-keys tenant.** Policy evaluation uses the implicit `Tenant::"local"` whatever `tenantId`
  the caller sends.
- **Warnings at startup:**
  - any loaded policy can permit `request.loopback` or `request.private` (detected by partial
    evaluation with an unknown principal);
  - no public-egress permit exists (`"baseline": "none"` without one);
  - deprecated variables are in use.
- **Session stamping.** The session view carries the policy version.
- **Shadow mode.** `AGENTBROWSER_POLICY_SHADOW=1`, without a file, evaluates the generated
  document in Cedar alongside `LegacyAuthorizer`. Legacy decides, and divergences are logged at
  `warn` with both rule ids. It runs for at least one release before deprecation warnings start.
- **Per-session memo.** It is an LRU with a fixed entry bound (TD-BROWSER-9), keyed by
  (action, host, sorted class set, declared context). Address classes come from the fresh
  per-request classification, so a DNS change alters the key. It is cleared at close.
- **Performance gate**, in this phase, before anyone opts in: a 300-subresource page, measured
  uncached and memoized. The gate (the maximum share of load time spent in policy evaluation) is
  set from the first measured run and recorded here. Review reproduced 43–78 µs per pre-parsed
  decision.
- **Tests:**
  - per-tenant loopback with keys: tenant A reaches the fixture, tenant B is denied with
    `default.deny`;
  - with no keys, a `tenantId: "qa"` request cannot obtain `qa`'s grants;
  - deny-wins against session narrowing and engagement scope;
  - a capability needs both the session request and the Cedar grant;
  - the memo key changes with the class set;
  - the version is stable across key order and whitespace.

### Phase 5: query surface

- **`GET /v1/policy`:**
  - It returns the version, the limits and a capability summary for a **default session** of the
    caller's tenant, and says that it does.
  - Attribute-dependent answers come back as `conditional`, through partial evaluation.
  - There is no raw policy text.
- **`POST /v1/policy/check`:** `{ action, url?, context? }` → `PolicyDecision`.
  - No DNS. An IP literal is classified; a hostname is evaluated with unknown address classes
    through partial evaluation, and reports "depends on resolved address" together with the
    deciding classes.
  - Request size is bounded.
- **Rate limiter:** a new bounded per-tenant token-bucket limiter for the query routes. No HTTP
  rate limiter exists today.
- **Errors:** `POLICY_DENIED` and `APPROVAL_REQUIRED` populate `policyDecision`. `@internal` policies
  are reported as `operator.policy`, without a reason.
- **Surfaces:** SDK `client.policy.get()` and `client.policy.check()`; the CLI's `agentbrowser
  policy [check …]`; a read-only MCP `policy` tool in every mode.
- **Tests:**
  - tenant isolation of every answer;
  - a resolver spy proves `check` never resolves;
  - `check` agrees with enforcement on IP literals and on every oracle row;
  - `@internal` ids are not disclosed;
  - the limiter is bounded;
  - the MCP tool is present in all modes, with the same shape as REST.

### Phase 6: packaging

- **Prune the npm package:** only `nodejs/` ships in the server tarball and the Windows bundle; the
  web and ESM builds are removed.
- **Shipped-path gate:** it **fails** on cedar-wasm as published. The `.wasm` embeds Rust
  panic-location paths from the CI machine that built it (`/home/runner/work/cedar/…`,
  `/home/runner/.cargo/registry/…`).
  - Add a file-scoped exception for exactly `@cedar-policy/cedar-wasm/nodejs/cedar_wasm_bg.wasm`
    at the pinned version, guarded by its SHA-256, following the precedent of the bundled Node
    runtime.
  - Any other file, version or hash still fails.
- **Install-size gates** gain the measured delta, about 4.3 MB.
- **Windows bundle smoke:** load a policy file and evaluate one decision.

### Phase 7: documentation

- **Policy guide** (`docs/policy.md`):
  - the generated schema reference;
  - the baseline;
  - set-valued address classes and the exception actions;
  - examples replacing each deprecated variable, and `policy export`;
  - the per-tenant pattern and its keys-only rule;
  - `policy check`;
  - the floor's fixed rules, including the statement that browser traffic is not DNS-pinned.
- **`docs/operations.md`:**
  - every variable classified as policy-bearing, floor input, bootstrap or trusted (ADR-024 §4);
  - `CHROMIUM_ARGS` documented as security-relevant.
- **Threat model:**
  - the policy file is trusted operator configuration;
  - only authenticated tenants are policy principals;
  - `check` is not a DNS oracle;
  - `@internal` exists for confidentiality.
- **ADR-024 status → Accepted** when phase 5 ships.

## Non-goals

- Reloading policy without restart (a reload must never relax a live session).
- Policy over page content; Cedar in the CLI or MCP executables.
- Replacing session narrowing or engagement scope.
- Making the floor configurable; DNS pinning for browser traffic.

## Risks

- **Equivalence drift.** The differential oracle (generated inputs) plus a release of shadow mode
  run before deprecation.
- **Fail-open engine semantics.** The erroring-forbid test and the fail-closed rule.
- **Over-broad operator permits.** Exception actions, startup warnings, the floor, and
  `GET /v1/policy` showing effective grants.
- **Hot-path cost.** A pre-parsed policy set, the bounded memo, and the phase-4 gate before opt-in.
- **A WebAssembly trap.** The authorizer is marked unhealthy and fails closed until restart, and
  `/health` reports it.
