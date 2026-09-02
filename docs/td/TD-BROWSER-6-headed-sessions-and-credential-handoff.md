# TD-BROWSER-6: Headed Sessions, Per-Session Engines, and Credential Handoff

**Status:** Accepted — implemented in this change set
**Context:** 2026-09-02
**Related:** [ADR-005](../adr/005-ephemeral-sessions-explicit-persistence.md) (ephemeral
sessions, explicit persistence), [ADR-009](../adr/009-mcp-high-level-tools.md) (high-level
safe tools), [TD-BROWSER-5](TD-BROWSER-5-single-binary-mcp-distribution.md) (single-binary
MCP distribution)

## Context — three failures observed in one real login flow

A customer's first headed flow ("log in by hand, then hand the session to the
agent") surfaced three defects, all verified against a v1.5.0 deployment:

1. **Silent headless override.** `POST /v1/sessions {"headless": false}` launched
   `chrome-headless-shell` anyway. The engine keeps **one browser per service
   lifetime** (`if (!this.browser)` in `createSession`) and the first session's
   headlessness wins; every later `headless` value is silently ignored. The
   customer's `headless: false` did the *opposite* of what they asked, with no
   error — the worst failure shape in the API.
2. **The restart dance.** The only workaround was `brew services restart` so the
   *first* session after boot requests headed — which also destroys every
   running session. A workflow that needs a privileged state (being first)
   should not require destroying shared state to obtain it.
3. **Half-built credential handoff.** ADR-005 promises scoped exports and the
   engine contract already declares `EngineSession.cookies()`
   (`packages/engine/src/types.ts`), and `PlaywrightSession` has implemented it
   since the cookie-seeding change — but no route, no coordinator method, and
   no MCP tool expose it. The durable-login loop (log in once headed → export
   cookies → seed every future headless session, whose `cookies` create option
   already exists) dead-ends at export.

## Anchors

- **User experience**: a login workflow must be creatable in one call, must do
  what the call says, and must survive long enough for a human to type
  credentials (defaults: `ttlMs` 15 min, `idleTimeoutMs` 2 min — the idle
  default kills a session mid-login; callers doing logins must pass explicit
  timeouts, and the docs must say so).
- **Customer performance**: the shared headless browser is the product's
  throughput story (one Chromium, N isolated contexts). It must not regress.
- **Robustness**: a headed browser crash must not take headless sessions down;
  an unsupported launch request must fail loudly, never silently degrade.

## Decision

1. **Headed sessions get a dedicated, session-owned browser.** In
   `PlaywrightChromiumEngine.createSession`, an explicitly headed request
   (`headless === false`) launches its own browser instead of reusing the
   shared one; the session owns it and closes it on session close. Headless
   sessions (explicit or default) keep using the shared browser exactly as
   today — no per-session browser cost on the hot path.
   - This covers every family (`chromium`, `firefox`, `webkit`) — they share
     the same launcher path.
   - Robustness improves as a consequence: the interactive browser is isolated
     from the automation pool by construction.
2. **Shared-browser reuse keeps first-launch-wins for headless.** The shared
   browser's mode is recorded; a headless request reuses it regardless (headless
   into a headed shared browser cannot happen because headed never touches the
   shared browser). If the shared browser was created headed by an explicit
   first session, later headless sessions reuse it headed — documented, and the
   right fix for callers is the dedicated path above; a loud contract here
   (headless requests never silently pay a visible window) is preserved.
3. **Cookie export surfaces end to end.** The engine-side `cookies()`
   (already implemented) is exposed:
   - coordinator: `cookies(sessionId)` → `NormalizedCookie[]`;
   - API: `GET /v1/sessions/{sessionId}/cookies` (openapi documented);
   - MCP tool: `browser_cookies {sessionId}`.
   Together with the existing `cookies` create option this closes the loop:
   log in once (headed or in a normal browser), export, seed future sessions.
4. **Engine-agnostic by contract.** Everything above rides the
   `BrowserEngine`/`EngineSession` interfaces. `cookies()` is already required
   by the contract and implemented by the playwright engine (all families);
   the experimental obscura engine is not service-wired and grows into the
   contract independently.

## Non-goals

- Per-session browsers for headless sessions (performance anchor).
- Cross-service session attach (a service restart still orphans sessions;
  the session store remains in-memory by design, ADR-005).
- A cookie-export UI in the service's webui.

## Performance

Zero added cost on the headless path: same shared browser, same context
isolation, no new per-session handles. Headed sessions add one Chromium
process each — bounded by `maxSessions`, reclaimed by session close, TTL, and
idle timeout like every other session resource.

## Robustness

- Headed browsers are session-scoped: a crash in an interactive session cannot
  poison the shared automation pool (previously impossible to express).
- The engine never silently converts a headed request to headless: the
  dedicated launch is unconditional for `headless === false`.
- Session close is fail-safe: an owned browser close failure is logged, the
  context close still runs, and the session still reaches CLOSED.

## Test plan (TDD)

Engine (`packages/engine-playwright`), real-browser behavioral:

1. `headed + headless coexist` — headed context's `browser()` is not the
   headless context's `browser()` (the singleton regression, caught by
   identity).
2. `closing the headed session leaves the shared browser connected` — and a
   subsequent headless session still navigates (ownership regression).
3. `headed browser is disposed on session close` — owned browser
   `isConnected() === false` after `session.close()`.
4. `cookies round-trip` — seed at create → `session.cookies()` returns them.
5. `headless default unchanged` — default create still shares one browser
   across two sessions (identity holds), guarding the performance anchor.

API: route test for `GET /v1/sessions/{id}/cookies` (404 unknown, 200 + array
for a live session). MCP: `browser_cookies` appears in `tools/list` and
returns the service's cookies for a seeded session.

## Implementation record

- Engine: dedicated headed browsers + ownership + (existing) `cookies()`.
- Core: `SessionCoordinator.cookies(sessionId)`.
- API: `GET /v1/sessions/{sessionId}/cookies` + openapi.
- MCP: `browser_cookies` tool.
- Tests: engine coexistence/ownership/cookies, API route, MCP tool.
