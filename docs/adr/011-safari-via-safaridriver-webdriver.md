# ADR-011: Real Safari via Safaridriver (WebDriver), Not Playwright WebKit

**Status:** Accepted
**Context:** 2026-09-02
**Related:** [ADR-002](002-engine-neutral-protocol.md) (engine-neutral contract),
[ADR-005](005-ephemeral-sessions-explicit-persistence.md) (credential handoff),
[TD-BROWSER-7](../td/TD-BROWSER-7-safari-webdriver-engine.md) (spec)

## Context

The #1 interactive-login workflow (human authenticates, agent continues) lands
on sites gated by Apple-ecosystem trust: iCloud Keychain autofill, device-trust
SSO, and corporate SSO that device-binds to the real Safari. Playwright's
`webkit` build is *Safari's engine*, not Safari — it has no Keychain, no
device trust, and a different fingerprint, so those gates reject it. Today the
service is Chromium-only (`bin.ts` hardcodes one engine).

## Decision

Support **real Safari on macOS via `safaridriver`** — the WebDriver
implementation Apple ships with the OS — as a new engine
(`engine-safari`/`playwright`-independent), accessed through the existing
`BrowserEngine` contract and the per-session engine registry (TD-BROWSER-7).

- **WebDriver, not CDP/Playwright**: safaridriver speaks the W3C WebDriver
  protocol per driver process; the engine is a thin WebDriver HTTP client.
- **Always headed**: Safari has no headless mode. Safari sessions are the
  interactive-login artifact — always visible, always a dedicated engine
  instance, consistent with TD-BROWSER-6's ownership model.
- **Cookie handoff is first-class**: WebDriver exposes session cookies
  (including `httpOnly`) for export *and* import, so ADR-005's loop
  (log in once → export → seed future sessions) is native here — stronger
  than the Chromium path, where export needed the TD-BROWSER-6 route.
- **Egress honesty**: WebDriver cannot intercept network traffic. The egress
  choke point (ADR-006) is **not enforceable** on this engine; requests
  asking for egress policy on Safari fail loudly (`EGRESS_UNSUPPORTED`),
  never silently unguarded — the TD-BROWSER-6 principle.
- **macOS-only, enablement-gated**: `safaridriver --enable` (one-time,
  user-authorized) is required; the engine fails loudly with setup
  instructions on other platforms or when disabled.

## Consequences

- Real-Safari login flows become automatable — the highest-value interactive
  scenario this product exists for.
- The engine-registry (TD-BROWSER-7 Phase 1, this change set) is the general
  routing mechanism; Safari is its first consumer.
- Observation fidelity is WebKit-flavoured: the semantic-observation script
  computes role/name/value per the protocol schema; visual differences vs
  Chromium are recorded in observations, not hidden.
- No headless Safari, ever — headless fleets stay on Chromium.

## Alternatives considered

- **Playwright WebKit as "Safari"**: rejected — different binary, no Keychain
  or device trust; claims to cover Safari would be false comfort.
- **WebDriver-biometric style CDP bridges**: rejected — Safari's WebInspector
  protocol is undocumented and brittle per release.
