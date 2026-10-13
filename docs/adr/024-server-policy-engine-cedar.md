# ADR-024: Server Policy Engine — Embedded Cedar, Queryable by Agents

**Status:** Proposed (2026-10-13)
**Related:** [ADR-006](006-network-egress-policy-ssrf.md) (egress policy and SSRF defense),
[ADR-007](007-approval-tokens-side-effects.md) (approval tokens),
[ADR-008](008-process-container-isolation.md) (isolation),
[ADR-015](015-cross-package-contract-single-source-of-truth.md) (single source of truth),
[TD-BROWSER-15](../td/TD-BROWSER-15-server-policy-engine.md) (implementation plan)

## Context

What the server allows is decided today by policy scattered across environment variables, a JSON
blob and code:

- **Egress exceptions:** `AGENTBROWSER_ALLOW_LOOPBACK` and `AGENTBROWSER_ALLOWED_CIDRS` relax the
  SSRF block for **every** session on the server.
- **Approvals:** `AGENTBROWSER_APPROVAL_POLICY` is a JSON object of first-match rules (hostname,
  action, role, name → effect), parsed with `JSON.parse` in `packages/api/src/server.ts`.
- **Capability gates:** `AGENTBROWSER_HOSTED`, `AGENTBROWSER_CDP_ENDPOINT` together with
  `AGENTBROWSER_CDP_ALLOW_UNENFORCED_EGRESS`, and per-session switches such as
  `allowServiceWorkers` and `allowDownloads`.
- **Limits:** `AGENTBROWSER_MAX_RESPONSE_BYTES`, `AGENTBROWSER_EXTRACT_MAX_BYTES` and similar.

Three problems follow:

1. **Policy is per process, not per tenant.** Setting `AGENTBROWSER_ALLOW_LOOPBACK=1` for one
   tenant's local test fixture opens loopback for every tenant on that server.
2. **Agents cannot ask what is allowed.** They find out by failing. An agent sees `POLICY_DENIED`
   or `APPROVAL_REQUIRED` after it has planned and acted; nothing lets it check beforehand, and the
   denial does not say which rule fired. `PolicyDecisionSchema` already has a `ruleMatched` field
   for exactly this, but nothing fills it from a named rule.
3. **Each new gate is another bespoke variable**, with its own parser, validation and
   documentation. The 1.17.1 environment reference found 14 variables documented nowhere.

Session policy (`SessionPolicySchema`: allowed and blocked hosts, engagement scope) is a different
thing: a caller **restricting** its own session. It works and is out of scope here except where it
composes with the server's policy.

## Decision

### 1. Two layers: a fixed safety floor, and policy above it

**The safety floor stays in TypeScript and is not configurable by policy.** It is what ADR-006 and
ADR-007 guarantee regardless of any operator's choices:

- cloud-metadata endpoints are always refused;
- DNS resolution and connection pinning at the egress choke point;
- the enforcement mechanisms for redirect, response-size and request caps (their *values* are
  policy; see §3);
- approval-token mechanics: single use, bound to page, revision, target fingerprint and
  parameters;
- secret redaction.

