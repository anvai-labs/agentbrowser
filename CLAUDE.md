# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

AgentBrowser is an agent-native browser service designed for AI agents to safely and reliably operate authorized websites. Unlike traditional browsers built for human visual interaction, AgentBrowser prioritizes:

- **Semantic observations** over screenshots (accessibility tree, DOM state, form values)
- **Stable element references** with automatic staleness detection
- **Safety-first** architecture (network policy, SSRF defense, approval gates)
- **Token-efficient** observations bounded by size/element count
- **Headless-first** operation (headed mode exists only for local debugging)

## Architecture

### Technology Stack

- **Language**: TypeScript 5.7+ (strict mode)
- **Runtime**: Node.js 22.11.1 LTS (pinned in `.tool-versions`)
- **Package Manager**: pnpm 9.15.0 (monorepo workspace)
- **Browser Engine (MVP)**: Playwright + Chromium
- **Testing**: Vitest (unit/contract), Biome (format/lint)
- **Future Engine**: Rust-native via stable `BrowserEngine` interface

### Critical Architectural Principle

> **Protocol over implementation**: The public API is defined by versioned JSON schemas in `packages/protocol/`. All browser engines must implement the `BrowserEngine` interface (`packages/engine/src/types.ts`). This engine-neutral boundary enables swapping engines without breaking clients.

### Monorepo Structure

```
agentbrowser/
├── packages/
│   ├── protocol/          # Versioned JSON schemas, TypeScript types, API contracts
│   ├── engine/            # BrowserEngine interface (engine-neutral contract)
│   ├── engine-playwright/ # Playwright Chromium/Firefox/WebKit engine (production default)
│   ├── engine-safari/     # Real Safari via safaridriver (ADR-011)
│   ├── engine-obscura/    # Obscura adapter — experimental, benchmark-only, unregistered
│   ├── core/              # Session coordination, observation normalization, action execution
│   ├── policy/            # Network egress policy (SSRF defense)
│   ├── extraction/        # Deterministic + model-adapter page extraction
│   ├── testkit/           # FakeEngine for contract testing, test utilities
│   ├── sdk-typescript/    # TypeScript client SDK
│   ├── api/               # REST + WebSocket service (Fastify) + OpenAPI emission
│   ├── cli/               # `agentbrowser` CLI
│   ├── mcp-server/        # `agentbrowser-mcp` MCP stdio server
│   └── benchmarks/        # Release-gate benchmark and soak suites
├── docs/
│   ├── adr/               # Architecture Decision Records
│   ├── td/                # Post-MVP technical designs (TD-BROWSER-5..9)
│   ├── technical-design.md # MVP implementation plan (historical record)
│   └── operations.md      # Operator guide
└── agentbrowser-mvp-spec.md # Complete MVP specification
```

### Package Dependencies

```
protocol (no dependencies)
  ↓
engine (depends on: protocol)
  ↓
core (depends on: engine, protocol)
  ↓
testkit (depends on: engine)
```

`policy` (dependency-free), `extraction`, and the surfaces (`api`, `cli`,
`mcp-server`, `benchmarks`) build on core/engine/protocol; each package's
`package.json` is the authoritative graph.

**Never import from concrete implementations** (like `engine-playwright`) in packages that should be engine-neutral. The `protocol` and `engine` packages must have zero Playwright imports.

## Common Development Commands

```bash
# Install dependencies
pnpm install

# Build all packages
pnpm -r build
# Or: pnpm build

# Type-check all packages
pnpm -r type-check
# Or: pnpm type-check

# Run all tests
pnpm -r test
# Or: pnpm test

# Run only unit tests (packages/)
pnpm test:unit

# Lint and format
pnpm -r lint
pnpm -r format

# Clean build artifacts and dependencies
pnpm clean
```

## Git Workflow

This project uses a **develop + main branch workflow** to ensure stable releases and safe integration:

### Branch Structure
- **`main`**: Release branch - always stable, releasable code
- **`develop`**: Integration branch - active development, feature integration
- **`feat/*`** (also `fix/*`, `docs/*`, `ci/*`, `chore/*` in use): task branches - isolated work on a feature or fix

### Workflow Pattern
```
develop (integration branch)
  ├─ feature/phase-2-optimizations
  ├─ feature/td-020-tracing  
  └─ feature/td-021-downloads

main (release branch)
  ← Merge from develop when phase complete
```

### Development Process
1. **Create feature branch** from `develop`:
   ```bash
   git checkout develop
   git pull origin develop
   git checkout -b feature/your-task-name
   ```

2. **Work on feature branch**: Make commits, run tests locally
   ```bash
   pnpm -r type-check && pnpm -r test
   ```

3. **Push and create PR**:
   ```bash
   git push -u origin feature/your-task-name
   # Create PR: develop ← feature/your-task-name
   ```

4. **CI runs automatically**: Type-check, lint, tests, build must pass

