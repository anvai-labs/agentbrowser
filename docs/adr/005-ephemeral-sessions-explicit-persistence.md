# ADR-005: Ephemeral Sessions and Explicit Persistence

**Status:** Accepted
**Context:** 2025-01-23
**Superseded by:** N/A

## Context

Browser automation for agents falls into two patterns:

1. **Ephemeral task execution**: Run a workflow, discard all state
   - RAG ingestion
   - QA testing
   - One-time extractions
   - Research tasks

2. **Authenticated sessions**: Maintain state across workflows
   - Repeated logins
   - Long-running workflows
   - Personalized browsing

Traditional browsers persist everything by default (cookies, cache, history). For agent use cases, this is problematic:
- **Security**: Cross-tenant data leakage
- **Privacy**: Sensitive data retained beyond task
- **Resource bloat**: Storage accumulates indefinitely
- **Reproducibility**: Hard to know what state a session has

The system must default to safety (ephemeral) while supporting persistence when explicitly needed.

## Decision

**Sessions are fully ephemeral by default; persistence is opt-in and explicit.**

### Core principles

1. **Ephemeral by default**: All session state dies when session closes
2. **Explicit persistence**: User must opt-in to any state retention
3. **Scoped exports**: Data export is specific (cookies, PDF, trace)
4. **Cleanup on close**: Automatic cleanup of temp files, processes, profiles
5. **No persistence without consent**: No silent background persistence

### Session lifecycle

```
CREATING -> ready -> active -> CLOSING -> CLOSED

Terminal outcomes (lowercase states in code; close carries a reason):
- expired (TTL or idle timeout reached)
- crashed (browser process crashed)
- terminated:<reason> (explicit close; POLICY_/QUOTA_TERMINATED states
  were never implemented)
```

### What's ephemeral by default

- Cookies and localStorage
- Browser cache and HTTP cache
- Session storage
- Downloaded files
- Console logs and traces
- Page history and navigation state
- BrowserContext and process

### What can be explicitly persisted

- Cookies via export API
- Page screenshots/PDFs
- Execution traces (`POST /v1/sessions/{id}/trace`, A3)
- Page HTML (`POST /v1/sessions/{id}/pages/{id}/html`, A3)
- Network logs
- Downloaded files (via explicit save)

## Consequences

### Positive
- **Security by default**: No cross-tenant leakage
- **Resource efficiency**: No unbounded storage growth
- **Compliance**: GDPR-by-default for agent data
- **Reproducibility**: Fresh session = known starting state
- **Debugging**: Can replay from exported snapshot

### Negative
- **Re-authentication cost**: Must log in again each session
- **No persistent profiles**: Can't maintain long-term browsing identity
- **Workflow limitations**: Multi-day workflows need custom state management

### Trade-offs
- Accept re-authentication overhead for security
- Persistence available but not automatic
- Users must design stateful workflows explicitly

## Rationale

### Why ephemeral default

1. **Security**: No cross-tenant data leakage is the most important invariant
2. **Compliance**: Default retention > collection under GDPR
3. **Resource**: Unbounded storage is expensive and dangerous
4. **Simplicity**: Fresh sessions are predictable and debuggable

### When persistence makes sense

1. **Long-running workflows**: Multi-step authenticated flows
2. **Debugging**: Export session state to reproduce bug
3. **Caching**: Re-use authentication across sessions
4. **Audit**: Export trace for compliance

### Why explicit opt-in

1. **Intent**: User knows what they're keeping and why
2. **Cost**: Storage has cost; user decides what to pay for
3. **Security**: No surprising data retention
4. **Compliance**: Clear consent for data retention

### Alternative considered: Persistent sessions by default
**Rejected** because:
- Cross-tenant security risk is unacceptable
- Storage costs are unbounded
- Compliance violations are automatic
- Debugging becomes harder

### Alternative considered: No persistence ever
**Rejected** because:
- Some workflows require state (logins, multi-step tasks)
- Can't debug without exported state
- Repeated auth is wasteful for trusted users

## Related Decisions

- **ADR-006**: Network egress policy - complements session isolation
- **ADR-008**: Process isolation - ephemeral sessions need process boundaries
- **Spec Section 9**: Session and isolation model

## Implementation Notes

### Session creation

