# ADR-003: Headless-First, Semantic Observations, Optional Visual Evidence

**Status:** Accepted
**Context:** 2025-01-23
**Superseded by:** N/A

## Context

Traditional browsers are visual applications where screenshots are the primary output. For AI agents, this model is inefficient:

1. **Token waste**: Full screenshots are huge and mostly irrelevant pixels
2. **Poor reasoning**: Agents must reverse-engineer UI from pixels
3. **Slow**: Screenshots require full layout/paint/render pipeline
4. **Unreliable**: Visual changes can be imperceptible but semantically critical

However, agents sometimes need visual evidence for debugging and verification.

The system must balance: agent efficiency with human debugging needs.

## Decision

**Headless-first by default; semantic observations as the primary agent output; screenshots/PDFs as optional evidence.**

### Core principles

1. **Headless in production**: No browser chrome, tabs, or visible windows
2. **Semantic first**: Default observation = structured element tree with accessibility roles
3. **Pixels on demand**: Screenshots only when explicitly requested or for evidence
4. **Human-in-the-loop mode**: headed sessions exist for interactive
   logins and approvals (superseded in detail by ADR-013 / TD-BROWSER-6);
   headless remains the default for agent workloads

### Observation modes

```typescript
type ObservationMode =
  | "interactive"      // Semantic tree, form state, interactive refs (default)
  | "content"         // Readable text, headings, structure
  | "accessibility"    // Full ARIA tree, roles, names, states
  | "compact_dom"     // Minimal DOM structure
  | "visual"          // Screenshot (pixels)
```

## Consequences

### Positive
- **Token efficiency**: Default observation is 10-100x smaller than screenshot
- **Agent reliability**: Structured data > OCR on pixels
- **Performance**: Skip render/paint when only semantics needed
- **Human debugging**: Can request visual evidence for troubleshooting

### Negative
- **Not a visual browser**: Cannot compete with Chrome/Firefox on visual features
- **Limited accessibility**: Not suitable for users who need visual browsers
- **Debugging friction**: Developers must explicitly request screenshots

### Trade-offs
- Accept limited visual use cases to optimize for agent workflows
- Screenshots available but not automatic
- Headed debug mode for development only

## Rationale

### Why semantic > visual for agents

1. **Agents read structure**: Role, name, state > pixels
2. **Actions target semantics**: Click the "Submit" button, not coordinates
3. **Changes are semantic**: "Form has errors" is more useful than "pixels changed"
4. **Tokens matter**: 32KB default vs 2MB+ screenshot

### What this enables

- **Fast iteration**: Agents can observe/act many times per second
- **Reliable refs**: Element identity based on semantic fingerprint
- **Cheap testing**: Don't need render pipeline for most tests
- **Cost efficiency**: Lower GPU/CPU usage for headless operation

### Why screenshots still matter

- **Debugging**: Humans need to see what went wrong
- **Evidence**: Prove the page rendered correctly
- **Verification**: Visual regression when needed
- **Edge cases**: Sites with broken accessibility

### Alternative considered: Screenshot-first like traditional automation
**Rejected** because:
- Token cost makes per-action screenshots prohibitive
- Agents struggle with visual reasoning vs structured data
- Slower: full render pipeline on every observation
- Not aligned with agent workflows

### Alternative considered: No screenshots ever
**Rejected** because:
- Debugging production issues is impossible
- Can't verify visual correctness
- Evidence for security/audit is missing
- Demonstration and documentation would suffer

## Related Decisions

- **ADR-004**: Element refs with semantic fingerprints
- **Spec Section 10**: Agent observation model

## Implementation Notes

### Default observation (interactive mode)

```json
{
  "mode": "interactive",
  "elements": [
    {
      "ref": "e17_01",
      "role": "textbox",
      "name": "Email",
      "value": "",
      "required": true,
      "visible": true,
      "enabled": true
    }
  ],
  "summary": "Checkout form with 6 fields and a Place order button.",
  "untrustedContent": true
}
```

### Screenshot as evidence

```json
POST /v1/sessions/{sessionId}/pages/{pageId}/screenshot
{
  "pageId": "pg_01...",
  "options": {
    "fullPage": true
  }
}

Response:
{
  "artifactId": "art_01...",
  "contentType": "image/png",
  "sizeBytes": 245678,
  "url": "/v1/artifacts/art_01..."
}
```

### Observation defaults

- `mode`: `"interactive"` unless otherwise specified
- `maxBytes`: enforced in the service post-ref-bridging (byte-budget element prefix + text/changes trimming; see `paginateObservation`)
- `maxElements`: `300` default (`observation-normalizer.ts`)
- Truncate deterministically: dialogs/focused first, then interactive, then content

### Headed sessions (human-in-the-loop)

Headed mode is a per-session property, not a server-wide flag (no
`AGENTBROWSER_HEADED` env var exists):

```bash
# CLI
agentbrowser session create --tenant t1 --no-headless

# REST / MCP
POST /v1/sessions { "tenantId": "t1", "headless": false }
```

A headed session receives a dedicated browser instance owned by that
session (TD-BROWSER-6); the headless pool is unaffected. See ADR-013 for
the de-fingerprinting posture on headed sessions.

### Validation criteria

- Default observation from e-commerce site ≤ 32 KiB
- Screenshots are optional and explicitly requested
- All agent workflows complete successfully without screenshots
- Headed sessions receive a dedicated browser instance (TD-BROWSER-6)
- Screenshots are not pixel-masked; `maskSensitive: true` fails loudly -
  prefer redacted semantic observations
