# ADR-002: Engine-Neutral Public Protocol and Adapter Contract

**Status:** Accepted
**Context:** 2025-01-23
**Superseded by:** N/A

## Context

AgentBrowser plans to support multiple browser engines over time:
1. Playwright Chromium (MVP)
2. Remote Chromium via CDP
3. Obscura (experimental Rust engine)
4. Custom Rust-native engine (future)

Without a stable engine-neutral boundary:
- Public API would drift to match Playwright's capabilities
- Engine changes would break all client code
- No way to offer different capabilities per deployment
- Cannot A/B test engines for cost/performance

The protocol must remain stable while engines evolve underneath.

## Decision

**Define a versioned, engine-neutral `BrowserEngine` interface as the sole public contract.**

### Key principles

1. **Schemas are source of truth**: JSON Schema defines all request/response types
2. **Capability discovery**: Engines advertise what they support
3. **No Playwright types in public API**: `BrowserEngine` hides implementation
4. **Versioned protocol**: `/v1/` URL space, versioned schemas
5. **Contract tests**: All engines must pass the same test suite

## Consequences

### Positive
- **Engine agility**: Can swap engines without client changes
- **Capability transparency**: Clients know what's available per deployment
- **Testing parity**: Contract tests validate every engine equally
- **Clear upgrade path**: Protocol versioning allows breaking changes

### Negative
- **Abstraction overhead**: Must normalize behavior across engines
- **Capability lowest-common-denominator**: Can only expose what all engines support
- **Testing burden**: Must maintain contract suite for every engine

### Trade-offs
- Accept abstraction complexity to enable engine flexibility
- Version the protocol explicitly when capabilities need to expand
- Allow engine-specific behavior only through capability flags

## Rationale

### Principles

1. **Protocol over implementation**: Public behavior defined by schemas, not code
2. **Stability for clients**: Protocol changes only when necessary and versioned
3. **Replaceable backend**: Engine is an implementation detail
4. **Testability**: Contract tests ensure all engines meet same bar

### Why this matters for agent use case

Agents need:
- **Predictable behavior**: Same semantic action produces same result regardless of engine
- **Capability awareness**: Agent planner knows what's available
- **Version stability**: Agent code shouldn't break when backend upgrades
- **Observability**: Can measure engine performance for routing decisions

### Alternative considered: Expose Playwright types directly
**Rejected** because:
- Locks entire ecosystem to Playwright's API design
- Cannot adopt non-Playwright engines without breaking clients
- Playwright API is browser-focused, not agent-focused
- No way to evolve agent-specific features

### Alternative considered: Separate protocols per engine
**Rejected** because:
- Fragmented client ecosystem
- No standard way to compare or route between engines
- Amplifies testing and documentation burden
- Defeats the goal of engine flexibility

## Related Decisions

- **ADR-001**: TypeScript Playwright MVP - first implementation of this contract
- **ADR-010**: Rust engine gated by benchmarks - validates this architecture
- **Spec Section 8**: Engine-neutral contract definition

## Implementation Notes

### `BrowserEngine` interface (simplified)

```typescript
interface BrowserEngine {
  readonly name: string;
  readonly version: string;
  capabilities(): Promise<EngineCapabilities>;
  createSession(options: EngineSessionOptions): Promise<EngineSession>;
  close(): Promise<void>;
}

interface EngineCapabilities {
  supportsPdf: boolean;
  supportsScreenshots: boolean;
  supportsDownloads: boolean;
  supportsAccessibilityTree: boolean;
  supportsCdp: boolean;
  supportedObservationModes: ObservationMode[];
  supportedActionTypes: ActionType[];
}
```

### Protocol versioning
- Schema files in `packages/protocol/schemas/v1/`
- OpenAPI generated from schemas
- Breaking changes create `/v2/` with both supported during transition
- Deprecation period minimum 6 months for major versions

### Capability negotiation
```json
POST /v1/sessions
{
  "engine": "auto",  // or "playwright-chromium", "obscura", etc.
  "requireCapabilities": ["accessibilityTree", "screenshots"]
}
```

Response includes what engine was selected and its capabilities:

```json
{
  "sessionId": "ses_01...",
  "engine": {
    "name": "playwright-chromium",
    "version": "1.40.0",
    "capabilities": { ... }
  }
}
```

### Contract test requirements
- Every engine must pass `@testkit/contract` suite
- Tests use only `BrowserEngine` interface, never concrete types
- Fixture sites verify: navigation, observation, actions, extraction, crashes
- No engine-specific workarounds in test suite

### Validation criteria
- Can implement a `FakeEngine` that passes contract tests
- PlaywrightEngine and FakeEngine have identical test results
- No test imports from `engine-playwright` package
- Protocol package compiles with zero engine dependencies