**Policy decides everything an operator chooses**, in the Cedar policy language
([cedarpolicy.com](https://www.cedarpolicy.com/)):

- which destinations sessions may reach, by host and address class, including the loopback and
  private-range exceptions that are global switches today;
- which actions need approval or are denied (replacing `AGENTBROWSER_APPROVAL_POLICY` rules);
- capability gates: CDP attach, service workers, downloads, cookie export and seeding, headed and
  delegated sessions, and the cookie handoff that ADR-025 will propose.

**Composition is deny-wins across layers.** A request proceeds only if the floor allows it, the
Cedar decision is `allow`, and the session's own restrictions (`SessionPolicySchema`) allow it.
Cedar can never grant what the floor refuses; a session can only narrow what Cedar allows. This
keeps ADR-006's guarantee that no configuration can reach a metadata endpoint, and it keeps
session policy restrict-only.

### 2. Cedar, embedded as WebAssembly

The server evaluates policy in-process with the official
[`@cedar-policy/cedar-wasm`](https://www.npmjs.com/package/@cedar-policy/cedar-wasm) package
(Apache-2.0, maintained by the Cedar project). There is no sidecar and no network dependency.

A spike against 4.13.0 (Node 24, this repository's pinned runtime) measured:

| | |
|---|---|
| Module load | about 11 ms; resident memory +12 MB |
| Package size | 4.3 MB for the Node build's `.wasm` (the npm tarball also carries web and ESM builds the server does not ship) |
| One decision, pre-parsed policies (`statefulIsAuthorized`) | about 78 µs |
| One decision, policies parsed per call (`isAuthorized`) | about 695 µs |

So policies are parsed once at load (`preparsePolicySet`, `preparseSchema`) and never per
request. The egress choke point sees every subresource, so decisions are additionally cached per
session (§6).

**AgentBrowser defines the Cedar schema; operators write policies against it.** The schema (entity
types such as `Tenant`, `Session` and `Host`; actions such as `request`, `navigate`, `act` and
`cdp.attach`; and each action's context) lives in `packages/protocol` beside the TypeBox schemas.
Per ADR-015 it is the single source of truth, and docs and tests are generated from it.
Policies are validated against it in Cedar's **strict** mode at load, so a policy that names an
unknown attribute or compares mismatched types fails before the server serves anything.

**Every policy carries an id**, the key it is loaded under, and decisions report which policies
determined them. The spike confirmed that policies loaded as `{id: text}` are reported by id, for
example `ssrf.baseline`. That id fills `PolicyDecision.ruleMatched`. An optional `@reason("…")`
annotation supplies the human- and agent-readable explanation.

The Cedar dependency lives in a new package, `@agentbrowser/policy-engine`, behind a small
`Authorizer` interface. `protocol`, `engine` and `core` stay free of it, and `packages/policy`
stays dependency-free.

### 3. One versioned policy document

The operator supplies one file, named by `AGENTBROWSER_POLICY_FILE`:

```json
{
  "version": "agentbrowser-policy/v1",
  "policies": {
    "egress.public": "permit (principal, action == AgentBrowser::Action::\"request\", resource) when { context.addressClass == \"public\" };",
    "fixtures.loopback": "@reason(\"local test fixtures\") permit (principal in AgentBrowser::Tenant::\"qa\", action == AgentBrowser::Action::\"request\", resource) when { context.addressClass == \"loopback\" };"
  },
  "limits": { "maxResponseBytes": 10485760, "extractMaxBytes": 1048576 }
}
```

- **`policies`** holds Cedar text keyed by id. Cedar decides allow or deny; it does not hold
  numbers.
- **`limits`** holds numeric settings, validated by a TypeBox schema in `packages/protocol`. Limits
  are configuration, not authorization, so they are not forced into Cedar.
- **The document's version** is the SHA-256 of its canonical form. It is stamped on every session
  at creation and reported by the query surface (§5), so a decision can always be traced to the
  exact policy that made it.
- **Loading is startup-only in this ADR.** An invalid document (parse error, strict-validation
  error, unknown limit) aborts startup with the error location and never with document contents.
  There is no fallback to a default policy (CLAUDE.md: no silent fallback). Reloading a running
  server is deliberately left to a later decision; when it comes, the rule is that a reload never
  relaxes a live session.

**Without a policy file, nothing changes for existing deployments.** The server translates today's
variables into an equivalent generated policy set, with ids such as `env.allow-loopback` and
`env.approval.rule-3`, and evaluates that. Golden tests prove that the generated policies give the
same decision as today's code for every combination the current tests cover.

**Setting both is an error.** If `AGENTBROWSER_POLICY_FILE` is set together with any
policy-bearing variable (`ALLOW_LOOPBACK`, `ALLOWED_CIDRS`, `APPROVAL_POLICY`,
`CDP_ALLOW_UNENFORCED_EGRESS`, `MAX_RESPONSE_BYTES`, `EXTRACT_MAX_BYTES`), startup fails and names
the conflicting variables. No precedence rule is invented.

The policy-bearing variables are deprecated, with a startup warning, once the file ships. They are
removed no earlier than 2.0. **Bootstrap settings stay environment variables:** the port and host,
API keys, file paths, and anything needed before the policy file can be read.

### 4. Tenants become the unit of policy

Cedar's principal is the session, which belongs to its tenant (`Session in [Tenant]`). An operator
can therefore grant loopback access to one tenant's fixtures without opening it for every tenant,
which fixes the first problem in the Context. In local no-keys mode there is one implicit tenant,
and policies written without a principal constraint behave as today's global switches.

### 5. Agents can ask

Querying is read-only and scoped to the caller's own tenant.

- **`GET /v1/policy`** returns:
  - the policy version;
  - the effective `limits`;
  - a **capability summary**: for each gated capability (`cdpAttach`, `cookie.export`,
    `cookie.seed`, `downloads`, `serviceWorkers`, `headed`, `delegated`), whether this tenant may
    use it, decided by evaluating the same policies with this tenant's principal. Each answer
    carries its deciding rule id and `@reason`.

  It does **not** return raw policy text. Policies can name other tenants and internal hosts, and
  publishing them would turn the endpoint into a map of the deployment.
- **`POST /v1/policy/check`** is a dry run. It takes `{ action, url?, context? }` and returns a
  `PolicyDecision`: `allowed`, the deciding `ruleMatched`, and the `reason`. It never acts, and its
  answers are deterministic for a given policy version.
  - It does **not** resolve DNS. A hostname is checked as declared; an IP literal is classified
    exactly as at request time.
  - When the answer depends on resolution, it says so (`reason: "decided at request time by
    resolved address"`). That keeps it from becoming a DNS oracle for internal names, and it never
    claims more certainty than it has.
  - It is bounded in request size and rate-limited per tenant like other `/v1` routes.
- **The MCP server gains a read-only `policy` tool** (get and check) in every mode, so an agent can
  plan around policy instead of discovering it by failing.

**Denials carry the same information.** `POLICY_DENIED` and `APPROVAL_REQUIRED` errors populate
the existing `policyDecision` (`ruleMatched`, `reason`) when Cedar decided them. Floor denials
report `ruleMatched: "floor.<rule>"`, so an agent can tell a fixed refusal from an operator
choice. Cedar denies by default when no policy permits a request. That case reports
`ruleMatched: "default.deny"`, because no single rule decided it.

### 6. Decisions are cached per session, logged, and bounded

- **Caching:** a session memoizes decisions keyed by (action, host, address class, the context
  fields the schema declares for that action), for the lifetime of the session. The policy version
  cannot change under a live session (§3), so the cache never serves a stale policy.
- **Logging:** every deny is logged at `warn` and every approval-requiring decision at `info`,
  through `StructuredLogger` with the policy version and rule id. Request URLs are recorded
  only as they are today (ADR-006 log entries), never with secrets.
- **Budget:** the benchmark suite gains a page-load case with hundreds of subresources. Policy
  evaluation must stay within a fixed share of load time, and the gate value is recorded in the TD
  from measurement, not assumed.

## Consequences

- **Per-tenant policy becomes possible**, and the global loopback and CIDR switches stop being the
  only lever.
- **Agents learn what is allowed before acting,** and denials name their rule. Fewer blind retries
  and wasted plans.
- **Policy becomes reviewable as code.** One file and one strict validator replace scattered
  variables and a free-form JSON blob. Operators can diff, test and version it.
- **New dependency:** about 4.3 MB of WebAssembly in the server tarball and the Windows bundle. The
  CLI and MCP executables do not load it and are unchanged. It is a pure-WASM package with no
  native addon, so it needs no per-platform build and survives the Windows bundle's link-free
  materialization.
- **A new failure mode at startup:** an invalid policy file stops the server. This is intended.
- **Migration:** existing variables keep working through generated policies, with deprecation
  warnings, until 2.0. Documentation gains a policy guide with examples for each former variable.
- **Out of scope:** reloading policy without a restart; policy over individual page content;
  replacing session policy (`SessionPolicySchema`) or engagement scope, which stay restrict-only
  caller layers.

## Alternatives considered

- **OPA / Rego.** It needs a sidecar or its own WASM build. Rego is a general-purpose datalog with
  no built-in schema validation, so "this policy references an attribute that does not exist" is
  found at runtime, not at load. Its expressiveness exceeds what authorization here needs and is
  harder to analyze. Rejected.
- **A bespoke JSON policy schema.** That is the status quo, extended. Every new rule shape needs
  new parser code, new validation and new docs, which is exactly the problem in the Context.
  Rejected.
- **Cedar as a sidecar or a managed service** (for example, Amazon Verified Permissions). It adds
  a network hop to every egress decision and a runtime dependency to a server that must work
  offline and on a laptop. Rejected; the embedded engine gives the same language.
- **Casbin.** Model files plus policy CSVs, with weaker typing and no schema validation comparable
  to Cedar's strict mode. Rejected.
- **Letting Cedar override the floor.** It would make metadata access, or a disabled approval
  binding, one policy mistake away. Rejected: the floor is not policy.
- **Returning raw policy text from `GET /v1/policy`.** It discloses other tenants and internal
  hosts. Rejected for a per-tenant capability summary plus a dry-run check.
