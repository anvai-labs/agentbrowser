# ADR-016: Headed Sessions Prefer the Operator's Chrome; Window-True Viewport

**Status:** Accepted (implemented 2026-09-08)
**Context:** 2026-09-08
**Related:** [ADR-013](013-headed-sessions-and-walled-logins.md) (headed
sessions / de-fingerprinting — its turnstile conclusion is unaffected here),
[TD-BROWSER-10](../td/TD-BROWSER-10-session-extension-loading.md) (extension
loading workaround), [TD-BROWSER-11](../td/TD-BROWSER-11-session-initial-page-race.md)
(testbed findings)

## Context

Two defaults in headed sessions force automation-visible behavior that the
operator's own browser would not have:

1. **Bundled Chromium is the default binary.** `headedChromiumOptions()` only
   overrides `executablePath` when `AGENTBROWSER_CHROME_PATH` is set, and its
   default is a Linux path — so on macOS/Windows every headed session runs
   Playwright's bundled Chromium. Consequences observed live
   ([TD-BROWSER-10](../td/TD-BROWSER-10-session-extension-loading.md)):
   password-manager extensions cannot load, native-messaging hosts resolve
   against the wrong branding dirs, proprietary codecs are missing, and any
   site behavior keyed to real-world Chrome surface diverges. The documented
   workaround is a wrapper script; it works but is server-wide operator
   plumbing for what is fundamentally a default-choice problem.

2. **A fixed emulated viewport is always pinned.** The engine creates every
   context with `viewport: options.viewport || { width: 1280, height: 720 }`.
   Resizing the headed OS window does not resize the page — the site renders
   at the emulated size inside a larger window, which reads as breakage
   (observed live 2026-09-08 on Dice) and further distances headed sessions
   from "a real browser window".

## Decision

**1. Binary resolution for headed launches:** `AGENTBROWSER_CHROME_PATH`
(explicit override, unchanged) > **detected branded Chrome** (well-known
paths per OS: `/Applications/Google Chrome.app/...`, `google-chrome`,
`chrome.exe` program files) > bundled Chromium. Headless launches are
unchanged (headless shell; extensions unsupported there by construction per
TD-BROWSER-10). A server-start escape hatch (e.g.
`AGENTBROWSER_PREFER_BUNDLED=1`) keeps CI and test farms deterministic —
the default is intentionally machine-dependent because its purpose is to
match the operator's machine.

**2. Headed viewport default becomes window-true:** when a headed session
does not request a viewport, create the context with `viewport: null` plus
`--start-maximized`, so the page follows the OS window. An explicit
`viewport` in the request still pins exactly as asked (headless automation
keeps today's 1280×720 default). Rationale: for headed, human-in-the-loop
sessions the window IS the interface (ADR-013); emulating a different
viewport inside it only produces confusing rendering.

## What this does not claim

Per [ADR-013](013-headed-sessions-and-walled-logins.md): a headed window
driven through CDP is still detectable as CDP-driven; branded Chrome does
**not** make automation pass turnstile-class walls. This ADR is about
surface compatibility (extensions, native messaging, codecs, window
geometry), not anti-detection.

## Consequences

- Version drift returns: branded Chrome moves independently of the
  Playwright driver. Acceptable — Playwright tolerates nearby versions, and
  TD-BROWSER-10's wrapper path has been running branded Chrome in production
  use since 2026-09-08 without protocol issues. The first-launch-after-update
  wrinkle (Chrome's one-time post-update work) originally sketched a
  launch-time retry/budget; that is superseded — TD-BROWSER-11's correction
  established there is no create-then-navigate race to trip over, so no
  retry code ships.
- Binary detection must be logged at session create (which binary won), so
  machine-dependent behavior is explainable after the fact.
- Test suites that assert launch args need the escape hatch in CI.
