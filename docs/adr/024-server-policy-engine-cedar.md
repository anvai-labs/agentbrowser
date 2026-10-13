# ADR-024: Server Policy Engine — Embedded Cedar, Queryable by Agents

**Status:** Proposed (2026-10-13)
**Related:** [ADR-006](006-network-egress-policy-ssrf.md) (egress policy and SSRF defense),
[ADR-007](007-approval-tokens-side-effects.md) (approval tokens),
[ADR-008](008-process-container-isolation.md) (isolation),
[ADR-015](015-cross-package-contract-single-source-of-truth.md) (single source of truth),
[operator CDP attachment](../spec/design/operator-cdp-attach.md),
[TD-BROWSER-15](../td/TD-BROWSER-15-server-policy-engine.md) (implementation plan)

## Context

What the server allows is decided today by policy scattered across environment variables, a JSON
blob, embedder options and code:

- **Egress exceptions:** `AGENTBROWSER_ALLOW_LOOPBACK` and `AGENTBROWSER_ALLOWED_CIDRS` relax the
  default loopback and private-address blocks (`createDefaultNetworkPolicy` turns on loopback,
  private and metadata blocking) for **every** session on the server.
- **Approvals:** `AGENTBROWSER_APPROVAL_POLICY` (or `ServerOptions.approvalPolicy`) configures
  `ActionRiskPolicy` (`packages/core/src/action-risk-policy.ts`).
  - Its rules match exactly on hostname, action, role and name, and the first match wins.
  - Each rule **classifies** the action's effect (`read`, `write-local`, `transaction`, …), and the
    effect then determines a three-valued outcome: `allow`, `required` (an approval token is
    needed) or `deny`.
  - `unknownRisk` sets the outcome for unclassified actions.
- **Capability gates:** `AGENTBROWSER_HOSTED`, the CDP-attach endpoint and its acknowledgement, and
  per-session grants such as `allowServiceWorkers` and `allowDownloads`.
- **Limits:** response, extraction and inline-artifact sizes, and default TTLs, each its own
  variable.

Three problems follow:

1. **Policy is per process, not per tenant.** `AGENTBROWSER_ALLOW_LOOPBACK=1` for one tenant's test
   fixture opens loopback, including the AgentBrowser API itself, for every tenant.
2. **Agents cannot ask what is allowed.** They learn it from `POLICY_DENIED` or
   `APPROVAL_REQUIRED` after planning and acting. `PolicyDecisionSchema.ruleMatched` exists, but
   nothing fills it.
3. **Every new gate is another bespoke variable** with its own parser, validation and docs.

## Decision

### 1. Three layers, and what each may do

**The floor** is fixed TypeScript that no policy can override. It holds everything ADR-006,
ADR-007 and the CDP-attach design guarantee unconditionally:

- **Metadata endpoints are always refused.** This ADR also **widens** the set, because today it
  covers only `169.254.169.254`, `metadata.google.internal` and `metadata.goog`. It adds the AWS
  IPv6 range `fd00:ec2::/64` (its instance metadata at `::254`, plus EKS Pod Identity credentials
  at `::23`), Alibaba Cloud (`100.100.100.200`), and the Azure wire server (`168.63.129.16`). It
  also adds the whole of both link-local ranges, `169.254.0.0/16` (ECS task metadata
  `169.254.170.2`, EKS Pod Identity `169.254.170.23`) and `fe80::/10`.
  - **Embedded IPv4 is decoded, and decoding only ever adds classes.** It covers IPv4-mapped
    (`::ffff:0:0/96`), NAT64 (`64:ff9b::/96`, `64:ff9b:1::/48`), 6to4 (`2002::/16`) and the
    deprecated IPv4-compatible form (`::/96`, **excluding `::/127`**, that is `::` and `::1`).
    - **Union:** an address's classes are its own IPv6 classes **plus** the classes of the IPv4 it
      embeds. `public` is dropped whenever another class is present, so "public" keeps meaning "no
      other class".
    - **Examples:** `64:ff9b::a9fe:a9fe` → {private, metadata}; `64:ff9b::7f00:1` → {loopback}. Today both
      classify as public. `::1` stays {loopback, private}.
    - **Why `::/127` is excluded:** decoded, `::1` would read as `0.0.0.1`, which is private only.
      A private grant would then reach IPv6 loopback, the AgentBrowser API included.
  - **Known limit:** operator-chosen network-specific NAT64 `/96` prefixes cannot be recognized.
  - **The trade-off:** link-local devices reached today through `ALLOWED_CIDRS` become unreachable.
    The release notes say so.
  - **Timing:** this lands before private ranges can be granted (TD phase 0).
