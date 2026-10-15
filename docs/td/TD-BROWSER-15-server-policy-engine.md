# TD-BROWSER-15: Server policy engine (embedded Cedar)

**Status:** Delivered — phases 0–7 shipped as #444–#458; ADR-024 Accepted.
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

**Delivered:**
- **#444:** the classifier;
- **#445:** `MetadataFloorPolicy` wraps every session chain;
- **#446:** floor rule ids on every unconditional refusal (`floor.cdp.*`,
  `floor.delegated.operator`) and metadata-name normalisation.

**Floor module (delivered with phase 1).** `packages/api/src/floor.ts` holds:
- the CDP-attach admission and its refusals;
- the attach-options refusal;
- the delegated-session and operator-route refusals;
- the metadata wrap.

The engine-level duplicates stay in engine-playwright as a second line of defence, and the
metadata classifier stays in `@agentbrowser/policy`.

**Wider metadata set.** The metadata set gains:
- `fd00:ec2::/64` (AWS: IMDS at `::254`, EKS Pod Identity at `::23`);
- `100.100.100.200` (Alibaba Cloud);
- `168.63.129.16` (Azure wire server);
- both link-local ranges, `169.254.0.0/16` and `fe80::/10`.

**Embedded IPv4 is decoded, as a union that only adds classes.** It covers IPv4-mapped
(`::ffff:0:0/96`), NAT64 (`64:ff9b::/96`, `64:ff9b:1::/48`), 6to4 (`2002::/16`) and IPv4-compatible
(`::/96` **excluding `::/127`**).
- An address's classes are its own plus those of the embedded IPv4.
- `public` is dropped when any other class is present.
- **Examples:** `64:ff9b::a9fe:a9fe` → {private, metadata}; `64:ff9b::7f00:1` → {loopback}; `::1` stays
  {loopback, private}.
- Operator-chosen network-specific NAT64 prefixes are a known limit.
- **Tests:** `::1` and `::` keep loopback under every option combination, including
  `ALLOWED_CIDRS=::/0`, as `private-cidr.test.ts` asserts today. A private grant never reaches
  `::1`.

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

**Progress:** phase 1 is delivered: approvals, egress exceptions, capability grants and the floor
module.
- **Capabilities:** session creation asks the service's injectable `authorizer` for `cdp.attach`,
  `downloads`, `serviceWorkers`, `cookie.seed` and `session.headed`, for each one the session will
  have.
  - The checks run after the shutdown check and engine resolution.
  - Headed includes an always-headed engine (Safari) unless headless is demanded.
  - Cookie export asks for `cookie.export` after resolving the session.
  - `LegacyAuthorizer` grants all of them (`env.capability.default`).
- **Egress:** `NetworkPolicy` asks an `EgressExceptions` hook, and the API answers it through
  `LegacyAuthorizer`'s `request.loopback` and `request.private` (`env.allow-loopback`,
  `env.block-loopback`, `env.allowed-cidrs`, `env.block-private`).
- **Approvals:** `@agentbrowser/policy-engine` holds `Authorizer`,
`LegacyAuthorizer` and `approvalModeOf`; core's `ActionRiskPolicy.classify()` is split from the
outcome, and rules gain an optional `id`. Egress exceptions and capability grants follow, along
with the single floor module deferred from phase 0.

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

**Delivered:** `packages/policy-engine/src/differential.harness.ts`, a test-only module excluded from
the build by `tsconfig.build.json`.
- `assertEquivalentToLegacy(subjectFor)` checks any `Authorizer` built from a generated
  `LegacyConfig` against `LegacyAuthorizer`, comparing `allowed` and `ruleMatched`.
- Egress contexts come from the real `NetworkPolicy` path, and approval contexts from
  `ActionRiskPolicy.classify()`.
- It holds for `LegacyAuthorizer` itself.
- A table of every effect × rule decision × `unknownRisk` runs on every call, deterministically.
- Generated inputs include:
  - first, last and one-past addresses of every configured CIDR;
  - local-use NAT64 addresses with several private sources;
  - explicit rule ids;
  - absent and varied tenants.
