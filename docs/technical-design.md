# AgentBrowser Technical Design and Implementation Plan

**Version:** 1.0
**Status:** Ready for implementation
**Last Updated:** 2025-01-23

## Overview

This document provides the technical design and implementation roadmap for AgentBrowser MVP. Tasks are organized in dependency order with critical path identification for TDD-based implementation.

## Implementation Strategy

### Development Principles

1. **Test-Driven Development (TDD)**: Write tests before implementation
2. **Vertical Slices**: Deliver end-to-end functionality, not layers
3. **Contract-First**: Define schemas and interfaces before code
4. **Safety-Invariant Tests**: Security and policy tests are primary, not afterthoughts
5. **Incremental Delivery**: Each phase produces working, demoable software

### Technology Stack

- **Language**: TypeScript 5.8+ (strict mode)
- **Runtime**: Node.js LTS (pinned in `.tool-versions`)
- **Package Manager**: pnpm (monorepo)
- **Browser Engine**: Playwright + Chromium (MVP)
- **Server**: Fastify
- **Database**: SQLite (WAL mode)
- **Testing**: Vitest (unit/contract), Playwright (E2E)
- **Formatting**: Biome
- **Container**: Docker (multi-stage, non-root)

---

## Phase 0: Repository Foundation and Contracts (1-2 days)

### Critical Path Tasks

#### TD-001: Initialize Monorepo and CI Infrastructure

**Priority:** P0 (BLOCKER)
**Dependencies:** None
**Estimated:** 4 hours

**Description:**
Set up pnpm workspace with package structure, TypeScript configuration, and CI pipeline.

**Tasks:**
- [ ] Initialize pnpm workspace with `apps/` and `packages/` structure
- [ ] Create `packages/protocol/`, `packages/core/`, `packages/engine/`, `packages/testkit/`
- [ ] Configure TypeScript (strict mode, noUncheckedIndexedAccess, exactOptionalPropertyTypes)
- [ ] Set up Biome for formatting/linting
- [ ] Configure GitHub Actions CI for type-check and lint
- [ ] Add `.tool-versions` with Node.js LTS pin

**Tests:**
```typescript
// test: monorepo builds
import { execSync } from 'child_process';

describe('Monorepo', () => {
  it('should build all packages', () => {
    expect(() => execSync('pnpm -r build')).not.toThrow();
  });

  it('should type-check all packages', () => {
    expect(() => execSync('pnpm -r type-check')).not.toThrow();
  });
});
```

**Acceptance:**
- [ ] `pnpm install` succeeds without errors
- [ ] `pnpm -r build` completes
- [ ] `pnpm -r type-check` passes
- [ ] CI runs on push

---

#### TD-002: Define Protocol Schemas and Types

**Priority:** P0 (BLOCKER)
**Dependencies:** TD-001
**Estimated:** 8 hours

**Description:**
Create JSON Schema definitions for all v1 API requests/responses using TypeBox.

**Tasks:**
- [ ] Define error taxonomy schema
- [ ] Define session creation/request schemas
- [ ] Define navigation request/response schemas
- [ ] Define observation request/response schemas
- [ ] Define all action type schemas (click, fill, select, etc.)
- [ ] Define extraction schemas
- [ ] Define artifact schemas
- [ ] Generate TypeScript types from schemas
- [ ] Write schema validation tests

**Tests:**
```typescript
// packages/protocol/test/schemas.test.ts
import { validateSessionRequest } from './schemas';

describe('Session Request Schema', () => {
  it('should validate valid session request', () => {
    const result = validateSessionRequest({
      engine: 'playwright-chromium',
      ttlMs: 900000,
      policy: { allowedHosts: ['example.com'] }
    });
    expect(result.success).toBe(true);
  });

  it('should reject invalid TTL', () => {
    const result = validateSessionRequest({
      engine: 'playwright-chromium',
      ttlMs: -1,  // Invalid
      policy: { allowedHosts: ['example.com'] }
    });
    expect(result.success).toBe(false);
  });

  it('should reject empty allowed hosts', () => {
    const result = validateSessionRequest({
      engine: 'playwright-chromium',
      ttlMs: 900000,
      policy: { allowedHosts: [] }  // Must have at least one
    });
    expect(result.success).toBe(false);
  });
});
```

**Acceptance:**
- [ ] All schemas compile with TypeBox
- [ ] TypeScript types generated
- [ ] Schema validation tests pass
- [ ] Schemas exported from `packages/protocol`

---

#### TD-003: Define BrowserEngine Interface

**Priority:** P0 (BLOCKER)
**Dependencies:** TD-002
**Estimated:** 6 hours

**Description:**
Define the engine-neutral `BrowserEngine` interface that all engine implementations must follow.

**Tasks:**
- [ ] Define `BrowserEngine` interface
- [ ] Define `EngineCapabilities` interface
- [ ] Define `EngineSession` interface
- [ ] Define `EnginePage` interface
- [ ] Define all request/response types
- [ ] Define error types
- [ ] Write interface documentation
- [ ] Create `packages/engine/` with interface definitions

