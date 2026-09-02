# TD-BROWSER-7: Safari via Safaridriver — WebDriver Engine and Engine Registry

**Status:** Accepted — Phase 1 (engine registry) implemented in this change set
**Context:** 2026-09-02
**Related:** [ADR-011](../adr/011-safari-via-safaridriver-webdriver.md),
[ADR-002](../adr/002-engine-neutral-protocol.md), [ADR-005](../adr/005-ephemeral-sessions-explicit-persistence.md),
[ADR-006](../adr/006-network-egress-policy-ssrf.md), [TD-BROWSER-6](TD-BROWSER-6-headed-sessions-and-credential-handoff.md)

## Problem

Customers must log in to real sites before handing the session to an agent.
The gates that matter most (iCloud Keychain, device-trust SSO, corporate SSO)
accept only **real Safari**; Playwright's `webkit` build is rejected by them.
Safaridriver — Apple's WebDriver implementation, shipped with macOS — is the
only automation surface into real Safari. The service today hardcodes one
engine and has no per-session engine selection.

## Anchors

- **UX**: `{"engine": "safari"}` must create a visible Safari window the user
  can log into by hand; the agent then drives the same sessionId. No env
  archaeology, no restarts (the TD-BROWSER-6 lesson).
- **Performance**: zero cost for the default Chromium path; the Safari engine
  is instantiated lazily on first Safari session.
- **Robustness**: unsupported combinations fail loudly (`EGRESS_UNSUPPORTED`,
  `ENGINE_NOT_FOUND`, `SAFARIDRIVER_DISABLED` with setup instructions) — never
  silent degradation (the TD-BROWSER-6 principle).

## Phase 1 — engine registry (this change set)

`AgentBrowserService` accepts named auxiliary engines
(`ServiceDependencies.engines`) and routes `createSession` by the request's
`engine` field: `"auto"`/absent → the primary engine (unchanged default);
a registered name → that engine; anything else → `ENGINE_NOT_FOUND` (loud).
The coordinator stores the engine per session (already does), so every
existing tool works against any engine's sessions unchanged.

## Phase 2 — safaridriver engine (`engine-safari`)

New package implementing `BrowserEngine` over WebDriver HTTP:

| Contract | WebDriver mapping | Notes |
| --- | --- | --- |
| createSession | `POST /session` (`browserName: "safari"`) | always headed; `headless: true` → `SAFARI_HEADLESS_UNSUPPORTED` (loud) |
| newPage | new window handle (`POST /session/:id/window`) | pageId ↔ window handle |
| navigate | `POST /session/:id/url` | `waitUntil` degrades to document-ready |
| observe | injected script computing the protocol's semantic schema (role/name/value/ref fingerprint) | same refs contract: `e<rev>_<n>` |
| act | WebDriver element interactions (`element/click`, `value`, keys) | approval gates unchanged (ADR-007) |
| cookies (export/import) | `GET/POST/DELETE /session/:id/cookie` | **httpOnly included** — strongest credential handoff in the fleet |
| screenshot/pdf | screenshot ✓; PDF unsupported → loud | |
| egress (ADR-006) | **NOT enforceable** — requests with a policy → `EGRESS_UNSUPPORTED` | never silent |
| events (console/crash) | partial: JS errors via script injection; crashes via driver exit | documented gap |

Enablement: `safaridriver --enable` (one-time, user-authorized). The engine's
first launch probes the driver and fails with `SAFARIDRIVER_DISABLED` plus the
exact command, per the loud-failure principle.

## Test plan

- Registry (Phase 1, in this change set): routing to named engines, default
  route, loud unknown-engine error — FakeEngine-based, no browsers needed.
- Phase 2 (macOS, gated on `safaridriver --status`): the full
  `runEngineContractSuite` against real Safari, plus a cookie handoff test
  (seed → export → re-import round-trip) and an `EGRESS_UNSUPPORTED` test.
  Linux CI skips via the same availability gate the firefox suite uses.

## Non-goals

- Headless Safari (impossible), non-macOS Safari (impossible), WebInspector
  CDP bridges (undocumented, brittle), multi-Safari-version pinning.