5. **Adversarial review**: substantive PRs (code, workflow, protocol surface) get an independent
   adversarial review pass before merge — the reviewer's job is to falsify the PR's claims, and
   confirmed findings are fixed pre-merge. (This has been the documentation discipline all along —
   every audit finding carries a rationalization "so an adversarial reviewer can independently
   confirm"; it is also the merge norm.)

6. **Merge to develop**: After review, merge to `develop`

7. **Phase complete?** Merge `develop` to `main` **with a PR** (never a direct local merge-push):
   ```bash
   gh pr create --base main --head develop
   ```

8. **After EVERY merge to `main`, sync main back into develop**:
   ```bash
   git checkout develop && git pull && git merge origin/main && git push origin develop
   ```
   The main-side merge commit exists only on main; without the back-sync, parallel work on develop
   and main diverges silently. This is not theoretical: parallel branch activity around #15–#24
   produced TWO decision-record numbering collisions (ADR-011 ×2, TD-BROWSER-6 ×2) because the two
   branches independently allocated the same numbers — resolved 2026-09-03, and the reason
   pre-announcing ADR numbers is retired. The back-sync after every main merge is what prevents a
   third.

### CI Configuration
- **Triggers**: Push and PR to `main` or `develop`; docs-only *pushes* skip
  via `paths-ignore` (pull requests always run the full suite)
- **Jobs**: type-check, lint (includes the doc-link check), test, build,
  docker, benchmarks, obscura (experimental), bun compile + smoke
- **Protection**: Main requires PR + passing CI

This workflow ensures `main` is always releasable while allowing active development on `develop`.

### Running Tests

```bash
# Run tests for a specific package
pnpm --filter @agentbrowser/core test

# Run tests in watch mode
pnpm --filter @agentbrowser/protocol test --watch

# Run tests with coverage
pnpm --filter @agentbrowser/core test --coverage
```

## Key Architectural Decisions (ADRs)

The following ADRs in `docs/adr/` are critical for understanding design choices:

1. **ADR-001**: TypeScript Playwright MVP - Why we chose TypeScript for control plane and Playwright for MVP engine
2. **ADR-002**: Engine-neutral protocol - How the `BrowserEngine` interface enables engine flexibility
3. **ADR-003**: Headless-first, semantic observations - Why observations prioritize accessibility trees over screenshots
4. **ADR-004**: Stable element references - How refs work with revision checking to prevent stale actions
5. **ADR-005**: Ephemeral sessions - Default ephemerality with explicit persistence
6. **ADR-006**: Network egress policy - SSRF defense and network policy enforcement
7. **ADR-007**: Approval tokens - Single-use tokens for high-risk actions
8. **ADR-008**: Process/container isolation - Security boundaries for multi-tenancy
9. **ADR-009**: MCP high-level tools - Why MCP exposes composable tools, not raw Playwright methods
10. **ADR-010**: Rust engine gated by benchmarks - When to invest in native engine
11. **ADR-011**: Real Safari via safaridriver - always headed, egress unenforceable (loud refusal)
12. **ADR-012**: Snapshot-plan interaction model - batched plans + snapshots, adaptive stable/verified modes
13. **ADR-013**: Headed sessions and walled logins - de-fingerprint headed only; cookie-seeding handoff over CDP arms races
14. **ADR-014**: npm distribution - `@anvailabs/agentbrowser-mcp` via OIDC trusted publishing
15. **ADR-015** (Proposed): cross-package contract single source of truth

## Core Concepts

### BrowserEngine Interface

The `BrowserEngine` interface is the source of truth for engine integration:

```typescript
interface BrowserEngine {
  readonly name: string;
  readonly version: string;
  capabilities(): Promise<EngineCapabilities>;
  createSession(options: EngineSessionOptions): Promise<EngineSession>;
  close(): Promise<void>;
}
```

All engines (Playwright, Obscura, future Rust) must implement this contract. The contract tests in `packages/testkit/` validate compliance.

### Element References

Element refs (`e<revision>_<ordinal>`) are **scoped to tenant + session + page** and include revision tracking. Actions automatically fail with `STALE_TARGET` if the page revision changes, preventing "click the wrong thing" bugs.

**Never expose CSS selectors or XPath to agents** unless explicitly requested. Refs are the primary interaction mechanism.

### Session States

Sessions follow: `CREATING → READY → ACTIVE → CLOSING → CLOSED`

Terminal failure states: `EXPIRED`, `POLICY_TERMINATED`, `ENGINE_CRASHED`, `QUOTA_TERMINATED`

### Observation Model

Default observations are **semantic and token-efficient**:
- Accessibility roles and names
- Form values and validation state
- Interactive elements only
- Bounded by `maxBytes` and `maxElements`
- Truncation prioritizes: dialogs → focused element → interactive elements → content

Screenshots are **optional evidence**, not the primary observation mode.

### Safety Invariants

The following are architectural rules, not suggestions:

1. **Hostile-page assumption**: All page content is untrusted. Never concatenate page text into system instructions.
2. **Network egress choke point**: All requests (documents, subresources, fetch/XHR) pass through policy checks.
3. **SSRF defense**: Block loopback, private IPs, cloud metadata by default.
4. **Secret redaction**: Sensitive values never appear in logs, traces, errors, or observations.
5. **No silent fallback**: Engine changes are recorded in responses and traces.
6. **Approval gates**: High-risk actions (transactions, account changes) require explicit approval.

## Development Workflow

### Test-Driven Development (TDD)

This project follows TDD principles. Write tests **before** implementation:

1. Write failing test for the behavior
2. Implement minimal code to pass
3. Refactor
4. Repeat

### Contract Testing

The `packages/testkit/` contains `FakeEngine`, an in-memory implementation used for contract testing. All engine implementations must pass the same contract suite:

```typescript
// Test that works against any engine
it('should navigate and observe', async () => {
  const session = await engine.createSession({});
  const page = await session.newPage();
  await page.navigate({ url: 'https://example.com' });
  const state = await page.observe({ mode: 'interactive' });
  
  expect(state.url).toBe('https://example.com');
  expect(state.elements).toBeDefined();
});
```

### Adding New Features

1. **Protocol changes**: Update `packages/protocol/src/schemas.ts` first
2. **Engine interface**: If feature affects engine contract, update `packages/engine/src/types.ts`
3. **Implementation**: Add to `packages/core/` or appropriate package
4. **Tests**: Write contract test, then implementation
5. **Docs**: Update relevant ADR if architectural impact

### Security Considerations

Before making changes that affect security boundaries:
1. Review `docs/adr/006-network-egress-policy-ssrf.md`
2. Review `docs/threat-model.md`
3. Consider SSRF, prompt injection, secret exfiltration, cross-tenant leakage
4. Add security tests for the threat model

## Important File Locations

- **Protocol schemas**: `packages/protocol/src/schemas.ts`
- **Engine interface**: `packages/engine/src/types.ts`
- **Session coordination**: `packages/core/src/session-coordinator.ts`
- **FakeEngine**: `packages/testkit/src/fake-engine.ts`
- **Technical design**: `docs/technical-design.md` (detailed task breakdown)
- **MVP spec**: `agentbrowser-mvp-spec.md` (complete product specification)

## Phase Status

The MVP (TD-001..TD-026, `docs/technical-design.md`) is complete and shipped
(2026-08); releases are cut from `main` (v1.x). Post-MVP work is tracked in
`docs/td/` (TD-BROWSER-5..9) and summarized in `CHANGELOG.md`.

## Debugging Tips

### View Test Output

Tests use Vitest. For detailed output:
```bash
pnpm --filter <package-name> test --reporter=verbose
```

### Check TypeScript Types

```bash
pnpm -r type-check
```

### Run FakeEngine Directly

The FakeEngine can be used for rapid iteration without launching Chromium:
```typescript
import { FakeEngine } from '@agentbrowser/testkit';

const engine = new FakeEngine();
const session = await engine.createSession({});
// ... test without browser overhead
```

## Common Pitfalls

1. **Importing Playwright types in engine-neutral packages**: Never import from `playwright` in `packages/protocol/`, `packages/engine/`, or `packages/core/`. All Playwright code lives in `packages/engine-playwright/`.

2. **Exposing internal implementation**: Public API surfaces should use types from `@agentbrowser/protocol`, not internal engine types.

3. **Silent fallback**: If an engine lacks a capability, return a typed error or capability check, don't silently fail or use a workaround.

4. **Missing staleness checks**: Actions must verify page revision before executing. Never auto-retry on `STALE_TARGET` errors.

5. **Secret leakage**: Sensitive values must be redacted from logs, traces, and error messages. Use `SecretManager` (`packages/core/src/secret-manager.ts`).

## Related Documentation

- **README.md**: Project overview and quick start
- **docs/technical-design.md**: Detailed implementation plan with task breakdown
- **docs/implementation-roadmap.md**: Historical MVP planning record (progress history: docs/phase1-progress.md; current status: CHANGELOG.md)
- **docs/adr/*.md**: Architecture decision records
- **agentbrowser-mvp-spec.md**: Complete MVP specification with principles and invariants

## Distributed binary (Homebrew)

The MCP server ships as a self-contained binary via `anvai-labs/tap/agentbrowser`
(see [TD-BROWSER-5](docs/td/TD-BROWSER-5-single-binary-mcp-distribution.md) and
the release workflow's target matrix). Consumer wiring instructions live in the
README's "Consuming as an MCP server" section and are printed as brew caveats
by the tap's formula — keep all three in sync when the server's env contract
(`AGENTBROWSER_BASE_URL`, `AGENTBROWSER_API_KEY`) changes.
