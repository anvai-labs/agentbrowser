# ADR-001: TypeScript Control Plane and Playwright Chromium MVP

**Status:** Accepted
**Context:** 2025-01-23
**Superseded by:** N/A

## Context

AgentBrowser needs to validate the agent-browser product concept quickly while maintaining a clear path to a native Rust engine. The project must choose an initial technology stack that:

1. Provides fastest path to working MVP
2. Enables real-world web compatibility immediately
3. Allows validation of the agent-facing abstraction
4. Supports future replacement of the browser engine
5. Maintains type safety across the entire stack

The browser engine market has mature solutions (Chromium, Firefox, WebKit) and emerging Rust-native projects (Obscura, Blitz) at varying maturity levels.

## Decision

**Use TypeScript for the entire control plane and public API, with Playwright + Chromium as the MVP browser engine.**

### TypeScript for:
- Public API and REST service
- Agent action model and session orchestration
- Policy enforcement and observation normalization
- TypeScript SDK
- MCP server implementation
- All protocol schemas and type definitions

### Playwright + Chromium for:
- Browser engine backend implementation
- Immediate real-web compatibility
- Mature auto-waiting and isolation primitives
- Built-in tracing, downloads, screenshots
- Accessibility tree support
- High-quality TypeScript API

## Consequences

### Positive
- **Fastest MVP path**: Playwright provides working browser automation immediately
- **Type safety end-to-end**: Shared types between server, SDK, and protocol
- **Web compatibility**: Chromium renders the real web as agents will encounter it
- **Excellent tooling**: TypeScript ecosystem, Playwright Inspector, tracing
- **Clear upgrade path**: `BrowserEngine` interface isolates Playwright dependency

### Negative
- **Node.js runtime overhead**: Event-loop overhead vs native Rust
- **Not a long-term engine solution**: Chromium is too heavy for cost-effective scale
- **Native dependency management**: Chromium binary distribution and updates

### Trade-offs
- Accept runtime overhead in MVP to validate product concept
- Use TypeScript productivity now, pay Rust migration cost later only if justified
- Chromium compatibility now, defer native engine until measurements prove necessity

## Rationale

This decision follows these principles:

1. **Validate the product, not the engine**: The innovation is agent-first browser interaction, not a new rendering engine
2. **Replaceable backend**: The `BrowserEngine` adapter boundary makes Playwright a temporary implementation detail
3. **Type safety as a dependency**: Shared TypeScript types prevent protocol drift between server and SDKs
4. **Real-world compatibility**: Chromium passes the "it works on actual websites" test immediately

### Alternative considered: Pure Rust from start
**Rejected** because:
- Web compatibility is enormous (HTML, DOM, CSS, JavaScript, networking, CDP)
- Would delay MVP validation by months
- Browser engines are complex; introducing bugs defeats agent reliability goals
- Can measure if Chromium is the bottleneck after product validation

### Alternative considered: Python
**Rejected** because:
- Weaker type guarantees for protocol stability
- Playwright protocol is not native to Python (wraps Node)
- Less suited for long-term service architecture

## Related Decisions

- **ADR-002**: Engine-neutral public protocol - enables this choice
- **ADR-010**: Rust engine investment gated by benchmarks - defines exit criteria
- **Spec Section 2**: Language and architecture decision matrix

## Implementation Notes

### Requirements
1. All Playwright types are internal to `engine-playwright` package
2. Public API surface exposes only `BrowserEngine` interface
3. No Playwright `Page`, `Locator`, or `ElementHandle` in public types
4. Package structure: `packages/engine-playwright/` contains all Playwright code
5. Protocol package (`packages/protocol/`) has zero Playwright imports

### Validation criteria
- Contract tests pass against both FakeEngine and PlaywrightEngine
- TypeScript SDK has zero dependency on Playwright types
- Can swap `engine-playwright` for a mock in tests without compile errors
- Public API changes are source-breaking only when protocol schemas change

### Migration path (if Rust engine adopted)
1. Implement `rust-engine` package with `BrowserEngine` interface
2. Add routing logic in session coordinator
3. Phase out Playwright for supported workloads
4. TypeScript control plane remains unchanged
