# ADR-009: MCP Exposes High-Level Safe Tools, Not Raw Playwright

**Status:** Accepted
**Context:** 2025-01-23
**Superseded by:** N/A

## Context

Model Context Protocol (MCP) allows AI agents to interact with tools. For AgentBrowser via MCP, we must decide:

1. **Granularity**: Expose dozens of low-level Playwright functions or few high-level composable tools?
2. **Safety**: Should MCP tools allow dangerous operations?
3. **Agent UX**: Large tool catalog vs small, coherent toolset?

Traditional browser automation exposes granular operations:
- `click()`, `dblclick()`, `tripleClick()`
- `hover()`, `unhover()`
- `check()`, `uncheck()`
- `selectOption()`, `deselectOption()`
- `fill()`, `type()`, `press()`
- `goto()`, `goBack()`, `goForward()`, `reload()`
- `waitFor()`, `waitForSelector()`, `waitForFunction()`
- `screenshot()`, `pdf()`

This creates problems for AI agents:
- **Tool explosion**: Model must choose from 20+ similar tools
- **Token cost**: Large tool descriptions consume context
- **Safety confusion**: Easy to make dangerous mistakes
- **Composability**: Harder to reason about workflows

## Decision

**MCP exposes a small set of high-level, safe, composable tools; dangerous operations require explicit approval.**

### MCP tool surface

```typescript
// Core lifecycle
browser_create(session, options)
browser_close(session)

// Navigation
browser_navigate(session, url, waitUntil)

// Observation
browser_observe(session, mode, options)

// Actions
browser_act(session, action, options)

// Extraction
browser_extract(session, schema, options)

// Evidence
browser_screenshot(session, options)
browser_pdf(session, options)
```

### NOT exposed (dangerous or low-level)

- Raw `evaluate()` / `evaluateHandle()` (code execution)
- `addInitScript()` (script injection)
- `route()` / `unroute()` (network manipulation)
- Low-level input (individual `mouse`, `keyboard` APIs)
- Direct CSS/XPath selectors (security/anti-pattern)
- `setViewport()`, `emulateMedia()` (should be session-level)
- CDP-specific APIs

## Consequences

### Positive
- **Small tool surface**: Only 8 tools to understand
- **Composable**: Tools combine for complex workflows
- **Safe**: No dangerous code execution APIs
- **Token efficient**: Small tool descriptions
- **Agent-friendly**: Tools map to agent mental model

### Negative
- **Less granular**: Can't do obscure Playwright tricks
- **Fewer shortcuts**: Some automation patterns require multiple steps
- **Expert limitations**: Power users can't access raw browser APIs

### Trade-offs
- Small tool surface over feature completeness
- Safety over advanced features
- Agent UX over power user flexibility

## Rationale

### Why high-level tools

1. **Agent reasoning**: Smaller tool surface is easier to reason about
- **Token efficiency**: 8 tools < 20+ tools in context
- **Safety**: High-level tools can include safety checks
- **Composability**: Tools combine for any workflow

### Why unify actions

1. `browser_act()` handles all interaction types:
- `click`, `fill`, `select`, `scroll`, `press`, etc.
- Single tool learns agent's intent
- Easier to add new actions without protocol change
- Consistent error handling and post-conditions

### Why exclude dangerous operations

1. **Code execution**: `evaluate()` is too powerful for multi-tenant
2. **Script injection**: `addInitScript()` modifies page behavior
3. **Network bypass**: `route()` can disable security checks
4. **Selectors**: Direct selectors are fragile and unsafe

These are available via REST API with explicit authentication/authorization, but not via untrusted MCP agents.

### Alternative considered: Full Playwright API
**Rejected** because:
- 20+ tools confuses agent reasoning
- Token cost is prohibitive
- Safety is impossible with raw evaluation
- Not aligned with agent-first design

### Alternative considered: No MCP, just REST
**Rejected** because:
- MCP is the primary agent interface
- Agents need native MCP integration
- MCP tool use model is perfect for this

## Related Decisions

- **ADR-001**: TypeScript control plane - MCP server implemented in TypeScript
- **ADR-004**: Element refs - MCP tools use refs, not selectors
- **Spec Section 13.4**: SDK and MCP tool design

## Implementation Notes

### MCP tool definitions

