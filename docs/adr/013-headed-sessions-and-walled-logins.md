# ADR-013: Headed Sessions, De-fingerprinting, and Walled Logins

**Status:** Accepted
**Context:** 2026-09-03
**Related:** [ADR-003](003-headless-first-semantic-observations.md) (headless-first),
[ADR-005](005-ephemeral-sessions-explicit-persistence.md) (credential handoff / cookie seeding),
[TD-BROWSER-6](TD-BROWSER-6-headed-sessions-and-credential-handoff.md) (headed sessions + handoff)

## Context

Headed sessions exist for human-in-the-loop flows (TD-BROWSER-6): logins, SSO, and
interactive approval. The motivating live case was registering a trusted publisher on
npmjs.com — gated by Cloudflare's turnstile — from a headed Playwright session on WSLg
with a real display and real human clicks. Observed live on 2026-09-03, in order:

1. **Stock headed Playwright Chromium** loops the turnstile forever (each checkbox pass
   "succeeds" visually; the backend re-challenges).
2. **Stripped automation fingerprints** (`--disable-blink-features=AutomationControlled`,
   dropping `--enable-automation`, scrubbing `navigator.webdriver`) — still loops.
3. **Real branded Google Chrome** via `channel: 'chrome'` *plus* the stripped flags —
   still loops.

The conclusion: walls like turnstile fingerprint the CDP connection itself, which no
launch configuration can hide while Playwright drives the browser. Meanwhile the
cookie-seeding handoff shipped with TD-BROWSER-6 (create a session with `cookies`;
export them back with `GET /v1/sessions/{id}/cookies`) exists precisely for "SSO /
device-trust login the headless browser cannot satisfy."

## Decision

Three scoped rules:

1. **De-fingerprint headed launches only.** When `headless === false`, the Playwright
   engine launches with `--disable-blink-features=AutomationControlled` and an init
   script rewriting `navigator.webdriver` to **`false`** — the value a real
   non-automated browser reports (`undefined` would itself be an anomalous state no
   genuine Chrome produces; review finding). When the configured binary path exists
   (`AGENTBROWSER_CHROME_PATH`, default `/opt/google/chrome/chrome`), the engine
   launches **that exact binary** via `executablePath` (not `channel`, which resolves
   through Playwright's own registry and ignores the configured path — review
   finding). Playwright 1.62 does not pass `--enable-automation` (verified against
   its default switch list), so no `ignoreDefaultArgs` is needed. The **headless
   pool keeps stock Playwright defaults** — detection there is honest and desired; a
   headless agent SHOULD be identifiable as automation. The webdriver rewrite is
   context-level and therefore also applies to CDP-attached headed sessions
   (attached browsers may themselves be automated; the scrub is cheap and
   intentional).

2. **No arms race against CDP-fingerprinting walls.** The branded binary + stripped
   flags is the strongest launch we will field, offered as best-effort. When a wall
   defeats it (turnstile-class), the prescribed route is the **cookie-seeding handoff**:
   the human authenticates in their own browser, the session seeds those cookies
   (`browser_create` cookies / `POST /v1/sessions` cookies), and the agent proceeds
   from the authenticated state. We do not adopt stealth plugin stacks, CDP-hiding
   shims, or similar evasion machinery — dual-use weight with an unwinnable
   maintenance tail.

3. **The probe is configuration, not detection.** `chromeBinaryPath` is a plain
   constructor/env option (injected so tests exercise the selection logic without a
   Chrome install); its only effect is preferring the branded binary for headed
   sessions. It is not a capability claim and never gates headless.

## Consequences

- Headed sessions get measurably further on login walls than stock, and the two
  real-Chrome benefits (brand-faithful fingerprint, real codecs) apply everywhere
  headed, not just wall-gated sites.
- Documented expectations: turnstile-class walls may still fail headed sessions;
  operators should use the cookie handoff there. The engine's comments and this ADR
  are the contract.
- Headless behavior is bit-identical to before this ADR (pinned by test: headless
  launches never consult the headed options).
- Safari-via-safaridriver (ADR-011) is the complementary macOS path for
  ecosystem-trust walls; both routes land on the same session contract.