- A deterministic egress table runs on every call. It covers CIDR sets that cover some private
  sources of an address but not all, loopback-and-private addresses, and every IPv4 boundary in
  mapped, NAT64 and 6to4 form, as hostname and as resolved address.
- Generated explicit rule ids carry no position.
- 27 plausible-but-wrong subjects from three review rounds must each be caught on every seed, and a
  correct subject that resolves rules by id from its configuration must pass
  (`differential-mutants.test.ts`).

**Prerequisites this sets for phase 3:**
- **Private sources, not one address.** A `request.private` context can carry **several private
  sources**: the wrapper and each embedded IPv4. An exception must cover every one. The pinned
  wasm has no set quantifiers, so the schema carries one optional `ip` and the ask happens once
  per source, conjoined by the authorizer — every source in range, still. The mutant suite catches
  `some`, first-only and wrapper-only variants.
- **A wider act context.** Once Cedar matches on the act context, it needs the `hostname`, `action`,
  `role` and `name` the TD lists, and the generators must widen with it: uppercase hosts, IPv6 and
  invalid URLs. Today first-match and hostname case are decided by `ActionRiskPolicy`, outside the
  subject.

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

Phase 3 splits in two, so releases stay green between them. `api` depends on `policy-engine`, so
a runtime `@cedar-policy/cedar-wasm` dependency would ship in the server tarball and Windows
bundle from the moment it lands — and its `.wasm` embeds builder-machine paths that the
shipped-path gate rejects (phase 6). So:

- **3a (no runtime dependency):** the schema, the policy document, the generator, and tests.
  `cedar-wasm` 4.13 is a **dev** dependency of `policy-engine` only — dev dependencies never
  enter the `pnpm deploy --prod` trees the tarball, image and bundle are built from, so no gate
  sees it.
- **3b:** `CedarAuthorizer` behind the opt-in, the differential oracle as its gate, the
  `rulesMatched` population, trap/health wiring, and the phase-6 packaging pieces (nodejs-only
  ship, the hash-pinned wasm exception, size gates) in the same PR.

**Verified against the pinned wasm (4.13), shaping the design:**
- `isInRange` never matches across families, and `ip()` rejects IPv4-mapped literals
  (`::ffff:a.b.c.d`) but accepts NAT64 wrappers (`64:ff9b::a01:203`). Mapped-space sources are
  normalized to IPv4 before a request is built.
- Node's `BlockList` — what enforcement does today — checks an IPv4 address as its `::ffff:`
  form against IPv6 rules: pure prefix math, no un-mapping of rule addresses. So mapped-space
  operator CIDRs expand to their IPv4 equivalents (`::ffff:0:0/96` → `0.0.0.0/0`,
  `::ffff:10.0.0.0/104` → `10.0.0.0/8`), and a prefix up to 96 grants either all of IPv4 or
  nothing. A property test referees the expansion against `BlockList` itself.
- The wasm grammar has no set quantifiers (`.all`/`.any` do not parse) — hence per-source asks.
- The policy scope takes one constraint per variable: `action in [...]`, never `== … || == …`.
- Empty set literals are forbidden; the default branches' exclusion clause is omitted when no
  rule carries a decision.
- Denials report the ids of forbidding policies, so each deny branch is an explicit `forbid`
  carrying its `env.*` id, and a `required` outcome is a permit/forbid pair.

**Review of 3a (all claims held; the reviewer ran 100k+ equivalence checks) hardened two edges:**
- The generator validates its rules with the validator `ActionRiskPolicy` itself uses (now shared,
  `validateActionRiskRules` in core). Rule ids are interpolated into Cedar text; an id the system
  would reject at startup must fail at the generator too, not become a set that parses loudly but
  wrongly (duplicate decided ids diverge; reserved ids suppress the defaults).
- `normalizeSourceForCedar` refuses a family-mismatched (address, type) pair, which `BlockList`
  answers false for; the Cedar side must not grant it.