**Tests:**
```typescript
// packages/engine/test/contract.test.ts
import type { BrowserEngine } from '../types';

// Ensure interface is implemented correctly
describe('BrowserEngine Contract', () => {
  it('should require name and version', () => {
    const engine: BrowserEngine = {
      name: 'test',
      version: '1.0.0',
      capabilities(): Promise<EngineCapabilities> {
        return Promise.resolve({
          supportsScreenshots: true,
          supportsPdf: false,
          // ... other capabilities
        });
      },
      createSession(): Promise<EngineSession> {
        throw new Error('Not implemented');
      },
      close(): Promise<void> {
        return Promise.resolve();
      }
    };

    expect(engine.name).toBeDefined();
    expect(engine.version).toBeDefined();
  });
});
```

**Acceptance:**
- [ ] `BrowserEngine` interface defined
- [ ] `EngineCapabilities` defined
- [ ] All required methods documented
- [ ] TypeScript compiles without errors
- [ ] Interface exported from `packages/engine`

---

#### TD-004: Implement FakeEngine for Contract Testing

**Priority:** P0 (BLOCKER)
**Dependencies:** TD-003
**Estimated:** 8 hours

**Description:**
Create in-memory fake implementation of `BrowserEngine` for contract testing and development.

**Tasks:**
- [ ] Implement `FakeEngine` class
- [ ] Implement `FakeSession` class
- [ ] Implement `FakePage` class
- [ ] Store state in memory (no browser needed)
- [ ] Simulate navigation, observation, actions
- [ ] Generate deterministic fake observations
- [ ] Support element refs and revision tracking
- [ ] Write contract test suite using fake engine

**Tests:**
```typescript
// packages/testkit/test/fake-engine.test.ts
import { FakeEngine } from '../fake-engine';

describe('FakeEngine', () => {
  let engine: FakeEngine;

  beforeEach(() => {
    engine = new FakeEngine();
  });

  it('should create a session', async () => {
    const session = await engine.createSession({
      viewport: { width: 1280, height: 720 }
    });

    expect(session.id).toBeDefined();
    expect(engine.sessions.has(session.id)).toBe(true);
  });

  it('should navigate to a URL', async () => {
    const session = await engine.createSession();
    const page = await session.newPage();
    await page.navigate({ url: 'https://example.com' });

    const state = await page.observe({ mode: 'interactive' });
    expect(state.url).toBe('https://example.com');
    expect(state.revision).toBe(1);
  });

  it('should generate element refs', async () => {
    const session = await engine.createSession();
    const page = await session.newPage();
    await page.navigate({ url: 'https://example.com' });

    const state = await page.observe({ mode: 'interactive' });
    expect(state.elements.length).toBeGreaterThan(0);
    expect(state.elements[0].ref).toMatch(/^e\d_\d+$/);
  });
});
```

**Acceptance:**
- [ ] `FakeEngine` implements `BrowserEngine`
- [ ] Can create sessions and pages
- [ ] Can navigate and observe
- [ ] Can execute basic actions
- [ ] Element refs work correctly
- [ ] Revision tracking works

---

#### TD-005: Write Contract Test Suite

**Priority:** P0 (BLOCKER)
**Dependencies:** TD-004
**Estimated:** 12 hours

**Description:**
Create comprehensive contract tests that any `BrowserEngine` implementation must pass.

**Tasks:**
- [ ] Write session lifecycle tests
- [ ] Write navigation tests
- [ ] Write observation tests
- [ ] Write action tests (click, fill, select, scroll)
- [ ] Write element ref tests
- [ ] Write revision staleness tests
- [ ] Write error handling tests
- [ ] Write capability tests
- [ ] Create test fixture pages

**Tests:**
```typescript
// packages/testkit/test/contract/navigation.test.ts
import { runContractSuite } from '../suite';

describe('BrowserEngine Contract: Navigation', () => {
  runContractSuite('navigation', async (engine) => {
    it('should navigate to URL', async () => {
      const session = await engine.createSession();
      const page = await session.newPage();

      const result = await page.navigate({
        url: 'https://example.com',
        waitUntil: 'load'
      });

      expect(result.status).toBe('success');
      expect(result.url).toBe('https://example.com');
    });

    it('should handle redirects', async () => {
      const session = await engine.createSession();
      const page = await session.newPage();

      const result = await page.navigate({
        url: 'https://httpbin.org/redirect-to?url=https://example.com',
        waitUntil: 'load'
      });

      expect(result.redirectChain.length).toBeGreaterThan(0);
      expect(result.url).toBe('https://example.com');
    });
  });
});
```

**Acceptance:**
- [ ] Contract suite runs on `FakeEngine`
- [ ] All tests pass on `FakeEngine`
- [ ] Tests cover all engine methods
- [ ] Tests verify invariants
- [ ] Tests are deterministic

---

#### TD-006: Create Threat Model Document

**Priority:** P0 (SAFETY)
**Dependencies:** None (parallel)
**Estimated:** 6 hours

**Description:**
Document security threats and mitigation strategies for AgentBrowser.

**Tasks:**
- [ ] Identify SSRF attack vectors
- [ ] Identify DNS rebinding attacks
- [ ] Identify data exfiltration vectors
- [ ] Identify resource exhaustion attacks
- [ ] Document mitigation strategies
- [ ] Create security test scenarios
- [ ] Document compliance requirements

**Output:**
- [ ] `docs/threat-model.md`
- [ ] Security test scenarios documented
- [ ] Mitigation strategies documented

**Acceptance:**
- [ ] Threat model reviewed
- [ ] All major threats documented
- [ ] Mitigation strategies identified

---