- **The floor does not depend on what an embedder injects.** Today the metadata block lives inside
  the `NetworkPolicy` instance passed in as `ServerOptions.networkPolicy`, and
  `new NetworkPolicy({})` leaves it off. The floor checks (metadata and the CDP refusals) move into
  a module the service always applies, whatever policy object it was given.
  - **One dependency remains.** The floor checks DNS answers only when the injected policy has a
    DNS gate (`checkResolvedAddresses`). It never adds one, because the download path would then
    treat a weaker policy as strict. Every built-in policy has a DNS gate. An embedder's
    duck-typed policy without one gets name and address checks on requests, but no check on
    resolution.
  - **The CDP-attach lane checks names only.** It has no DNS gate, so the metadata name check
    normalises case and a trailing dot, and includes the short search-domain names `metadata` and
    `instance-data`. A name that merely *resolves* to a metadata address (for example
    `169.254.169.254.nip.io`) is not caught there; that lane is documented as navigation-only.
- **Loopback and private addresses are blocked by default.** Policy may grant only **exceptions**,
  through the dedicated actions `request.loopback` and `request.private` (§3). An ordinary
  `request` permit never reaches them, however broadly it is written.
- **Operator CDP attachment refusals:** hosted deployments, more than one authenticated tenant,
  missing bearer credentials, non-loopback listeners or peers, delegated sessions, and cookie
  export or seed on an attached profile. Policy may refuse attachment further; it can never
  permit any of these, and there is no exception. ADR-025's cookie handoff does not read from an
  attached profile. It reads from an operator-only login browser, which has no debugging port and
  its own floor.
- **Delegated (controlled) sessions** require an authenticated operator principal.
- **Approval-token mechanics:** single use, bound to page, revision, target fingerprint and
  parameters.
- **Enforcement of redirect, size and request caps** (their values are configuration, §4), and
  secret redaction.

**What the floor does not promise.** The egress choke point validates every request afresh, but
**browser traffic is not DNS-pinned**: the service resolves to classify, and Chromium resolves
again to connect (`engine-playwright`, `installEgress`). Only `ConnectionAuthority`, used for
downloads, pins a connection to the address it checked. This ADR does not change that, and nothing
below relies on pinning.

The floor's metadata, loopback and private checks run at the egress choke point, so they bind only
traffic that passes through it. Three existing lanes do not, as documented elsewhere:
- **Operator CDP attachment.** Only the initial explicit navigation is preflighted
  (operator-cdp-attach.md).
- **Service workers, in sessions granted them.** Their requests are not routed through the choke
  point (ADR-019).
- **Redirect hops of POST, PUT and PATCH requests.** These continue through `route.continue`, and
  their hops are not re-checked (ADR-006).

So "always refused" means "always refused at the choke point". Granting `serviceWorkers` is
therefore an **egress-containment exception**, not just a capability. The startup warning and
`GET /v1/policy` report it as one.