```json
POST /v1/sessions
{
  "engine": "playwright-chromium",
  "ttlMs": 900000,  // 15 minutes default
  "idleTimeoutMs": 120000,  // 2 minutes default
  "persistence": {
    "mode": "ephemeral"  // default
  }
}
```

### Close behavior (ephemeral)

```typescript
async closeSession(sessionId, reason) {
  // 1. Stop accepting new actions
  await session.markClosing();

  // 2. Drain in-flight actions (with timeout)
  await session.drainActions(5000);

  // 3. Close all pages
  await session.closeAllPages();

  // 4. Close browser context
  await session.browserContext.close();

  // 5. Cleanup temp files
  await cleanupTempDir(session.tempDir);

  // 6. Verify cleanup
  await auditCleanup(session);

  // 7. Mark closed
  session.state = "CLOSED";
  session.closedAt = Date.now();
}
```

### Explicit persistence opt-in

```json
POST /v1/sessions
{
  "persistence": {
    "mode": "explicit",
    "retention": {
      "cookies": true,      // Export cookies on close
      "traces": true,       // Keep execution traces
      "downloads": "explicit",  // Only explicitly saved downloads
      "snapshots": false    // Don't auto-snapshot
    }
  }
}
```

### Export APIs

```typescript
// Export cookies (shipped, TD-BROWSER-6)
GET /v1/sessions/{id}/cookies
Response: { "cookies": [...] }   // httpOnly included; re-seed via create

// Export trace (shipped, A3, Phase 2)
POST /v1/sessions/{id}/trace
Response: ArtifactRef             // completed spans, secret-scrubbed, as JSON

// Export page HTML (shipped, A3, Phase 2)
POST /v1/sessions/{id}/pages/{id}/html
Response: ArtifactRef             // raw HTML, NOT secret-redacted (metadata says so)
```

### Session-resume snapshots: de-scoped (Phase 2 decision, 2026-09-04)

Spec'd but never built; deliberately de-scoped rather than implemented.
Auth re-entry - the dominant reason anyone would want to "resume" a
session - is already fully served by cookie seeding
([TD-BROWSER-6](../td/TD-BROWSER-6-headed-sessions-and-credential-handoff.md)):
create a new session with the previous session's `cookies`, and it
re-enters the authenticated state.

A snapshot mechanism would add exactly one thing cookies can't cover:
localStorage/sessionStorage-based auth (SPAs keeping a JWT in storage
rather than a cookie). Nothing else it could plausibly restore is real -
refs and revision are process-local minting state, meaningless after a
restore; a restored page still needs a fresh `observe()` before any
action can target it; "resuming" open pages is just the caller replaying
the URLs it already knows via `createPage` + `navigate`. And the
capability that *would* be real - storage-state restore - has zero
engine support today (no engine exposes `localStorage`; Playwright's
`context.storageState()` is unused anywhere in this codebase) and would
need an `EnginePage` interface change plus a real answer for Safari
(WebDriver-injected `localStorage` access is a same-origin,
post-navigation-only operation, the same constraint that already
complicates its cookie seeding). A snapshot artifact holding cookies (or
worse, storage) is also a serialized credential bundle, which is exactly
the kind of persistent artifact ADR-005's ephemeral-by-default stance
exists to avoid creating casually.

`BrowserEngine.restoreSession?()` and `EngineSession.snapshot?()` remain
on the engine interface as optional, unimplemented hooks (no engine
implements either) - kept for now as a documented non-goal rather than
removed, since they're additive and cost nothing unused. If storage-based
auth re-entry becomes a real, asked-for need, it gets its own TD scoped
to exactly that (storageState resume), not a general session-snapshot
mechanism.

### Cleanup verification

```typescript
// After every session close:
async auditCleanup(session) {
  const checks = [
    processNotRunning(session.browserPid),
    tempDirDeleted(session.tempDir),
    noRemainingHandles(sessionId),
    noOpenConnections(sessionId),
    zeroRefCount(session.profileDir)
  ];

  const failed = checks.filter(c => !c.passed);
  if (failed.length > 0) {
    await emitSecurityEvent("session_cleanup_failed", { failed });
    // Force cleanup with stronger measures
  }
}
```

### Validation criteria

- Fresh session has zero cookies/storage
- After close, no temp files remain
- After close, no browser processes remain
- Can export specific data types on demand (cookies, trace, page HTML)
- No cross-tenant storage references possible