### Phase 0 Exit Criteria

- [ ] Monorepo builds and type-checks
- [ ] All protocol schemas defined and tested
- [ ] `BrowserEngine` interface defined
- [ ] `FakeEngine` passes contract tests
- [ ] Threat model documented
- [ ] CI passes on main branch

**Estimated Phase Duration:** 1-2 days

---

## Phase 1: Core Functionality - Vertical Slice (3-5 days)

### Critical Path Tasks

#### TD-007: Implement Session Coordinator

**Priority:** P0 (BLOCKER)
**Dependencies:** TD-005 (contract tests)
**Estimated:** 12 hours

**Description:**
Implement session lifecycle management with state machine and cleanup.

**Tasks:**
- [ ] Define session states enum
- [ ] Implement session state machine
- [ ] Implement session creation
- [ ] Implement session cleanup
- [ ] Implement TTL enforcement
- [ ] Implement idle timeout
- [ ] Implement session storage (SQLite)
- [ ] Write session lifecycle tests
- [ ] Write cleanup verification tests

**Tests:**
```typescript
// packages/core/test/session-coordinator.test.ts
import { SessionCoordinator } from '../session-coordinator';

describe('SessionCoordinator', () => {
  let coordinator: SessionCoordinator;

  beforeEach(() => {
    coordinator = new SessionCoordinator();
  });

  it('should create session in READY state', async () => {
    const session = await coordinator.create({
      engine: 'playwright-chromium',
      ttlMs: 900000
    });

    expect(session.state).toBe('READY');
    expect(session.createdAt).toBeDefined();
  });

  it('should transition to ACTIVE on first action', async () => {
    const session = await coordinator.create({});
    // Perform action
    await session.performAction({ type: 'navigate' });

    expect(session.state).toBe('ACTIVE');
  });

  it('should expire after TTL', async () => {
    const session = await coordinator.create({
      ttlMs: 100  // Short TTL for testing
    });

    await new Promise(resolve => setTimeout(resolve, 150));

    expect(session.state).toBe('EXPIRED');
  });

  it('should cleanup on close', async () => {
    const session = await coordinator.create({});
    await session.close('user_requested');

    expect(session.state).toBe('CLOSED');
    // Verify cleanup
    await expect(coordinator.get(session.id)).rejects.toThrow();
  });
});
```

**Acceptance:**
- [ ] Session state machine works
- [ ] TTL enforcement works
- [ ] Idle timeout works
- [ ] Cleanup verification passes
- [ ] Sessions persist to SQLite

---

#### TD-008: Implement Playwright Chromium Engine

**Priority:** P0 (BLOCKER)
**Dependencies:** TD-007, TD-005
**Estimated:** 16 hours

**Description:**
Implement production `BrowserEngine` using Playwright and Chromium.

**Tasks:**
- [ ] Install Playwright and Chromium
- [ ] Implement `PlaywrightChromiumEngine` class
- [ ] Implement session creation with BrowserContext
- [ ] Implement navigation with wait conditions
- [ ] Implement observation with accessibility tree
- [ ] Implement element ref generation
- [ ] Implement action execution
- [ ] Implement screenshot capture
- [ ] Implement PDF generation
- [ ] Write engine-specific tests

**Tests:**
```typescript
// packages/engine-playwright/test/engine.test.ts
import { PlaywrightChromiumEngine } from '../engine';

describe('PlaywrightChromiumEngine', () => {
  let engine: PlaywrightChromiumEngine;

  beforeEach(async () => {
    engine = new PlaywrightChromiumEngine();
  });

  afterEach(async () => {
    await engine.close();
  });

  it('should pass contract tests', async () => {
    await runContractTests(engine);
  });

  it('should launch Chromium', async () => {
    const capabilities = await engine.capabilities();
    expect(capabilities.supportsScreenshots).toBe(true);
    expect(capabilities.supportsPdf).toBe(true);
  });

  it('should create isolated session', async () => {
    const session1 = await engine.createSession({});
    const session2 = await engine.createSession({});

    // Sessions should be isolated
    const page1 = await session1.newPage();
    await page1.navigate({ url: 'https://example.com' });

    const page2 = await session2.newPage();
    const state2 = await page2.observe({ mode: 'interactive' });

    expect(state2.url).not.toBe('https://example.com');
  });
});
```

**Acceptance:**
- [ ] Implements `BrowserEngine` interface
- [ ] Passes all contract tests
- [ ] Can navigate real websites
- [ ] Can generate semantic observations
- [ ] Can execute actions via refs
- [ ] Can capture screenshots
- [ ] Sessions are isolated

---

#### TD-009: Implement Observation Normalization

**Priority:** P0 (BLOCKER)
**Dependencies:** TD-008
**Estimated:** 12 hours

**Description:**
Convert Playwright page state into engine-neutral semantic observations.

**Tasks:**
- [ ] Implement accessibility tree parsing
- [ ] Implement element ref generation
- [ ] Implement semantic fingerprinting
- [ ] Implement observation modes (interactive, content, accessibility)
- [ ] Implement truncation logic
- [ ] Implement change tracking
- [ ] Write observation tests

