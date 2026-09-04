# AgentBrowser Implementation Roadmap

> **Historical planning record** (initial commit 2026-08-23). All 26 tasks
> shipped; "Immediate Actions" and "Questions to Address Before
> Implementation" below are preserved for the record only. Current status:
> `docs/README.md` and `CHANGELOG.md`.

## Summary

I've reviewed the AgentBrowser MVP specification and created a comprehensive implementation foundation with:

### 1. Architecture Decision Records (ADRs)

**10 ADRs** documenting all key architectural decisions:

- **ADR-001**: TypeScript + Playwright MVP - Fastest path to product validation
- **ADR-002**: Engine-neutral protocol - Stable interface across engine implementations
- **ADR-003**: Headless-first, semantic observations - Agent-optimized output format
- **ADR-004**: Stable element refs - Safe, revision-checked action targeting
- **ADR-005**: Ephemeral sessions - Security-by-default session model
- **ADR-006**: Network egress policy - SSRF defense and choke point architecture
- **ADR-007**: Approval tokens - Human oversight for high-risk actions
- **ADR-008**: Process isolation - Multi-tenant security boundaries
- **ADR-009**: MCP high-level tools - Safe, composable agent interface
- **ADR-010**: Rust engine gated by benchmarks - Data-driven engine investment

### 2. Technical Design Document

Comprehensive **26-task breakdown** organized in **3 phases**:

#### Phase 0: Repository Foundation (1-2 days) ✅ CRITICAL PATH
- TD-001: Monorepo and CI setup
- TD-002: Protocol schemas and types
- TD-003: BrowserEngine interface definition
- TD-004: FakeEngine for contract testing
- TD-005: Contract test suite
- TD-006: Threat model documentation

#### Phase 1: Core Functionality (3-5 days) ✅ CRITICAL PATH
- TD-007: Session coordinator
- TD-008: Playwright Chromium engine
- TD-009: Observation normalization
- TD-010: Action execution with refs
- TD-011: REST API
- TD-012: TypeScript SDK
- TD-013: CLI tool

#### Phase 2: Safety and Agent Quality (4-6 days) ✅ CRITICAL PATH
- TD-014: Network egress policy (SSRF defense)
- TD-015: Approval gates
- TD-016: Secret-safe credential handling
- TD-017: Downloads and artifacts
- TD-018: MCP server
- TD-019: Observation diffs and continuation

#### Phase 3: Operability (3-5 days) ✅ CRITICAL PATH
- TD-020: OpenTelemetry tracing
- TD-021: Metrics and logging
- TD-022: Docker hardening
- TD-023: Health endpoints and worker pool
- TD-024: Crash recovery
- TD-025: Benchmark and soak tests
- TD-026: OpenAPI documentation

## Critical Path

The **critical path** for MVP delivery:

```
TD-001 → TD-002 → TD-003 → TD-004 → TD-005 → TD-007 → TD-008
→ TD-009 → TD-010 → TD-011 → TD-012 → TD-014 → TD-015
→ TD-016 → TD-018 → TD-022 → MVP COMPLETE
```

**Parallel work opportunities** (can run concurrently):
- TD-006 (Threat Model) - Anytime during Phase 0
- TD-013 (CLI) - After TD-012
- TD-017 (Downloads) - After TD-008
- TD-019 (Diffs) - After TD-009
- TD-020-TD-021 (Tracing/Metrics) - After TD-007
- TD-023-TD-026 - During Phase 3

## TDD Approach

Each task includes:
- **Test examples** showing the TDD approach
- **Acceptance criteria** for completion
- **Dependency ordering** for task sequencing
- **Estimated time** for planning

### Test Strategy

```
Unit Tests → Contract Tests → Integration Tests → E2E Tests → Security Tests → Performance Tests
```

## Next Steps

### Immediate Actions

1. **Review ADRs 001-010**
   - Understand architectural decisions
   - Ask questions if anything is unclear
   - Approve or request changes

2. **Review Technical Design**
   - Understand task breakdown
   - Verify critical path makes sense
   - Identify any missing requirements

3. **Begin Phase 0 Implementation**
   - Start with TD-001 (Monorepo setup)
   - Follow TDD approach
   - Run tests continuously

### Implementation Workflow

```bash
# For each task:
1. Read task description in technical-design.md
2. Review relevant ADRs
3. Write failing tests first
4. Implement to pass tests
5. Verify acceptance criteria
6. Run: pnpm -r test && pnpm -r type-check
7. Create PR with tests
8. Update task tracking
```

### Tracking

Create GitHub Project with columns:
- **Backlog** - All tasks
- **Phase 0** - Foundation work
- **Phase 1** - Core functionality
- **Phase 2** - Safety and quality
- **Phase 3** - Operability
- **Done** - Completed tasks

## Success Criteria

### MVP Complete When:

- ✅ Can install and run via documented commands
- ✅ Can run in hardened Docker container
- ✅ Can create session via REST, SDK, CLI, MCP
- ✅ Can navigate to allowed URLs, block forbidden
- ✅ Can get bounded semantic observation with refs
- ✅ Can complete multi-step workflows without selectors
- ✅ Can detect stale refs without guessing
- ✅ Can require approval for simulated transactions
- ✅ Keeps secrets out of logs, observations, screenshots
- ✅ Can export screenshot, Markdown, JSON with provenance
- ✅ Survives crashes with typed errors and cleanup
- ✅ Passes contract, E2E, security, benchmark, soak tests
- ✅ Publishes OpenAPI, SDK docs, MCP config, threat model

### Performance Targets:

- Warm session creation: p50 ≤ 350ms, p95 ≤ 1,000ms
- Observation: p50 ≤ 150ms, p95 ≤ 500ms
- Agent observation: ≤ 32 KiB, ≤ 300 elements
- Action dispatch: ≤ 100ms p50
- 100 concurrent sessions without unbounded RSS growth
- Zero leaked processes per 10,000 sessions

## Documentation Structure

```
docs/
├── README.md                      # This index
├── adr/
│   ├── 000-template.md           # ADR template
│   ├── 001-typescript-playwright-mvp.md
│   ├── 002-engine-neutral-protocol.md
│   ├── 003-headless-first-semantic-observations.md
│   ├── 004-stable-element-refs-revision-checking.md
│   ├── 005-ephemeral-sessions-explicit-persistence.md
│   ├── 006-network-egress-policy-ssrf.md
│   ├── 007-approval-tokens-side-effects.md
│   ├── 008-process-container-isolation.md
│   ├── 009-mcp-high-level-tools.md
│   └── 010-rust-engine-gated-by-benchmarks.md
├── technical-design.md           # Full task breakdown with TDD examples
└── implementation-roadmap.md     # This file
```

## Questions to Address Before Implementation

1. **Resource allocation**: Who is available for implementation?
2. **Timeline**: Is 12-17 day timeline acceptable?
3. **AWS Startup Advisor leverage**: Do you want AWS-specific deployment guidance?
4. **Rust engine**: Is the benchmark-driven approach acceptable, or should we start earlier?
5. **MCP priority**: Is MCP server Phase 1 or Phase 2 for your use case?

---

**Status**: Historical planning record — implemented in full (TD-001..TD-026); see CHANGELOG.md
**Estimated Duration**: 12-17 days (following critical path) — actual: ~4 days (2026-08-23 → 2026-08-27)
**Approach**: TDD with vertical slices, contract-first, safety-invariant tests
