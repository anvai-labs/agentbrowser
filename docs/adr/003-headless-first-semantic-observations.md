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
4. **Debug mode only**: Headed mode exists solely for local development

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
POST /v1/sessions/{sessionId}/screenshots
{
  "pageId": "pg_01...",
  "options": {
    "fullPage": true,
    "maskSensitive": true
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
- `maxBytes`: `32768` (32 KiB) default
- `maxElements`: `300` default
- Truncate deterministically: dialogs/focused first, then interactive, then content

### Headed debug mode

```bash
# Local development only
AGENTBROWSER_HEADED=true agentbrowser server

# Or per-session
POST /v1/sessions
{
  "options": {
    "headed": true,  // Rejected in production mode
    "debugHost": "localhost:5900"  // VNC for remote debugging
  }
}
```

### Validation criteria

- Default observation from e-commerce site ≤ 32 KiB
- Screenshots are optional and explicitly requested
- All agent workflows complete successfully without screenshots
- Headed mode only works when `NODE_ENV=development`
- Mask sensitive fields in screenshots by default