**Tests:**
```typescript
// packages/core/test/observation.test.ts
import { ObservationBuilder } from '../observation';

describe('Observation Builder', () => {
  it('should build interactive observation', async () => {
    const builder = new ObservationBuilder();
    const observation = await builder.buildInteractive(page);

    expect(observation.mode).toBe('interactive');
    expect(observation.elements.length).toBeGreaterThan(0);
    expect(observation.elements[0].ref).toMatch(/^e\d+_\d+$/);
  });

  it('should prioritize important elements', async () => {
    const builder = new ObservationBuilder();
    const observation = await builder.buildInteractive(page, {
      maxElements: 10
    });

    // Should prioritize focused element
    const focusedIndex = observation.elements.findIndex(e => e.focused);
    expect(focusedIndex).toBeGreaterThanOrEqual(0);
    expect(focusedIndex).toBeLessThan(3);  // Among first 3
  });

  it('should detect stale refs', async () => {
    const builder = new ObservationBuilder();
    const obs1 = await builder.build(page);

    // Modify page
    await page.click('button');

    const obs2 = await builder.build(page);
    expect(obs2.revision).not.toBe(obs1.revision);
  });
});
```

**Acceptance:**
- [ ] Observations include semantic roles
- [ ] Element refs are stable
- [ ] Truncation is deterministic
- [ ] Revision tracking works
- [ ] Change detection works

---

#### TD-010: Implement Action Execution with Refs

**Priority:** P0 (BLOCKER)
**Dependencies:** TD-009
**Estimated:** 12 hours

**Description:**
Execute actions through element refs with staleness detection.

**Tasks:**
- [ ] Implement ref resolution
- [ ] Implement fingerprint verification
- [ ] Implement staleness detection
- [ ] Implement action types (click, fill, select, scroll, press)
- [ ] Implement post-action observation
- [ ] Implement error handling
- [ ] Write action tests

**Tests:**
```typescript
// packages/core/test/actions.test.ts
import { ActionExecutor } from '../action-executor';

describe('Action Executor', () => {
  it('should click by ref', async () => {
    const obs = await observe(page);
    const buttonRef = obs.elements.find(e => e.role === 'button')?.ref;

    await executeAction(page, {
      type: 'click',
      target: { ref: buttonRef }
    });
  });

  it('should detect stale ref', async () => {
    const obs1 = await observe(page);
    const ref = obs1.elements[0].ref;

    // Modify page
    await page.click('button');

    await expect(
      executeAction(page, {
        type: 'click',
        target: { ref: ref },
        expectedRevision: obs1.revision
      })
    ).rejects.toThrow('STALE_TARGET');
  });

  it('should fill sensitive values', async () => {
    const obs = await observe(page);
    const inputRef = obs.elements.find(e => e.role === 'textbox')?.ref;

    await executeAction(page, {
      type: 'fill',
      target: { ref: inputRef },
      value: 'secret',
      sensitive: true
    });

    // Verify value not in logs or traces
  });
});
```

**Acceptance:**
- [ ] All action types work via refs
- [ ] Stale refs are detected
- [ ] Fingerprints are verified
- [ ] Post-action observations returned
- [ ] Sensitive values are masked

---

#### TD-011: Implement REST API with Fastify

**Priority:** P0 (BLOCKER)
**Dependencies:** TD-010
**Estimated:** 12 hours

**Description:**
Implement REST/JSON API serving session and action endpoints.

**Tasks:**
- [ ] Set up Fastify server
- [ ] Implement session creation endpoint
- [ ] Implement session query endpoint
- [ ] Implement session deletion endpoint
- [ ] Implement observe endpoint
- [ ] Implement actions endpoint
- [ ] Implement error envelope formatting
- [ ] Implement request validation
- [ ] Write API tests

**Tests:**
```typescript
// apps/server/test/api/sessions.test.ts
import { buildServer } from '../../server';

describe('Sessions API', () => {
  let server: FastifyInstance;

  beforeEach(() => {
    server = buildServer();
  });

  afterEach(async () => {
    await server.close();
  });

  it('should create session', async () => {
    const response = await server.inject({
      method: 'POST',
      url: '/v1/sessions',
      payload: {
        engine: 'playwright-chromium',
        ttlMs: 900000
      }
    });

    expect(response.statusCode).toBe(201);
    expect(response.json().sessionId).toBeDefined();
  });

  it('should validate session request', async () => {
    const response = await server.inject({
      method: 'POST',
      url: '/v1/sessions',
      payload: {
        engine: 'playwright-chromium',
        ttlMs: -1  // Invalid
      }
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('INVALID_REQUEST');
  });
});
```

**Acceptance:**
- [ ] All REST endpoints work
- [ ] Request validation works
- [ ] Error envelopes formatted correctly
- [ ] API tests pass

---

#### TD-012: Implement TypeScript SDK

**Priority:** P0 (BLOCKER)
**Dependencies:** TD-011
**Estimated:** 8 hours

**Description:**
Create TypeScript client SDK for AgentBrowser API.

**Tasks:**
- [ ] Create SDK client class
- [ ] Implement session methods
- [ ] Implement navigation methods
- [ ] Implement observation methods
- [ ] Implement action methods
- [ ] Implement error handling
- [ ] Write SDK tests

