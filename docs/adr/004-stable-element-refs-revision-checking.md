# ADR-004: Stable Element References with Revision Checking

**Status:** Accepted
**Context:** 2025-01-23
**Superseded by:** N/A

## Context

Traditional browser automation uses fragile selectors (CSS/XPath) that break when:
- Page structure changes
- Classes are renamed
- Elements are reordered
- SPAs update the DOM

For AI agents, this is catastrophic:
1. Agent has outdated understanding of page structure
2. Action might target wrong element
3. Silent failures or incorrect actions
4. No way to detect staleness

The system must provide stable references that detect staleness before acting.

## Decision

**Issue server-managed element references scoped to page revisions; reject actions on stale refs.**

### Core principles

1. **References are opaque**: Clients don't know the underlying selector
2. **Scoped by revision**: Each ref is tied to a specific page revision
3. **Verify before acting**: Re-resolve and fingerprint before executing
4. **Never guess**: If ref is stale/ambiguous, return error, don't click nearest match

### Reference format

```
e<revision>_<ordinal>
```

Example: `e17_09` = 9th interactive element on page revision 17

### Lifecycle

```typescript
// Agent observes page, gets refs
observe() => {
  revision: 17,
  elements: [
    { ref: "e17_01", role: "textbox", name: "Email" },
    { ref: "e17_09", role: "button", name: "Place Order" }
  ]
}

// Agent acts using ref
act({ type: "click", target: { ref: "e17_09" } })

// System validates:
// 1. Page still at revision 17 (or agent provided expectedRevision: 17)
// 2. Ref resolves to same semantic fingerprint (role, name, position)
// 3. Element is still visible, enabled, interactive

// If any check fails:
// Return STALE_TARGET error with new observation
```

## Consequences

### Positive
- **Safety**: Never click the wrong element due to staleness
- **Debuggability**: Clear error when page changed under agent
- **Token efficiency**: Refs are short strings vs complex selectors
- **Agent simplicity**: No need to manage complex selectors

### Negative
- **Round-trip requirement**: Must observe before acting on new page
- **Staleness churn**: Long workflows may need to re-observe frequently
- **No selector flexibility**: Power users can't hand-tune selectors

### Trade-offs
- Accept round-trips for safety
- Short refs reduce token cost vs selectors
- Explicit escape hatch for direct selectors (expert mode only)

## Rationale

### Why opaque refs

1. **Stability**: Server can change strategy without client changes
2. **Security**: Don't expose page structure unnecessarily
3. **Optimization**: Can use multiple strategies (ARIA, test IDs, geometry)
4. **Versioning**: Ref format is independent of implementation

### Why revision binding

1. **Detect staleness**: Know immediately when page changed
2. **Diff optimization**: Track what changed between revisions
3. **Debugging**: Can replay exact page state from ref
4. **Audit**: Trace which page version an action targeted

### Why never guess

1. **Safety**: Wrong action > no action
2. **Correctness**: Agent should know its observation is stale
3. **Debugging**: Ambiguity is surfaced immediately
4. **Reproducibility**: Failed action is deterministic, not probabilistic

### Alternative considered: CSS selectors as refs
**Rejected** because:
- Fragile to page structure changes
- Exposes implementation details
- No way to detect staleness
- Can't optimize resolution strategy

### Alternative considered: Probability-based matching
**Rejected** because:
- Non-deterministic: same action might succeed or fail
- Safety risk: might click wrong element
- Hard to debug: failures are probabilistic
- Not acceptable for financial/transactional use cases

## Related Decisions

- **ADR-002**: Engine-neutral protocol - refs are protocol-level concept
- **Spec Section 10.2**: Element reference lifecycle

## Implementation Notes

### Reference resolution strategies (internal, not exposed)

```typescript
// Server-side strategies tried in order:
1. Test ID (data-testid, id)
2. ARIA role + name
3. Label association
4. Text content + role
5. DOM ancestry + geometry
```

### Fingerprint verification

```typescript
interface ElementFingerprint {
  role: string;
  name: string;
  tagName?: string;
  xpath?: string;  // Only for exact match
  geometry?: { x: number; y: number; width: number; height: number };
}

// Before action:
const fingerprint = await getElementFingerprint(ref);
if (!fingerprintMatches(originalFingerprint, fingerprint)) {
  return {
    error: {
      code: "STALE_TARGET",
      message: "Element belongs to revision 17; page at revision 19",
      retryable: true,
      action: "observe_and_retry"
    }
  };
}
```

### Action validation flow

```typescript
async executeAction(sessionId, pageId, expectedRevision, action) {
  // 1. Check page revision
  const currentPage = await getPage(pageId);
  if (currentPage.revision !== expectedRevision) {
    throw new StaleTargetError(expectedRevision, currentPage.revision);
  }

  // 2. Resolve ref to element
  const ref = action.target.ref;
  const element = await resolveRef(ref, currentPage);

  // 3. Verify fingerprint
  if (!element.fingerprintMatches()) {
    throw new StaleTargetError("Element fingerprint changed");
  }

  // 4. Check element state
  if (!element.isVisible || !element.isEnabled) {
    throw new TargetNotInteractiveError("Element not interactive");
  }

  // 5. Execute action
  return await element.perform(action);
}
```

### Escape hatch: direct selectors (expert mode)

```json
{
  "action": {
    "type": "click",
    "target": {
      "selector": "button[data-testid='submit']",
      "strategy": "css"  // Must be explicitly requested
    }
  }
}
```

> **Planned escape hatch — not implemented.** The public contract is
> ref-only today: `ElementTarget` is `{ ref: string }` on every surface
> (protocol, REST, MCP), and no `selector`/`strategy` fields exist.

### Validation criteria

- Refs work across same revision
- Refs fail predictably after page revision changes
- STALE_TARGET error reports expected vs current revision; the client re-observes
- Never clicks wrong element due to ref staleness
- Can implement agent that only uses refs, no selectors