**Schema** (`packages/protocol/src/policy-document.ts`, exported as `CEDAR_SCHEMA`), with TypeBox
for the document (`version`, `baseline`, `policies`, `approvalRules`, `unknownRisk`; `limits`
arrives with phase 4):
- **Entities:** `Tenant`; `Session in [Tenant]` (engine, cdpAttach, controlMode, headless); `Host`
  (domain).
- **Actions:**
  - egress: `request`, `request.loopback`, `request.private`;
  - acting: `act`, `act.unattended`;
  - capabilities: `cdp.attach`, `serviceWorkers`, `downloads`, `cookie.export`, `cookie.seed`,
    `session.headed`.
- **Context:** declared per action.
  - The `request*` actions carry `phase`, `target` and `addressClasses` (`Set<String>`);
    `request.private` adds an **optional** `ip` (`ip?: ipaddr`): one normalized source address,
    never a prefix, asked once per private source. Generated policies test it as
    `context has ip && context.ip.isInRange(…)`.
  - The `act*` actions carry `effect` and `matchedRule` (the first matching approval rule's
    optional `id`, otherwise `rule-<index>`, or `"none"`), plus optional `hostname`, `action`,
    `role` and `name` for operator-written policies.
- **Protocol first (ADR-015):** `PolicyDecisionSchema` gains `rulesMatched: string[]`. The existing
  `ruleMatched` keeps the first id.
- **Generated from the schema:** docs and fixtures.

**`CedarAuthorizer` (3b, shipped).** It applies every Cedar API trap rule from ADR-024 §2:
- **Validation:** valid only if `validate` reports `type: "success"` **and** `validationErrors` is
  empty; strict mode.
- **Request checking:** `preparseSchema` plus `validateRequest: true` on every call.
- **Fail closed:** any `diagnostics.errors`, any `type: "failure"`, or any thrown exception means
  deny with `engine.error`. A trap marks the authorizer unhealthy, `/health` reports it, and every
  policy-gated decision denies until restart.
- **Rule ids:** `rulesMatched` is all deciding ids, sorted; `ruleMatched` is the first. `@reason` and `@internal` come from an
  id → annotation map built at load with `policyToJson`.
- **Pre-parsed set ids:** namespaced by the policy version.
- **Reserved prefixes:** ids starting `floor.`, `default.`, `engine.` or `env.` are rejected.

**Generator and baseline.**
- `policyDocumentFromLegacyConfig()` (3a, shipped) writes a complete document from a
  configuration, deterministic in text: loopback as one permit or forbid; `request.private` as a
  permit over the **expanded** ranges plus a paired `unless` forbid (an unconditional forbid with
  no CIDRs); one branch per rule `decision` keyed on `context.matchedRule` (allow covers both
  asks, required splits them into a permit/forbid pair, deny forbids both); the three default
  branches (`unknown-risk`, `high-risk`, `default`) gated on "the matched rule has no decision of
  its own"; and one capability permit. Every policy carries its `env.*` id as a `@rule`
  annotation; keys are `<ruleId>#<n>` so pairs share an id.
- `policyDocumentFromEnvironment()` and `agentbrowser-server policy export` arrive with 3b's
  wiring, so operators migrate by generating, not hand-writing.
- `agentbrowser:baseline/v1` is a versioned, built-in policy **template** equal to an unconfigured
  server. `unknownRisk` is its only parameter.