**Tests:**
```typescript
// packages/sdk-typescript/test/client.test.ts
import { AgentBrowserClient } from '../client';

describe('AgentBrowser SDK', () => {
  let client: AgentBrowserClient;

  beforeEach(() => {
    client = new AgentBrowserClient({
      baseUrl: 'http://localhost:3000'
    });
  });

  it('should create session', async () => {
    const session = await client.sessions.create({
      engine: 'playwright-chromium'
    });

    expect(session.id).toBeDefined();
  });

  it('should navigate and observe', async () => {
    const session = await client.sessions.create({});
    const page = await session.pages.create();

    await page.navigate('https://example.com');
    const obs = await page.observe();

    expect(obs.url).toBe('https://example.com');
    expect(obs.elements.length).toBeGreaterThan(0);
  });
});
```

**Acceptance:**
- [ ] SDK compiles
- [ ] All methods work
- [ ] Error handling works
- [ ] TypeScript types are correct

---

#### TD-013: Implement CLI

**Priority:** P1 (IMPORTANT)
**Dependencies:** TD-012
**Estimated:** 8 hours

**Description:**
Create command-line interface for AgentBrowser.

**Tasks:**
- [ ] Create CLI with commander.js
- [ ] Implement session create command
- [ ] Implement navigate command
- [ ] Implement observe command
- [ ] Implement action commands
- [ ] Implement screenshot command
- [ ] Write CLI tests

**Acceptance:**
- [ ] CLI creates sessions
- [ ] CLI navigates pages
- [ ] CLI executes actions
- [ ] CLI captures screenshots

---

### Phase 1 Exit Criteria

- [ ] Can create session via REST/SDK/CLI
- [ ] Can navigate to allowed URLs
- [ ] Can get semantic observations
- [ ] Can execute actions via refs
- [ ] Can capture screenshots
- [ ] All tests pass
- [ ] 10 deterministic workflows complete successfully

**Estimated Phase Duration:** 3-5 days

---

## Phase 2: Safety and Agent Quality (4-6 days)

### Critical Path Tasks

#### TD-014: Implement Network Egress Policy

**Priority:** P0 (SAFETY)
**Dependencies:** TD-008 (Playwright engine)
**Estimated:** 16 hours

**Description:**
Implement network policy enforcement with SSRF defenses.

**Tasks:**
- [ ] Implement policy rule engine
- [ ] Implement IP blocklist (loopback, private, metadata)
- [ ] Implement DNS resolution checks
- [ ] Implement redirect validation
- [ ] Implement response size limits
- [ ] Implement request logging
- [ ] Write security tests

**Tests:**
```typescript
// packages/policy/test/network.test.ts
import { NetworkPolicy } from '../network-policy';

describe('Network Policy', () => {
  it('should block loopback addresses', async () => {
    const policy = new NetworkPolicy({ blockLoopback: true });

    await expect(
      policy.checkRequest({ hostname: 'localhost' })
    ).rejects.toThrow('POLICY_DENIED');

    await expect(
      policy.checkRequest({ hostname: '127.0.0.1' })
    ).rejects.toThrow('POLICY_DENIED');
  });

  it('should block cloud metadata', async () => {
    const policy = new NetworkPolicy({ blockMetadata: true });

    await expect(
      policy.checkRequest({ hostname: '169.254.169.254' })
    ).rejects.toThrow('POLICY_DENIED');
  });

  it('should enforce redirect limit', async () => {
    const policy = new NetworkPolicy({ maxRedirects: 3 });

    const requests = Array(5).fill(null).map((_, i) => ({
      url: `https://example.com/redirect${i}`
    }));

    await expect(
      policy.checkRedirectChain(requests)
    ).rejects.toThrow('MAX_REDIRECTS');
  });
});
```

**Acceptance:**
- [ ] Loopback blocked
- [ ] Private IPs blocked
- [ ] Metadata endpoints blocked
- [ ] Redirects limited
- [ ] Response sizes limited
- [ ] All requests logged
- [ ] Security tests pass

---

#### TD-015: Implement Approval Gates

**Priority:** P0 (SAFETY)
**Dependencies:** TD-010 (actions)
**Estimated:** 12 hours

**Description:**
Implement approval workflow for high-risk actions.

**Tasks:**
- [ ] Implement action classification
- [ ] Implement approval token generation
- [ ] Implement approval token validation
- [ ] Implement approval API
- [ ] Integrate with action executor
- [ ] Write approval tests

**Tests:**
```typescript
// packages/core/test/approvals.test.ts
import { ApprovalGate } from '../approval-gate';

describe('Approval Gates', () => {
  it('should require approval for transactions', async () => {
    const gate = new ApprovalGate();

    const action = {
      type: 'click',
      effect: 'transaction'
    };

    const required = await gate.isApprovalRequired(action);
    expect(required).toBe(true);
  });

  it('should not require approval for reads', async () => {
    const gate = new ApprovalGate();

    const action = {
      type: 'observe',
      effect: 'read'
    };

    const required = await gate.isApprovalRequired(action);
    expect(required).toBe(false);
  });

  it('should validate approval tokens', async () => {
    const gate = new ApprovalGate();

    const token = await gate.generateApprovalToken({
      sessionId: 'ses_01',
      action: { type: 'click' }
    });

    const valid = await gate.validateApprovalToken(token, {
      sessionId: 'ses_01',
      action: { type: 'click' }
    });

    expect(valid).toBe(true);
  });

  it('should invalidate used tokens', async () => {
    const gate = new ApprovalGate();
    const token = await gate.generateApprovalToken({});

    await gate.useApprovalToken(token);

    await expect(
      gate.validateApprovalToken(token, {})
    ).rejects.toThrow('INVALID_TOKEN');
  });
});
```

**Acceptance:**
- [ ] Transactions require approval
- [ ] Read actions auto-approve
- [ ] Tokens are single-use
- [ ] Tokens expire
- [ ] Approvals logged

---

#### TD-016: Implement Secret-Safe Credential Handling

**Priority:** P0 (SAFETY)
**Dependencies:** TD-010 (fill actions)
**Estimated:** 8 hours

**Description:**
Implement secure credential injection with redaction.

**Tasks:**
- [ ] Implement secret reference resolution
- [ ] Implement credential injection at network boundary
- [ ] Implement secret redaction in logs
- [ ] Implement secret redaction in screenshots
- [ ] Write security tests

**Tests:**
```typescript
// packages/core/test/secrets.test.ts
import { SecretManager } from '../secret-manager';