```typescript
// tools/browser.ts
export const BROWSER_TOOLS = [
  {
    name: "browser_create",
    description: "Create a new isolated browser session",
    inputSchema: {
      type: "object",
      properties: {
        engine: { type: "string", enum: ["playwright-chromium", "auto"] },
        ttlMs: { type: "number", description: "Session timeout in ms" },
        policy: { "$ref": "#/components/schemas/SessionPolicy" }
      }
    }
  },

  {
    name: "browser_navigate",
    description: "Navigate to a URL and wait for page load",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: { type: "string" },
        url: { type: "string", format: "uri" },
        waitUntil: { type: "string", enum: ["load", "domcontentloaded", "networkidle"] }
      },
      required: ["sessionId", "url"]
    }
  },

  {
    name: "browser_observe",
    description: "Get semantic snapshot of page with interactive elements",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: { type: "string" },
        mode: {
          type: "string",
          enum: ["interactive", "content", "accessibility"],
          description: "Observation mode (default: interactive)"
        },
        maxElements: { type: "number", description: "Max elements to return" }
      },
      required: ["sessionId"]
    }
  },

  {
    name: "browser_act",
    description: "Perform action on element: click, fill, select, scroll, press",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: { type: "string" },
        action: {
          oneOf: [
            { "$ref": "#/components/schemas/ClickAction" },
            { "$ref": "#/components/schemas/FillAction" },
            { "$ref": "#/components/schemas/SelectAction" },
            { "$ref": "#/components/schemas/ScrollAction" },
            { "$ref": "#/components/schemas/PressAction" }
          ]
        }
      },
      required: ["sessionId", "action"]
    }
  },

  {
    name: "browser_extract",
    description: "Extract structured data from page using JSON Schema",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: { type: "string" },
        schema: { type: "object" },  // JSON Schema
        scope: { type: "string", description: "CSS selector or element ref" }
      },
      required: ["sessionId", "schema"]
    }
  },

  {
    name: "browser_screenshot",
    description: "Capture screenshot for debugging/verification",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: { type: "string" },
        fullPage: { type: "boolean" },
        maskSensitive: { type: "boolean" }
      },
      required: ["sessionId"]
    }
  },

  {
    name: "browser_close",
    description: "Close session and cleanup all resources",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: { type: "string" }
      },
      required: ["sessionId"]
    }
  }
];
```

### Safety layer in MCP server

```typescript
async handleToolCall(tool, args) {
  const session = await getSession(args.sessionId);

  // Policy check
  const policy = await getPolicy(session);
  await policy.checkAccess(tool, args);

  // Approval check for high-risk actions
  if (tool === "browser_act") {
    const effect = await classifyAction(args.action, session);
    if (policy.requiresApproval(effect)) {
      throw new ApprovalRequiredError(effect, args.action);
    }
  }

  // Execute
  return await executeTool(tool, args);
}
```

### Content labeling for security

```typescript
// All MCP tool results mark webpage content as untrusted
function formatToolResult(result) {
  return {
    ...result,
    _metadata: {
      untrustedContent: true,  // Critical for prompt injection defense
      timestamp: new Date().toISOString(),
      sessionId: sanitize(result.sessionId)
    }
  };
}
```

### Agent task examples

```typescript
// Agent workflow: Login and extract data
async loginAndExtract(credentials) {
  const session = await browser_create({
    policy: { allowedHosts: ["example.com"] }
  });

  await browser_navigate(session, "https://example.com/login");

  const loginPage = await browser_observe(session, { mode: "interactive" });

  await browser_act(session, {
    type: "fill",
    target: findRef(loginPage, "username"),
    value: credentials.username
  });

  await browser_act(session, {
    type: "fill",
    target: findRef(loginPage, "password"),
    value: credentials.password,
    sensitive: true  // Mask in logs
  });

  await browser_act(session, {
    type: "click",
    target: findRef(loginPage, "login")
  });

  // Wait for navigation/redirect
  await waitForStable(session);

  const dashboard = await browser_observe(session);

  const data = await browser_extract(session, {
    schema: DATA_SCHEMA
  });

  await browser_close(session);

  return data;
}
```

### Validation criteria

- MCP tool surface is ≤ 10 tools
- No `evaluate()` or code execution APIs
- All results labeled with `untrustedContent: true`
- High-risk actions require approval
- Tools use refs, not raw selectors
- Can complete common workflows with tool combinations
- Tool descriptions < 200 tokens total