**3b, delivered:** `CedarAuthorizer` passes the phase-2 differential oracle on generated
configurations (two seeds × 300 runs, plus the deterministic tables), loads documents strictly
(strict `validate` with zero validation errors; `@rule` annotations cross-checked against the
document's own `ruleId`; `floor.`/`default.`/`engine.` ids refused; `env.` requires a baseline),
fails closed and sticky on traps (`engine.error` until restart), fills `rulesMatched`, and asks
`request.private` once per normalized source. `policyDocumentFromEnvironment()` +
`agentbrowser-server policy export` migrate operators by generating. The runtime wasm dependency
ships with the phase-6 packaging pieces in the same PR: the pruner keeps only the Node build and
enforces the version+hash pin (`scripts/cedar-wasm.json`), the shipped-path gate accepts exactly
that one pinned file, the size gates gain the measured delta, the Docker image prunes inline, and
the Windows bundle smoke loads a document and decides one request. One finding from building it,
now recorded here: **strict validation statically flags any policy that would error for a declared
request shape** — a mapped-form `ip()` literal and a missing optional attribute both refuse at
load — so the TD's "erroring forbid" case is enforced at load; the reachable trap surfaces are
request rejection and refused sources, both fail-closed and sticky.

Review of 3b (all claims held: the oracle at fresh seeds and 1000 runs, the packaging gates, a
real pruned deploy) hardened three edges, all fixed:
- `policyDocumentFromEnvironment` now refuses approval values the server refuses at startup
  (non-object JSON, non-array rules) instead of emitting a document for an unbootable
  configuration.
- Deny reasons carry only forbidding policies, so every deciding id is reported — the
  `env.capability.*` filter could erase a real deciding id from a hand-written document.
- `rulesMatched` lists each deciding id once (paired policies share a rule id).

Two scope notes for phase 4: the oracle's equivalence is over contexts the real seam can emit
(`ActionRiskPolicy.classify` only produces configured ids and decisions; a hand-built context
carrying an out-of-config `matchedRule` or a disagreeing `context.rule.decision` diverges, which
is inherent to keying Cedar on the matched id). And Cedar decisions carry their own reason
strings ("permitted by policy"), so phase 4 changes operator-visible reason text from today's;
`ruleMatched` is the stable field.

**Tests (3a, shipped):**
- The generated set **validates in strict mode with zero errors** against `CEDAR_SCHEMA`, for
  representative configurations.
- A fixed decision matrix — egress (per-source asks), every approval branch, capabilities —
  matches `LegacyAuthorizer` exactly under the real wasm build, `allowed` and `ruleMatched` both.
- `expandRangesForCedar` is refereed by Node's `BlockList` in a property test (3000 single-rule
  runs, 1500 unions, and the verified cross-family matrix), covering prefixes the oracle's fixed
  CIDR list never reaches.
- **The differential oracle** (phase 2) passes with `CedarAuthorizer`, loaded with generated
  documents, as its subject — in 3b. This is the equivalence gate, and it uses generated inputs,
  not only the existing test cases.
- **The erroring-forbid case** from review: a `permit` plus a `forbid` whose condition overflows
  must **deny** with `engine.error`, not allow.
- **Validation:** `validate` success-with-errors is rejected, and a mistyped request context is
  rejected.
- **Annotations and ids:** `@reason` and `@internal` are mapped; reserved prefixes are rejected.
- **Exception actions:** a plain `permit(principal, action == request, resource)` does **not**
  reach loopback or private addresses.

### Phase 4: the policy file, opt-in, with shadow mode and the performance gate

