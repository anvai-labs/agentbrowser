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

**Wider metadata set.** The metadata set gains:
- `fd00:ec2::/64` (AWS: IMDS at `::254`, EKS Pod Identity at `::23`);
- `100.100.100.200` (Alibaba Cloud);
- `168.63.129.16` (Azure wire server);
- both link-local ranges, `169.254.0.0/16` and `fe80::/10`.

**Embedded IPv4 is decoded before classification:** IPv4-mapped (`::ffff:0:0/96`), NAT64
(`64:ff9b::/96`, `64:ff9b:1::/48`) and 6to4 (`2002::/16`). For example, `64:ff9b::a9fe:a9fe` is
metadata and `64:ff9b::7f00:1` is loopback.

**A floor module the service always applies.** The metadata and CDP-attach checks move out of the
injectable `NetworkPolicy`, whose metadata block is off when constructed with `{}`, into a module
the service applies whatever `ServerOptions.networkPolicy` it receives.

- **Tests:**
  - each address and range, in IPv4-mapped, NAT64, 6to4, decimal, octal and hex forms, is refused
    under every option combination;
  - this includes `AGENTBROWSER_ALLOWED_CIDRS=fd00::/8`, which reaches `fd00:ec2::254` today;
  - it also includes an embedder-injected `new NetworkPolicy({})`.
- **Release notes:** call this out as a tightening. Link-local devices reached through
  `ALLOWED_CIDRS` become unreachable.

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
example `::1` → `{loopback, private}`. It also returns the **normalized address**, with
IPv4-mapped IPv6 rewritten to IPv4, which the CIDR exceptions and the context's `ip` use. `LegacyAuthorizer` reproduces today's decisions exactly,
including the quirk where `ALLOW_LOOPBACK` alone still denies `[::1]`, `::` and `0.0.0.0` because
they are also private. A multi-address hostname is decided per address, and every address must be
allowed.

**Tests:** all existing suites pass unchanged; the set classifier has its own table.

### Phase 2: the differential oracle (before Cedar exists)

A property-based harness generates the inputs below. It adds `fast-check` as a new dev-only
dependency; none exists today.
- **Addresses:** IPv4, IPv6, mapped, the edge literals, every class combination.
- **Hostnames:** these resolve to address sets through a fake resolver.
- **Approval rule lists and actions:** host, action, role, name, effect, and the optional per-rule
  `decision`, combined with every `unknownRisk`.
- **CIDR exception lists:** including addresses in IPv4-mapped form, which must match their IPv4
  CIDR exactly as `BlockList` does today.
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
- **Context:** declared per action.
  - The `request*` actions carry `addressClasses` (a `Set<String>`) and `ip` (an `ipaddr`, already
    normalized).
  - The `act*` actions carry `effect`, `matchedRule` (the id of the first matching approval rule, or
    `"none"`), `hostname`, `action`, `role` and `name`.
- **Protocol first (ADR-015):** `PolicyDecisionSchema` gains `rulesMatched: string[]`. The existing
  `ruleMatched` keeps the first id.
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
- `policyDocumentFromEnvironment()` writes a complete document from today's variables:
  - one `request.private` permit per `ALLOWED_CIDRS` entry, using `context.ip.isInRange`;
  - the approval rules and `unknownRisk` copied as they are;
  - one generated policy per rule `decision`, keyed on `context.matchedRule`.

  It is also exposed as `agentbrowser-server policy export`, so operators migrate by generating,
  not by hand-writing.
- `agentbrowser:baseline/v1` is a versioned, built-in policy **template** equal to an unconfigured
  server. `unknownRisk` is its only parameter.

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
  - while no API keys are configured, any `Tenant` literal other than `local` anywhere in a policy,
    conditions included, found by walking `policyToJson`;
  - a key tenant named `local` (the name is reserved).
- **Stock entrypoint:** `main.ts` stops passing `networkPolicy` and `extractMaxBytes` when a policy
  file is set, so the conflict rule fires only on genuine double configuration.
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
  - A trap in the shadow authorizer marks only the shadow unhealthy, never the legacy decisions.
  - `/health` exposes the authorizer's health as a boolean only.
- **Per-session memo.** It is an LRU with a fixed entry bound (TD-BROWSER-9), keyed by
  (action, host, normalized address, sorted class set, declared context). Address classes come from the fresh
  per-request classification, so a DNS change alters the key. It is cleared at close.
- **Performance gate**, in this phase, before anyone opts in: a 300-subresource page, measured
  uncached, memoized, and in shadow mode, which doubles evaluation. The gate (the maximum share of
  load time spent in policy evaluation) is set from the first measured run and recorded here. Review reproduced 43–78 µs per pre-parsed
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
  - Attribute-dependent answers come back as `conditional`, through partial evaluation. That
    evaluation runs schema-less, because cedar-wasm 4.13 rejects unknowns in a validated context;
    every policy was already strictly validated at load. It is only available when Cedar is
    loaded.
  - There is no raw policy text.
- **`POST /v1/policy/check`:** `{ action, url?, context? }` → `PolicyDecision`.
  - No DNS. An IP literal is classified. A hostname gets one normal, validated decision per
    possible address-class combination (`public`, `loopback`, `private`, and their unions), and
    reports `depends on resolved address` together with the deciding combinations. There is no
    partial evaluation.
  - **Without a policy file**, both routes answer through `LegacyAuthorizer` by the same
    enumeration, and the summary reports `unconditional for a default session`.
  - Request size is bounded.
- **Rate limiter:** a new bounded per-tenant token-bucket limiter for the query routes. No HTTP
  rate limiter exists today.
- **Errors:** `POLICY_DENIED` and `APPROVAL_REQUIRED` populate `policyDecision`, including
  `rulesMatched`. `@internal` policies are reported as `operator.policy`, without a reason.
- **Names:** the capability summary uses the action names (`cdp.attach`, `session.headed`, …).
  `session.delegated` is listed as floor-only.
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