describe('Secret Manager', () => {
  it('should resolve secret references', async () => {
    const manager = new SecretManager({
      'vault://tenant/login/password': 'secret123'
    });

    const value = await manager.resolve('vault://tenant/login/password');
    expect(value).toBe('secret123');
  });

  it('should redact secrets in logs', async () => {
    const manager = new SecretManager();

    const message = manager.redactSecrets({
      action: 'fill',
      value: 'secret123',
      sensitive: true
    });

    expect(message).not.toContain('secret123');
    expect(message).toContain('***');
  });

  it('should not leak secrets in errors', async () => {
    const manager = new SecretManager();

    const error = new Error('Failed with value: secret123');
    const safeError = manager.redactSecrets(error.message);

    expect(safeError).not.toContain('secret123');
  });
});
```

**Acceptance:**
- [ ] Secrets resolve from vault
- [ ] Secrets redacted in logs
- [ ] Secrets redacted in errors
- [ ] Secrets redacted in screenshots
- [ ] Security tests pass

---

#### TD-017: Implement Downloads and Artifacts

**Priority:** P1 (IMPORTANT)
**Dependencies:** TD-008 (Playwright engine)
**Estimated:** 12 hours

**Description:**
Implement file download handling and artifact storage.

**Tasks:**
- [ ] Implement download interception
- [ ] Implement artifact storage
- [ ] Implement artifact cleanup
- [ ] Implement artifact API
- [ ] Implement retention TTLs
- [ ] Write artifact tests

**Acceptance:**
- [ ] Downloads work when allowed
- [ ] Downloads blocked when disallowed
- [ ] Artifacts stored safely
- [ ] Artifacts expire after TTL
- [ ] Cleanup works

---

#### TD-018: Implement MCP Server

**Priority:** P0 (BLOCKER)
**Dependencies:** TD-010 (actions)
**Estimated:** 16 hours

**Description:**
Implement Model Context Protocol server with high-level tools.

**Tasks:**
- [ ] Set up MCP server framework
- [ ] Implement `browser_create` tool
- [ ] Implement `browser_navigate` tool
- [ ] Implement `browser_observe` tool
- [ ] Implement `browser_act` tool
- [ ] Implement `browser_extract` tool
- [ ] Implement `browser_screenshot` tool
- [ ] Implement `browser_close` tool
- [ ] Add untrusted content labels
- [ ] Write MCP tests

**Tests:**
```typescript
// apps/mcp/test/tools.test.ts
import { McpServer } from '../server';