**Delivered (phase 4a, the opt-in):** `PolicyLimits` in the document (`extractMaxBytes`,
`maxResponseBytes`; unknown keys refuse); `loadPolicyFile` with every startup refusal —
policy-bearing variables combined with a file (all conflicts named, `MAX_RESPONSE_BYTES`
included), unparsable files, non-`local` tenant literals while no keys are configured (found by
walking `policyToJson`'s ASTs, scopes and conditions), a key tenant named `local`, and everything
the authorizer refuses at load. The stock entrypoint stops deriving `networkPolicy` and
`extractMaxBytes` from the environment when a file is set; `startServer` refuses embedder options
combined with a file, naming them; `Tenant::"local"` is the implicit principal parent for unbound
decisions; each session's network policy is the floor plus the tenant-bound, per-session-memoized
(LRU 512, TD-BROWSER-9) authorizer exceptions, cleared at close; sessions stamp the policy
version; `/health` exposes `authorizerHealthy` as a boolean only; `AGENTBROWSER_POLICY_SHADOW=1`
runs `ShadowAuthorizer` (legacy decides, divergences warn with both rule ids, shadow traps never
touch legacy health); deprecated variables warn when used without a file. Review round 2 hardened shadow parity: shadow sessions keep exactly the
environment's `AGENTBROWSER_MAX_RESPONSE_BYTES` (the per-session factory reads it for shadows, a
file's `limits.maxResponseBytes` for files — `sessionPolicyFactoryFor`, exported and tested), the
shadow's deciding side honors the approval policy's `unknownRisk`
(`unknownRiskFromEnvironment`), and `startServer` also refuses a file combined with
policy-bearing environment variables for direct embedders, not only through the stock entrypoint.

Two recorded deviations:
the loopback/private startup warning uses the action scope rather than partial evaluation —
strictly more conservative for a warning; and the per-source private ask means a Cedar memo entry
exists per source set, covered by the bound. **Phase 4b, delivered with the opt-in: the
300-subresource performance gate, uncached/memoized/shadow, with the number recorded below.**

**Delivered (4b):** `packages/benchmarks/src/policy-gate.ts`. A worst-case page — 300 subresource
requests, every one to a private address (so each asks `request.private`), 30 hosts × 10 requests —
measured through the service's own chain (floor blocks + tenant-bound, memoized authorizer
exceptions). **First measured run (2026-10-13):** uncached 68.7 ms total / p50 193 µs per
decision (6.9% of the 1.0 s reference page load); memoized 9.6 ms / p50 2.9 µs (0.96%); shadow
49.9 ms / p50 153 µs (5.0%). **The gate is 25%** of the reference load, applied to the modes
production runs — memoized (always) and shadow (opt-in); the uncached figure is the measurement
floor, reported and never gated, because the service never runs without the per-session memo.
The first CI run measured shared runners at roughly 2–3× the local numbers, which the ceiling
absorbs; the gate exists to catch order-of-magnitude regressions, not constant factors.

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
  - the version is stable across key order and whitespace;
  - the baseline contains no `forbid` on `act` or `act.unattended`, so an operator rule
    `decision: "allow"` can relax a high-risk effect, as today;
  - granting `serviceWorkers` produces the egress-exception startup warning.

### Phase 5: query surface

**Delivered:** `GET /v1/policy` (version, limits, the capability summary for a default session of
the caller's tenant — the response says so — and, without a file, the note that answers are
unconditional); `POST /v1/policy/check` answering through `policyCheck` — one engine, any
authorizer, so the no-file route answers through `LegacyAuthorizer` by the same enumeration.
Check semantics: an IP literal is classified by the real classifier and answered exactly as
enforcement would (a committed test agrees with `NetworkPolicy` on every literal, against both
authorizers); a hostname passes the name-level rules (metadata names floor-denied, loopback names
answered at the name level) and then enumerates the class sets, the non-public sets answering
`depends-on-resolution`; no DNS — a resolver spy proves it. A caller cannot smuggle a tenant.
A new bounded per-tenant token bucket (30/minute, 4096 tenants, lazy refill) rate-limits both
routes. `@internal` policies report as `operator.policy` with no reason. OpenAPI regenerated.
Surfaces: SDK `client.policy()`/`client.policyCheck()`, CLI `agentbrowser policy` and
`policy-check`, and a read-only `policy` MCP tool in every browser mode (the application plane
keeps its deliberately minimal contract, so the tool is fenced out of it like every other
browser tool). ADR-024 → Accepted.

Review of phase 5 hardened the parity and closed the gaps: check's literal asks now mirror
enforcement exactly (phase `hostname`, the full computed class set, every source at once —
policies conditioning on `phase` or `addressClasses` are committed regression tests);
IP-literal-shaped targets that enforcement refuses (ports, leading zeroes, zone indices,
trailing junk) and prefix-length targets answer `floor.invalid-ip`; `RATE_LIMITED` joined the
protocol error enum so the 429 body matches the published ApiError envelope; keyed per-tenant
answers are tested through the real route in both directions (a claimed body tenant changes
nothing); `@internal` redaction is tested through both routes. Recorded deviations from the
phase-5 bullets: `conditional` partial-evaluation answers are NOT implemented (attribute-
dependent capability answers come back as plain decisions for the default session; the honest
enumeration lives in `check`), the capability summary does not list `session.delegated` as
floor-only, and no-keys deployments share one 30/minute bucket for the whole query surface —
keyed deployments are per tenant.

