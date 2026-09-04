# AgentBrowser Documentation

This directory holds the design and operations documentation: architecture
decision records (ADRs), technical designs (TDs), the operations guide, the
threat model, and audit records. For installation and day-to-day usage,
start with the [root README](../README.md).

## Where to look, by task

| You want to… | Read |
| --- | --- |
| Install the service / MCP binary, wire up a client | [README](../README.md#install-homebrew) |
| Run, configure, monitor, or troubleshoot the service | [Operations guide](operations.md) |
| Choose or implement an engine | [Engine matrix](engines.md) |
| Call the REST API | `GET /openapi.json` on a running service |
| Understand why a design decision was made | ADRs, below |
| Understand the security posture and its limits | [Threat model](threat-model.md) |
| See what changed in a release | [Changelog](../CHANGELOG.md) |

## Architecture Decision Records (ADRs)

ADRs capture significant architectural decisions, their context, and consequences. Once accepted, these decisions guide implementation and should be referenced when questions arise.

### Core Architecture ADRs

| ADR | Title | Status | Key Decision |
|-----|-------|--------|---------------|
| [ADR-001](adr/001-typescript-playwright-mvp.md) | TypeScript Control Plane and Playwright Chromium MVP | Accepted | Use TypeScript for control plane, Playwright+Chromium for MVP browser engine |
| [ADR-002](adr/002-engine-neutral-protocol.md) | Engine-Neutral Public Protocol and Adapter Contract | Accepted | Define versioned `BrowserEngine` interface as sole public contract |
| [ADR-003](adr/003-headless-first-semantic-observations.md) | Headless-First, Semantic Observations, Optional Visual Evidence | Accepted | Semantic observations as default, screenshots optional |
| [ADR-004](adr/004-stable-element-refs-revision-checking.md) | Stable Element References with Revision Checking | Accepted | Server-managed refs, reject stale refs explicitly |
| [ADR-005](adr/005-ephemeral-sessions-explicit-persistence.md) | Ephemeral Sessions and Explicit Persistence | Accepted | Sessions ephemeral by default, persistence opt-in only |
| [ADR-006](adr/006-network-egress-policy-ssrf.md) | Network Egress Policy Boundary and SSRF Defense | Accepted | All network access passes through policy choke point |
| [ADR-007](adr/007-approval-tokens-side-effects.md) | Approval Tokens Bound to Exact Side Effects | Accepted | Classify actions by effect, require approval for high-risk |
| [ADR-008](adr/008-process-container-isolation.md) | Process/Container Isolation for Hostile Multi-Tenancy | Accepted | Process isolation minimum for hosted multi-tenant |
| [ADR-009](adr/009-mcp-high-level-tools.md) | MCP Exposes High-Level Safe Tools, Not Raw Playwright | Accepted | Small set of composable tools, dangerous operations excluded |
| [ADR-010](adr/010-rust-engine-gated-by-benchmarks.md) | Rust Engine Investment Gated by Benchmarks | Accepted | Invest only when metrics prove Chromium is bottleneck |
| [ADR-011](adr/011-safari-via-safaridriver-webdriver.md) | Real Safari via Safaridriver (WebDriver), Not Playwright WebKit | Accepted | Real-Safari login flows via macOS safaridriver; always headed; egress unenforceable (loud) |
| [ADR-012](adr/012-snapshot-plan-interaction-model.md) | Snapshot-Plan Interaction Model with Adaptive Modes | Accepted | Batched action plans (`browser_plan`) + self-contained page snapshots (`browser_snapshot`), one round trip each; adaptive stable/verified remap mode driven by observed ref churn |
| [ADR-013](adr/013-headed-sessions-and-walled-logins.md) | Headed Sessions, De-fingerprinting, and Walled Logins | Accepted | De-fingerprint headed only; no CDP arms race — cookie-seeding handoff is the prescribed route for turnstile-class walls |
| [ADR-014](adr/014-npm-distribution.md) | npm Distribution for the MCP Server (Trusted Publishing, @anvailabs scope) | Accepted | npm = @anvailabs/agentbrowser-mcp via OIDC trusted publishing; server stays tarballs+Docker; verify enforced not token-keyed |
| [ADR-015](adr/015-cross-package-contract-single-source-of-truth.md) | Single Source of Truth for Cross-Package Contract Primitives | Proposed | Renumbered twice (011→012→015): 012 collided a second time with the Accepted snapshot-plan ADR above; resolved 2026-09-03 |

## Technical Design

### [Technical Design and Implementation Plan](technical-design.md)

Comprehensive implementation roadmap with:
- **Task breakdown**: 26 detailed tasks (TD-001 through TD-026)
- **Dependency ordering**: Critical path and parallel work identified
- **TDD approach**: Test examples provided for each task
- **Three phases**: Foundation, Core Functionality, Safety, Operability

#### Quick Reference

**Phase 0: Repository Foundation (1-2 days)**
- Monorepo setup with pnpm
- Protocol schemas and types
- BrowserEngine interface
- FakeEngine for contract testing
- Threat model

**Phase 1: Core Functionality (3-5 days)**
- Session coordinator
- Playwright Chromium engine
- Observation normalization
- Action execution with refs
- REST API and SDK

**Phase 2: Safety and Agent Quality (4-6 days)**
- Network egress policy
- Approval gates
- Secret-safe credentials
- MCP server
- Downloads and artifacts

**Phase 3: Operability (3-5 days)**
- OpenTelemetry tracing
- Metrics and logging
- Docker hardening
- Crash recovery
- Benchmarks and soak tests

## Implementation Guidelines

### Before Starting Implementation

1. **Read all ADRs** - Understanding the "why" behind decisions
2. **Review Technical Design** - Understand the full roadmap
3. **Start with Phase 0** - Foundation must be solid
4. **Follow TDD** - Write tests before implementation
5. **Respect critical path** - Tasks in order, others in parallel

### During Implementation

1. **Reference ADRs** - When questions arise, check the relevant ADR
2. **Update docs** - If decisions change, update ADRs
3. **Run tests** - Never commit without tests passing
4. **Check acceptance** - Each task has clear acceptance criteria
5. **Document deviations** - If implementation must differ from design, create new ADR

### Safety Invariants

These are never compromised:
1. **No cross-tenant data leakage** - Isolation is paramount
2. **No secret exfiltration** - Secrets redacted everywhere
3. **No SSRF** - Network policy enforced at choke point
4. **No guessed actions** - Stale refs explicitly rejected
5. **No silent fallback** - All changes recorded and visible

## Additional Documentation

- [threat-model.md](threat-model.md) - security threat analysis: what the
  service defends against, and the named, honest limits (e.g. the Obscura
  egress gap)
- [operations.md](operations.md) - deployment and operations guide:
  configuration, auth, health/metrics, session lifecycle, troubleshooting
- [engines.md](engines.md) - the engine implementation contract in practice:
  the matrix, the shared contract suite, per-engine egress guarantees
- API reference: generated by the service at `GET /openapi.json` (also
  emitted at build time by `packages/api` — see `emit-openapi.ts`)

## Task Definitions (post-MVP)

Post-MVP tasks live in [td/](td/). The MVP task series (TD-001..TD-026) is
complete and remains in [technical-design.md](technical-design.md).

- [TD-BROWSER-5](td/TD-BROWSER-5-single-binary-mcp-distribution.md) - Single-binary
  MCP server distribution (Bun `--compile`) + release CI. **Accepted,
  implemented.** (TD-BROWSER-1..4 are reserved names; see the doc.)
- [TD-BROWSER-6](td/TD-BROWSER-6-headed-sessions-and-credential-handoff.md) -
  Headed sessions and credential handoff (dedicated per-session browsers, cookie
  export/import). **Accepted, implemented.**
- [TD-BROWSER-7](td/TD-BROWSER-7-safari-webdriver-engine.md) - Real Safari via
  `safaridriver`/WebDriver, engine registry. **Accepted, implemented.**
- [TD-BROWSER-8](td/TD-BROWSER-8-batched-snapshots-and-action-plans.md) -
  Batched action plans (`browser_plan`) and self-contained page snapshots
  (`browser_snapshot`), adaptive stable/verified remap mode. **Accepted, Phase 1
  implemented.**
- [TD-BROWSER-9](td/TD-BROWSER-9-bounded-in-memory-collections.md) - Bounded
  in-memory collections & eviction discipline (shared `BoundedCache`/`RingBuffer`,
  indexed hot-path lookups). **Accepted, implemented** (all 8 sites; metrics
  quantiles read a bounded recent-sample window, `_count`/`_sum` stay all-time).
  Addresses `hygiene-audit.md` Theme A.

## Audits

- [audit.md](audit.md) - Vision-vs-implementation / security-and-spec audit
  (2026-08-26). **Closed** — all P0/P1/P2 landed.
- [hygiene-audit.md](hygiene-audit.md) - Engineering-hygiene audit (2026-08-31):
  design patterns, data structures, cross-package contracts, dead code, resource
  lifecycle. Findings grouped A–G, each grep-verified with an adversarial
  rationalization; drives [ADR-015] and [TD-BROWSER-9].

## Template

New ADRs should use the [ADR template](adr/000-template.md).

---

**Status**: 🟢 MVP shipped; post-MVP TDs in active development
**Last Updated**: 2026-09-04