describe('MCP Tools', () => {
  let server: McpServer;

  beforeEach(() => {
    server = new McpServer();
  });

  it('should create browser session', async () => {
    const result = await server.callTool('browser_create', {
      engine: 'playwright-chromium'
    });

    expect(result.sessionId).toBeDefined();
    expect(result._metadata.untrustedContent).toBe(false);
  });

  it('should mark webpage content as untrusted', async () => {
    const result = await server.callTool('browser_observe', {
      sessionId: 'ses_01'
    });

    expect(result._metadata.untrustedContent).toBe(true);
  });

  it('should require approval for transactions', async () => {
    const result = await server.callTool('browser_act', {
      sessionId: 'ses_01',
      action: { type: 'click', target: { ref: 'e1_1' } },
      context: { effect: 'transaction' }
    });

    expect(result.error.code).toBe('APPROVAL_REQUIRED');
  });
});
```

**Acceptance:**
- [ ] All 8 tools work
- [ ] Tools use refs (not selectors)
- [ ] High-risk actions require approval
- [ ] Content labeled untrusted
- [ ] MCP tests pass

---

#### TD-019: Implement Observation Diffs and Continuation

**Priority:** P1 (IMPORTANT)
**Dependencies:** TD-009 (observations)
**Estimated:** 8 hours

**Description:**
Implement diff-based observations and continuation cursors.

**Tasks:**
- [ ] Implement revision diffing
- [ ] Implement change detection
- [ ] Implement continuation cursors
- [ ] Implement incremental updates
- [ ] Write diff tests

**Acceptance:**
- [ ] Diffs show changes
- [ ] Continuation works
- [ ] Cursor-based pagination works

---

### Phase 2 Exit Criteria

- [ ] Network policy blocks SSRF
- [ ] Approvals required for high-risk actions
- [ ] Secrets redacted everywhere
- [ ] Downloads work with policy
- [ ] MCP server provides tools
- [ ] Security tests pass
- [ ] 45/50 benchmark tasks succeed

**Estimated Phase Duration:** 4-6 days

---

## Phase 3: Operability and Production Readiness (3-5 days)

### Critical Path Tasks

#### TD-020: Implement OpenTelemetry Tracing

**Priority:** P1 (IMPORTANT)
**Dependencies:** TD-007 (sessions)
**Estimated:** 8 hours

**Description:**
Implement distributed tracing with OpenTelemetry.

**Tasks:**
- [ ] Set up OpenTelemetry SDK
- [ ] Instrument session creation
- [ ] Instrument navigation
- [ ] Instrument observations
- [ ] Instrument actions
- [ ] Instrument policy checks
- [ ] Export traces to console (local)

**Acceptance:**
- [ ] Spans created for operations
- [ ] Trace context propagated
- [ ] No secrets in traces

---

#### TD-021: Implement Metrics and Logging

**Priority:** P1 (IMPORTANT)
**Dependencies:** TD-020
**Estimated:** 8 hours

**Description:**
Implement Prometheus metrics and structured logging.

**Tasks:**
- [ ] Implement Prometheus metrics
- [ ] Track active sessions
- [ ] Track latency percentiles
- [ ] Track error rates
- [ ] Implement structured logging
- [ ] Implement log redaction

**Acceptance:**
- [ ] Metrics endpoint works
- [ ] Logs are structured
- [ ] No secrets in logs

---

#### TD-022: Implement Docker Hardening

**Priority:** P0 (BLOCKER)
**Dependencies:** All previous
**Estimated:** 8 hours

**Description:**
Create production-ready Docker container.

**Tasks:**
- [ ] Create multi-stage Dockerfile
- [ ] Run as non-root user
- [ ] Read-only root filesystem
- [ ] Minimal base image
- [ ] Security scanning
- [ ] Write deployment tests

**Acceptance:**
- [ ] Container builds
- [ ] Runs as non-root
- [ ] Security scan passes
- [ ] Read-only filesystem

---

#### TD-023: Implement Worker Pool and Health Endpoints

**Priority:** P1 (IMPORTANT)
**Dependencies:** TD-022 (Docker)
**Estimated:** 8 hours

**Description:**
Implement worker pool and health checks.

**Tasks:**
- [ ] Implement worker pool
- [ ] Implement graceful shutdown
- [ ] Implement /health/live
- [ ] Implement /health/ready
- [ ] Implement /metrics endpoint
- [ ] Write health tests

**Acceptance:**
- [ ] Health endpoints work
- [ ] Worker pool scales
- [ ] Graceful shutdown works

---

#### TD-024: Implement Crash Recovery

**Priority:** P1 (IMPORTANT)
**Dependencies:** TD-008 (Playwright engine)
**Estimated:** 8 hours

**Description:**
Implement crash detection and recovery.

**Tasks:**
- [ ] Detect browser crashes
- [ ] Terminate affected sessions
- [ ] Log crash events
- [ ] Implement cleanup audit
- [ ] Write crash tests

**Acceptance:**
- [ ] Crashes detected
- [ ] Sessions terminated cleanly
- [ ] No leaked processes

---

#### TD-025: Create Benchmark and Soak Tests

**Priority:** P1 (IMPORTANT)
**Dependencies:** All previous
**Estimated:** 12 hours

**Description:**
Create performance benchmark and soak test suites.

**Tasks:**
- [ ] Create benchmark harness
- [ ] Measure session creation latency
- [ ] Measure observation latency
- [ ] Measure action latency
- [ ] Create soak test (1000 sessions)
- [ ] Create memory leak test
- [ ] Create cleanup test

**Acceptance:**
- [ ] Benchmarks run
- [ ] Soak test passes
- [ ] No memory leaks
- [ ] No process leaks

---

#### TD-026: Generate OpenAPI Documentation

**Priority:** P1 (IMPORTANT)
**Dependencies:** TD-011 (REST API)
**Estimated:** 4 hours

**Description:**
Generate OpenAPI specification from schemas.

**Tasks:**
- [ ] Generate OpenAPI from schemas
- [ ] Add operation descriptions
- [ ] Add example requests/responses
- [ ] Validate OpenAPI
- [ ] Publish documentation

**Acceptance:**
- [ ] OpenAPI validates
- [ ] Examples work
- [ ] API docs published

---

### Phase 3 Exit Criteria

- [ ] All traces instrumented
- [ ] Metrics collected
- [ ] Docker hardened
- [ ] Health endpoints work
- [ ] Crash recovery works
- [ ] Benchmarks meet targets
- [ ] OpenAPI docs generated
- [ ] All MVP release gates pass

**Estimated Phase Duration:** 3-5 days

---

## Critical Path Summary

The critical path for MVP delivery is:

```
TD-001 (Monorepo) → TD-002 (Schemas) → TD-003 (Engine Interface) →
TD-004 (FakeEngine) → TD-005 (Contract Tests) → TD-007 (Sessions) →
TD-008 (Playwright Engine) → TD-009 (Observations) → TD-010 (Actions) →
TD-011 (REST API) → TD-012 (SDK) → TD-014 (Network Policy) →
TD-015 (Approvals) → TD-016 (Secrets) → TD-018 (MCP) →
TD-022 (Docker) → MVP Complete
```

**Parallel work items:**
- TD-006 (Threat Model) - Can run anytime
- TD-013 (CLI) - After TD-012
- TD-017 (Downloads) - After TD-008
- TD-019 (Diffs) - After TD-009
- TD-020 (Tracing) - After TD-007
- TD-021 (Metrics) - After TD-020
- TD-023 (Health) - After TD-022
- TD-024 (Crash) - After TD-008
- TD-025 (Benchmarks) - After TD-012
- TD-026 (OpenAPI) - After TD-011

---

## Testing Strategy

### Unit Tests
- Package-level tests
- Fast, isolated
- Mock external dependencies

### Contract Tests
- Test `BrowserEngine` implementations
- Use deterministic fixtures
- Validate invariants

### Integration Tests
- Test component interaction
- Use real services (SQLite, etc.)

### E2E Tests
- Full workflow tests
- Use local fixture sites
- Validate user journeys

### Security Tests
- SSRF defense
- Secret redaction
- Cross-tenant isolation
- Input validation

### Performance Tests
- Latency benchmarks
- Concurrency soak
- Memory leak detection
- Cleanup verification

---

## Dependency Graph

```
Phase 0: Foundation
├── TD-001: Monorepo (P0)
├── TD-002: Schemas (P0) → TD-001
├── TD-003: Engine Interface (P0) → TD-002
├── TD-004: FakeEngine (P0) → TD-003
├── TD-005: Contract Tests (P0) → TD-004
└── TD-006: Threat Model (P0) [parallel]