- **`GET /v1/policy`:**
  - It returns the version, the limits and a capability summary for a **default session** of the
    caller's tenant, and says that it does.
  - Attribute-dependent answers come back as `conditional`, through partial evaluation. That
    evaluation runs schema-less, because cedar-wasm 4.13 rejects unknowns in a validated context;
    every policy was already strictly validated at load. It is only available when Cedar is
    loaded.
  - There is no raw policy text.
- **`POST /v1/policy/check`:** `{ action, url?, context? }` → `PolicyDecision`.
  - No DNS. An IP literal is classified; a caller-supplied `ip` with a prefix length is refused.
  - A hostname first passes the name-level rules (`localhost`, `metadata.google.internal`). It
    then gets one validated decision per class set the classifier can produce (`{public}`,
    `{loopback}`, `{private}`, `{loopback, private}`, generated from the classifier's table).
  - Actions whose policies reference `context.ip` answer `depends on resolved address`, never
    `denied`. There is no partial evaluation.
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

### Phase 8 (Proposed, awaiting ADR-026): reload without restart

Not scheduled; implement only after [ADR-026](../adr/026-policy-reload-without-restart.md) is
accepted.

- **Trigger and credential:** `POST /v1/admin/policy/reload`, enabled only when
  `AGENTBROWSER_POLICY_ADMIN_KEY_FILE` is configured, accepting only that server-scope admin key
  (distinct from API and operator keys; overlap aborts startup; the key file without a policy file
  aborts startup). No signal (`SIGHUP` stays shutdown); no file watcher. Optional CLI wrapper.
- **Swap:** startup-grade validation into a new authorizer; on any error keep the running one and
  report. Serialized. Document identity = SHA-256 over the whole document including `limits`; an
  unchanged identity is a no-op.
- **Per-session state (new):** each session stores its pinned document and its chain (every
  document loaded since, deduplicated). A composite `Authorizer` allows only if every document in
  the chain allows; approval modes follow from the same two questions. Never collapse the chain
  to "pinned AND current".
- **Ordering:** session creation snapshots the current document, decides creation-time grants
  against it, and registers in the live set under the lock the reload holds while swapping and
  extending chains.
- **Limits:** per-session effective limits = minimum over the chain of each document's
  default-resolved value; `maxResponseBytes` becomes a live per-session value and
  `extractMaxBytes` per-session.
- **Cache:** `MemoizedAuthorizer` keys on the chain identity (or clears on chain growth).
- **Approvals:** `act` and `cookie.handoff` tokens bind to the chain identity at mint and are
  refused on use after the chain grows.
- **Not reached (reported, not enforced):** creation-time grants (`cdp.attach`, `downloads`,
  `serviceWorkers`, `cookie.seed`, `session.headed`) — the reload response counts live sessions
  holding a grant the new document would deny; established connections continue.
- **Surfaces:** session views keep `policyVersion` as the pinned version and add `policyChain`
  (document identities; additive schema/OpenAPI change); `GET /v1/policy` reports the current
  `policyVersion` and document identity; logs carry the previous and new identities.
- **Tests first:** a tightening reload denies an in-flight session's next request; a request
  allowed and cached before the reload is denied after it; a loosening reload does not reach a
  live session but does reach a new one; A → B → C where B blocks and C does not leaves a session
  pinned at A blocked; A → B → A keeps B for live sessions; a limits-only change is not a no-op
  and lowers a live session's limit; an invalid file is refused and the old policy keeps
  deciding; `act` and handoff tokens minted before a reload are refused after it; a key in two
  roles aborts startup; an API or operator key cannot reload; the creation-time-grant count is
  reported; without the admin key file the endpoint does not exist; the admin key file without a
  policy file aborts startup; a session created concurrently with a tightening reload is either
  pinned at the new document or carries it in its chain; a document that omits a limit after one
  that set it higher lowers the live limit to the default.

## Non-goals

- Reloading policy without restart in phases 0–7 (proposed as phase 8 under ADR-026; a reload must
  never relax a live session).
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
