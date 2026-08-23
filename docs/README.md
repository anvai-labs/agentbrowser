# AgentBrowser Documentation

This directory contains the architectural decision records (ADRs) and technical design documentation for the AgentBrowser MVP implementation.

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

Planned documentation (to be created):

- [ ] `threat-model.md` - Detailed security threat analysis
- [ ] `operations.md` - Deployment and operations guide
- [ ] `engine-contract.md` - Engine implementation contract
- [ ] `api.md` - API usage documentation

## Template

New ADRs should use the [ADR template](adr/000-template.md).

---

**Status**: 🟢 Ready for implementation
**Last Updated**: 2025-01-23
**MVP Target**: Complete within 12-17 days following critical path