Phase 1: Core
├── TD-007: Sessions (P0) → TD-005
├── TD-008: Playwright Engine (P0) → TD-007, TD-005
├── TD-009: Observations (P0) → TD-008
├── TD-010: Actions (P0) → TD-009
├── TD-011: REST API (P0) → TD-010
├── TD-012: SDK (P0) → TD-011
└── TD-013: CLI (P1) → TD-012

Phase 2: Safety
├── TD-014: Network Policy (P0) → TD-008
├── TD-015: Approvals (P0) → TD-010
├── TD-016: Secrets (P0) → TD-010
├── TD-017: Downloads (P1) → TD-008
├── TD-018: MCP Server (P0) → TD-010
└── TD-019: Diffs (P1) → TD-009

Phase 3: Operability
├── TD-020: Tracing (P1) → TD-007
├── TD-021: Metrics (P1) → TD-020
├── TD-022: Docker (P0) → [all previous]
├── TD-023: Health (P1) → TD-022
├── TD-024: Crash Recovery (P1) → TD-008
├── TD-025: Benchmarks (P1) → TD-012
└── TD-026: OpenAPI (P1) → TD-011
```

---

## Success Criteria

### MVP Complete When:
1. ✅ Can install and run via documented commands
2. ✅ Can run in hardened Docker container
3. ✅ Can create session via REST, SDK, CLI, MCP
4. ✅ Can navigate to allowed URLs, block forbidden
5. ✅ Can get bounded semantic observation with refs
6. ✅ Can complete multi-step workflows without selectors
7. ✅ Can detect stale refs without guessing
8. ✅ Can require approval for simulated transactions
9. ✅ Keeps secrets out of logs, observations, screenshots
10. ✅ Can export screenshot, Markdown, JSON with provenance
11. ✅ Survives crashes with typed errors and cleanup
12. ✅ Passes contract, E2E, security, benchmark, soak tests
13. ✅ Publishes OpenAPI, SDK docs, MCP config, threat model

### Performance Targets:
- Warm session creation: p50 ≤ 350ms, p95 ≤ 1,000ms
- Observation: p50 ≤ 150ms, p95 ≤ 500ms
- Agent observation: ≤ 32 KiB, ≤ 300 elements
- Action dispatch: ≤ 100ms p50
- 100 concurrent sessions without unbounded RSS growth
- Zero leaked processes per 10,000 sessions

---

## Next Steps

1. **Review and approve ADRs 001-010**
2. **Review and approve Technical Design**
3. **Begin Phase 0 implementation with TD-001**
4. **Track progress via GitHub Projects**
5. **Run CI on every PR**
6. **Hold architecture review after each phase**

---

## Appendix: File Structure Reference

```
agentbrowser/
├── apps/
│   ├── server/              # REST + WebSocket service
│   ├── cli/                 # CLI tool
│   └── mcp/                 # MCP server
├── packages/
│   ├── protocol/            # Schemas, types, OpenAPI
│   ├── core/                # Sessions, actions, observations
│   ├── engine/              # BrowserEngine interface
│   ├── engine-playwright/   # Playwright Chromium implementation
│   ├── policy/              # Egress, approval, secrets
│   ├── extraction/          # Markdown, tables, JSON extraction
│   ├── artifacts/           # Trace/screenshot/download storage
│   ├── sdk-typescript/      # TypeScript client SDK
│   └── testkit/             # Fake engine, contract tests
├── docs/
│   ├── adr/                 # Architecture decision records
│   ├── threat-model.md
│   └── operations.md
├── tests/
│   ├── contract/            # Engine contract tests
│   ├── e2e/                 # End-to-end workflow tests
│   ├── security/            # Security test suites
│   ├── performance/         # Benchmarks and soak tests
│   └── corpus/              # Real-world task scenarios
├── fixtures/
│   └── sites/               # Local test websites
├── deploy/
│   ├── Dockerfile
│   └── compose.yaml
└── openapi/
    └── agentbrowser-v1.yaml
```