**Cedar** decides what an operator chooses, within the floor:
- which tenants may reach which destinations, including loopback and private exceptions;
- whether an action needs approval or is denied, given its classified effect (§5);
- capability grants: service workers, downloads, cookie export and seeding, headed sessions, CDP
  attachment (inside the floor's refusals), and later the cookie handoff that ADR-025 will propose.

**The session's own policy** (`SessionPolicySchema`) is what the caller asks for.
- **Most of it narrows:** allowed and blocked hosts, and engagement scope.
- **Two fields are requests for capabilities:** `allowServiceWorkers` and `allowDownloads`. Cedar
  decides whether the session's tenant may have them; the session cannot grant them to itself.

**Composition.** A request proceeds only if all three layers allow it. A capability is in effect
only if the session requests it **and** Cedar grants it.

### 2. Cedar, embedded as WebAssembly

The server evaluates policy in-process with the official
[`@cedar-policy/cedar-wasm`](https://www.npmjs.com/package/@cedar-policy/cedar-wasm) package
(Apache-2.0, maintained by the Cedar project). There is no sidecar and no network dependency. It
needs nothing beyond `WebAssembly`: no WASI and no threads. The Node build loads synchronously from
its own directory, which works in the server tarball and in the Windows bundle.

Measured against 4.13.0 on Node 24.21.0, by the spike and reproduced independently in review:

| | |
|---|---|
| Module load | 10–11 ms; resident memory +12–13 MB |
| Node build's `.wasm` | 4.3 MB (1.4 MB gzipped). The npm package also carries web and ESM builds, about 13 MB in total; packaging prunes them |
| One decision, pre-parsed (`statefulIsAuthorized`) | 43–78 µs |
| One decision, parsed per call (`isAuthorized`) | 267–740 µs |

Policies are therefore parsed once at load and never per request.

**Cedar's API has traps; the implementation must avoid every one.** Each was verified in review:

- `validate` reports `type: "success"` **even when validation errors are present**. Validity means
  `validationErrors` is empty.
- A request is checked against the schema only with `validateRequest: true` and a pre-parsed
  schema. Without them, a mistyped context (`port: "443"`) is evaluated silently. Every
  **decision** therefore validates its request.
- **Partial evaluation cannot take a schema in 4.13.** `isAuthorizedPartial` rejects an unknown
  value inside a validated context, and it has no pre-parsed variant (about 460 µs per call).
  - It is therefore used only where unknowns sit in entity attributes or the principal: the
    capability summary's `conditional` answers and the startup warning about grantable exceptions.
  - It runs **schema-less** there, which is safe because every policy was strictly validated at
    load.
  - It is never used on the request path or for `check`.
- **A policy that errors at runtime is skipped, not applied.** A `forbid` whose condition errors
  (for example, integer overflow) leaves a matching `permit` in force: the answer is **`allow`**,
  with the error listed in `diagnostics.errors`. **Fail-closed rule:**
  - any entry in `diagnostics.errors`, any `type: "failure"`, and any thrown exception all mean
    **deny**, with `ruleMatched: "engine.error"`;
  - a WebAssembly trap marks the authorizer unhealthy, and from then on every policy-gated
    operation is denied until the server restarts. `/health` reports this.
- `diagnostics.reason` is a **list** of the policies that determined the decision, in no defined
  order. Decisions report all of them, sorted.
- Annotations such as `@reason` do not appear in decisions. The server builds an
  id → annotation map at load (`policyToJson`).
- Policies are reported by id only when they are loaded as an `{id: text}` record. Loaded as one
  text blob, they are reported positionally as `policy0`, `policy1` and so on.
- Pre-parsed sets live in the WebAssembly instance, which is process-wide on the main thread.
  Re-preparsing an id silently replaces it, and nothing evicts them, so ids are namespaced by policy
  version.

**AgentBrowser defines the Cedar schema; operators write policies against it.**
- The schema covers entity types, actions and each action's context, and lives in
  `packages/protocol`. Per ADR-015 it is the single source of truth, and docs and tests are
  generated from it.
- Policies are validated in Cedar's **strict** mode at load.
- Policy ids starting with `floor.`, `default.`, `engine.` or `env.` are rejected, because those
  prefixes identify the server's own decisions.

The dependency lives in a new package, `@agentbrowser/policy-engine`, behind an `Authorizer`
interface. `protocol`, `engine` and `core` stay free of it, and `packages/policy` stays
dependency-free.

### 3. Destinations are set-valued, and exceptions are explicit actions

An address can be in several classes at once. For example:
- `::1`, `::` and `0.0.0.0` are loopback **and** private;
- `169.254.169.254` is private **and** metadata.

The classifier therefore yields a **set** (`context.addressClasses`), never a single value. For a
hostname that resolves to several addresses, each address is decided separately, and a request
needs every one of them allowed.

- A request whose classes are only `public` is checked with the `request` action.
- If its classes include `loopback`, it is also checked with `request.loopback`; if they include
  `private`, also with `request.private`. All the applicable checks must allow it.
- The floor refuses `metadata` before Cedar is consulted.
- **The address itself is in the context** as an optional attribute (`ip?: ipaddr`), so exceptions
  can name ranges. Policies test it as `context has ip && …`. For example, `context.ip.isInRange(ip("192.168.1.89/32"))` reproduces
  `ALLOWED_CIDRS=192.168.1.89/32`, and the generator emits one such permit per configured CIDR.
  - **IPv4-mapped IPv6 is normalized to IPv4 before the context is built.** Cedar refuses
    `ip("::ffff:192.168.1.65")` as an evaluation error. The hex form `::ffff:c0a8:141` does not
    match `192.168.1.0/24`. Today's `BlockList` treats both as their IPv4 identity.
  - **Only a single host address is ever passed.** A Cedar `ipaddr` may also be a range, and
    `"192.168.1.0/24"` as the context `ip` is accepted and can match a permit. Any `ip` a caller
    supplies to `check` with a prefix length is refused.

So `permit (principal, action == AgentBrowser::Action::"request", resource);` grants only public
egress. Opening loopback takes a deliberately named permit, and the server prints a loud startup
warning whenever any loaded policy can permit `request.loopback` or `request.private`. Partial
evaluation over an unknown principal detects that.

This replaces a quirk in the current code. Today `AGENTBROWSER_ALLOW_LOOPBACK` alone still denies
`[::1]`, `::` and `0.0.0.0`, because they are also blocked as private. The generated policies
(§4) reproduce today's behaviour exactly. The policy guide documents the set semantics.

### 4. One versioned policy document, with a built-in baseline

The operator supplies one file, named by `AGENTBROWSER_POLICY_FILE`:

```json
{
  "version": "agentbrowser-policy/v1",
  "baseline": "agentbrowser:baseline/v1",
  "policies": {
    "fixtures.loopback": "@reason(\"local test fixtures\") permit (principal in AgentBrowser::Tenant::\"qa\", action == AgentBrowser::Action::\"request.loopback\", resource);"
  },
  "approvalRules": [
    { "hostname": "shop.example", "action": "click", "name": "Pay", "effect": "transaction", "decision": "required" }
  ],
  "unknownRisk": "allow",
  "limits": { "maxResponseBytes": 10485760, "extractMaxBytes": 1048576 }
}
```

- **`baseline`:** the server prepends a built-in, versioned policy set that grants what an
  unconfigured server grants today: public egress, today's capability grants, and today's approval
  outcomes per effect. It is on by default.
  - An operator who omits it (`"baseline": "none"`) starts from Cedar's default deny, and a file
    with no public-egress permit gets a startup warning.
  - Without the baseline, a file carrying only one loopback exception would deny all public
    browsing.
- **`policies`:** Cedar text keyed by id.
- **`approvalRules`** and **`unknownRisk`:** today's operator approval policy, unchanged in shape
  (first-match, optional per-rule `decision`), validated by TypeBox (§5).
- **`limits`:** numeric configuration, validated by TypeBox. Limits are not authorization, so they
  are not forced into Cedar.
- **The document's version** is the SHA-256 of its canonical JSON, including the resolved baseline
  version. It is stamped on every session at creation and reported by the query surface.
- **Loading is startup-only** in this ADR.
  - An invalid document aborts startup, naming the error location but never document contents.
    There is no fallback.
  - A reload without restart is a later decision; when it comes, a reload must never relax a live
    session.

**Without a file, nothing changes.** The server keeps today's TypeScript decision code behind the
same `Authorizer` interface. Cedar is loaded only when a file is supplied, so deployments that
don't opt in pay no WebAssembly cost and take no new risk.

To make the switch safe, the TD adds the following before anyone is encouraged to opt in:
- a generator that translates today's variables into a policy document;
- a **differential oracle**: property-based tests over generated addresses, hostnames and rules
  that compare the two implementations;
- an optional **shadow mode** that evaluates Cedar alongside and logs divergences.

**Configuration conflicts are errors, not precedence.** `AGENTBROWSER_POLICY_FILE` cannot be
combined with any policy-bearing variable or embedder option. Startup fails and names them all.

| Classification | Settings |
|---|---|
| **Policy-bearing** (moves into the document; conflicts with the file) | `ALLOW_LOOPBACK`, `ALLOWED_CIDRS`, `APPROVAL_POLICY`, `MAX_RESPONSE_BYTES`, `EXTRACT_MAX_BYTES`, `INLINE_ARTIFACT_MAX_BYTES`, `DEFAULT_TTL_MS` and `DEFAULT_IDLE_TIMEOUT_MS` (defaults that a session may still override within the protocol's bounds), and their embedder twins `ServerOptions.approvalPolicy`, `networkPolicy`, `extractMaxBytes`, `defaultTtlMs` and `defaultIdleTimeoutMs` |
| **Floor inputs** (stay variables; they describe the deployment, not grants) | `HOSTED` and `ServerOptions.deploymentMode`; `CDP_ENDPOINT` and `CDP_ALLOW_UNENFORCED_EGRESS`, and `ServerOptions.operatorCdp`, which still enable attachment and its floor refusals; Cedar can only refuse further |
| **Bootstrap** (stay variables) | `HOST`, `PORT`, `API_KEYS` and `ServerOptions.apiKeys`, `ARTIFACT_KEY` (a secret), `CORS_ORIGINS` / `corsOrigin` and `ALLOWED_HOSTS` (API-surface admission), `POLICY_FILE` and `POLICY_SHADOW`, file paths, logging (`LOG_LEVEL`), lifecycle (`SHUTDOWN_ON_STDIN_EOF`), and engine tuning (`SNAPSHOT_TIMEOUT_MS`, `EMPTY_DOM_*`, `ASSUME_DISPLAY`, `CHROME_PATH`, `PREFER_BUNDLED`) |
| **Trusted operator configuration** (stays a variable; documented as security-relevant) | `CHROMIUM_ARGS`. Flags such as `--proxy-server` or `--host-resolver-rules` can undermine egress, so it is treated like the binary path: trusted, never caller-supplied |

The table lists every **service** setting at the time of writing. The MCP, CLI and launcher
variables are client-side and out of scope; the policy guide keeps it current. The stock
entrypoint (`packages/api/src/main.ts`) builds `networkPolicy` and `extractMaxBytes` from the
environment and passes them on every start. With a policy file it stops doing so, so the conflict
rule fires only on genuine double configuration.

The policy-bearing variables are deprecated, with a startup warning, once the file ships. They are
removed no earlier than 2.0.

### 5. Approvals: TypeScript classifies, Cedar decides

Cedar returns permit or deny, ignores rule order, and cannot return data. Today's approval policy
is first-match, classifies effects, and has three outcomes, so the work is split:

- **Classification stays in TypeScript.** `approvalRules` in the document, or today's variable,
  feed `ActionRiskPolicy`'s first-match matcher unchanged, including each rule's optional
  `decision` and the policy-wide `unknownRisk`. Both become fields of the document. The matcher
  yields the action's effect (or `unknown`) and the first matching rule's identifier (or none).
  That identifier is its optional `id`, or `rule-<index>` when no id is given.
- **Both reach Cedar in the context:** `context.effect` and `context.matchedRule`. A rule's own
  `decision` is a generated policy keyed on its id: `deny` becomes a `forbid` on `act`, and
  `allow` or `required` becomes a `permit` or `forbid` on `act.unattended`.
- **The baseline contains no `forbid` on `act` or `act.unattended`.** High-risk effects need
  approval through the *absence* of an `act.unattended` permit, never through a `forbid`, because
  a `forbid` would override any operator rule `decision: "allow"`. Operator documents may use
  `forbid` freely.
- **`unknownRisk` is a parameter of the baseline**, written into the generated baseline policy for
  `effect == "unknown"`. The baseline therefore stays a fixed, versioned template.
- **Cedar decides from the effect,** which arrives in the context together with hostname, action,
  role and name. Two questions are asked:
  - `act`: may this action run at all? A deny means `POLICY_DENIED`.
  - `act.unattended`: may it run **without** an approval token? A deny means `APPROVAL_REQUIRED`.
- **Session tightening is unchanged.** Session `policy.approval.transactions` and
  `externalMessages` can still only tighten (`required` or `deny`), applied after Cedar exactly as
  they are applied after the operator policy today.

The baseline's approval policies reproduce today's mapping:
- high-risk effects require approval;
- `unknown` follows `unknownRisk`;
- everything else is allowed.

Operators add `forbid` and `permit` rules over effect and host, for example "transactions on
`shop.example` are denied for tenant `ci`".

### 6. Tenants are the unit of policy, and only authenticated tenants count

The principal is the session, which belongs to its tenant (`Session in [Tenant]`).

**Tenant constraints are honoured only when the tenant comes from a key.** In no-keys mode the
caller supplies `tenantId` itself, both in `POST /v1/sessions` and through MCP `create`. So:
- policy evaluation uses one fixed implicit tenant, `AgentBrowser::Tenant::"local"`, whatever
  `tenantId` the caller sends;
- a policy file that constrains any other tenant is **refused at startup** when no API keys are
  configured. A "tenant constraint" is **any** `Tenant` entity literal anywhere in a policy,
  conditions included, found by walking each policy's JSON form (`policyToJson`).
- the name `local` is reserved, and a key tenant named `local` is refused at startup.

Without these two rules, any unauthenticated caller could claim another tenant's grants by naming
it.

### 7. Agents can ask

Queries are read-only and limited to the caller's authenticated tenant, or the implicit `local`
tenant in no-keys mode.

- **`GET /v1/policy`** returns:
  - the policy version and effective limits;
  - a **capability summary**, keyed by the same names as the Cedar actions (`cdp.attach`,
    `cookie.export`, `cookie.seed`, `downloads`, `serviceWorkers`, `session.headed`), saying
    whether each is granted. `session.delegated` is listed as floor-only: it depends on
    authentication, not on policy;
    - each answer is evaluated for a **default session** of this tenant, and the response says so,
      because session attributes (engine, headless, control mode) can change an answer;
    - where the answer depends on those attributes, it is reported as `conditional`, using Cedar
      partial evaluation, rather than a guess;
  - **no raw policy text.**
- **`POST /v1/policy/check`** is a dry run that takes `{ action, url?, context? }`.
  - It never acts and never resolves DNS.
  - An IP literal is classified exactly as at request time.
  - A hostname first goes through the name-level rules enforcement applies: `localhost` and
    `localhost.localdomain` are loopback by name, and `metadata.google.internal`, `metadata.goog` and
    any subdomain of either are floor by name.
  - Otherwise the hostname is decided **once per address-class set the classifier can actually
    produce**: `{public}`, `{loopback}`, `{private}` and `{loopback, private}` (`public` means "no
    other class", and metadata is floor). That list is generated from the classifier's own table,
    so the two cannot drift. Each set is a normal, validated decision.
  - Actions whose policies reference `context.ip` (found at load by walking `policyToJson`) answer
    `depends on resolved address` for a hostname, never `denied`, because a CIDR exception might
    match the resolved address.
  - The answer is `allowed`, `denied`, or `depends on resolved address` with the deciding sets.
    So `check` cannot be used as a DNS oracle for internal names.
  - **Without a policy file**, both routes answer through `LegacyAuthorizer` by the same
    enumeration. Answers that would need partial evaluation are reported as `unconditional for a
    default session`.
  - It is bounded in request size. A per-tenant rate limiter is **new** with this route: no HTTP
    rate limiter exists today, only session, connection and approval quotas.
- **The MCP server gains a read-only `policy` tool** (get and check) in every mode.

**Denials name their rule, without leaking.**
- `POLICY_DENIED` and `APPROVAL_REQUIRED` populate `policyDecision`. The protocol gains
  `rulesMatched: string[]`: all deciding ids, sorted. It changes first, as ADR-015 requires. The
  existing `ruleMatched` keeps the first of them, for compatibility, and `reason` carries its
  `@reason` annotation.
- A policy marked `@internal` is reported as `operator.policy`, with no `@reason`, so global
  `forbid` rules naming internal hosts are not disclosed.
- Fixed refusals report `floor.<rule>`, engine errors `engine.error`, and Cedar's default deny
  `default.deny`.

### 8. Caching is bounded and never hides a DNS change

The egress choke point validates every request afresh. Host memoization was removed deliberately,
because it hid DNS changes and grew without bound. The design keeps both properties:

- Address classes always come from the **fresh** classification of the current request.
- Only the Cedar evaluation is cached, keyed by (session, action, host, normalized address, the
  sorted class set, and the action's declared context fields).
- The cache is a per-session **LRU with a fixed entry bound**, as TD-BROWSER-9 requires for every
  collection. It is cleared at session close.
- **A DNS change therefore changes the key, never the answer for the old key.**

**`/health` reports only a boolean** for the authorizer's health, never policy details. In shadow
mode a trap marks only the shadow unhealthy and never affects legacy decisions, and the
performance gate measures shadow mode too, because it doubles evaluation.

Every deny is logged at `warn` and every approval-required decision at `info`, through
`StructuredLogger`. Each log line carries the policy version and rule ids.

## Consequences

- **Per-tenant, authenticated policy:** the global loopback and CIDR switches stop being the only
  lever.
- **Agents learn what is allowed before acting,** and denials name their rule.
- **Reviewable policy as code:** one file, strict validation, and a reproducible version.
- **The floor gets stronger before anything moves out of code:** a wider metadata set, and the
  CDP-attach refusals stated as unconditional.
- **The dependency is opt-in at runtime:** about 4.3 MB of WebAssembly ships in the server tarball
  and the Windows bundle, but it loads only when a policy file is supplied. The CLI and MCP
  executables are unchanged.
- **The shipped-path gate needs an exception.** All three cedar-wasm builds embed the paths of the
  CI machine they were built on (`/home/runner/work/cedar/…`, `/home/runner/.cargo/registry/…`) as
  inert panic-location strings. The gate gets a file-scoped exception for that one pinned file,
  verified by integrity hash, as it already has for the bundled Node runtime.
- **New failure modes:** an invalid policy file stops the server, and a WebAssembly trap
  fails closed until restart. Both are intended.
- **Out of scope:** reloading policy without restart; policy over page content; replacing session
  narrowing or engagement scope; making the floor configurable; DNS pinning for browser traffic.

## Alternatives considered

- **OPA / Rego.** A sidecar or a separate WASM build; a general-purpose language without built-in
  schema validation, so attribute mistakes surface at runtime. Rejected.
- **A bespoke JSON schema.** That is the status quo, extended: every new rule shape needs new
  parser, validation and docs. Rejected. Only the first-match **classification** rules keep a typed
  JSON form (§5), because Cedar cannot express ordered classification.
- **A Cedar sidecar or managed service** (for example, Amazon Verified Permissions). A network hop
  on every egress decision and an online dependency. Rejected.
- **Casbin.** Weaker typing and no schema validation comparable to strict mode. Rejected.
- **Cedar overriding the floor, or loopback and private reachable through plain `request`.** One
  broad permit would open the server's own API. Rejected for floor-default blocks plus explicit
  exception actions.
- **Translating approval rules into Cedar policies.** First-match order requires each rule to
  negate all earlier ones (quadratic policy text), and effect classification is output data Cedar
  cannot return. Rejected for TypeScript classification plus Cedar decisions.
- **Switching every deployment to Cedar at once.** It makes WebAssembly mandatory, and trusts an
  oracle that only covers the existing tests. Rejected for opt-in with a differential oracle and
  shadow mode.
- **Returning raw policy text from `GET /v1/policy`.** It discloses other tenants and internal
  hosts. Rejected.
