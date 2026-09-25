# Session disconnect qualification

Date: 2026-09-25. Unreleased source built on reviewed R5b1 `5583354` and operator
CDP attachment `752da5e`. Package version remains 1.11.0; these results qualify the
candidate source, not the installed Homebrew binary or logged-in background service.
The final branch is aligned to the R5b1 develop merge `4a6c5f2`.

## Failing-first and regression evidence

- Engine observer baseline: 5 of 6 initial tests failed before the port and observer.
- Coordinator baseline, repeated on R5b1: all 8 disconnect tests failed before binding
  the engine signal. They now pass alongside 92 existing coordinator tests.
- API baseline: both new tests failed before composition. They now prove immediate
  delegated revocation, bounded operator-only terminal details, cross-tenant denial,
  and a disconnect event that is not falsely labeled expiry.
- Headed smoke before implementation: the fixture Chrome process exited but session
  GET returned 200 instead of 404. The same product-level smoke now passes.
- Final adversarial review caught a public state/cause contradiction. New assertions
  failed in protocol and core before adding public state `engine_disconnected` and
  mapping the observed cause to it. The legacy internal state stays unchanged; API
  and headed smoke also assert the public state.

Focused results: engine interface 28/28, adapter observer/ownership/diagnostics 69/69,
coordinator 100/100, and API lifecycle/retained-artifact/edge-case coverage 67/67.
The full Playwright adapter suite passed 388/388 outside the browser/socket sandbox.
Workspace build and type checks passed after rebuilding the inherited R5b1 SDK exports.
Independent review of the coordinator, service and smoke found no behavioral or
authorization blocker; the primary reviewed the separately authored engine changes.

## Headed product smoke

```bash
node scripts/cdp-attach-smoke.mjs --disconnect
```

Observed output:

```json
{"disconnectQualification":"PASS","closeCause":"engine_disconnected","lastPageClosePreservesSession":true,"transports":["REST","SDK","CLI","MCP"]}
{"qualification":"PASS","productVersion":"1.11.0","browserVersion":"154.0.8037.57","endpointClass":"loopback_http","profileSharing":true,"unownedTabsPreserved":true,"ownedPopupAdopted":true,"detachPreservedBrowser":true,"disabledRefusal":"CDP_ATTACH_DISABLED"}
```

The fixture owns its Chrome process and disposable profile. Closing its last owned
page leaves the session usable and another page can be created. Terminating the fixture
process produces an authenticated 404 terminal report, zero remaining availability,
and the original lease deadlines. SDK, CLI and MCP project the same cause; requests
without credentials fail authentication. The existing browser/profile ownership and
disabled-configuration checks run in the same smoke. No logged-in service or unrelated
browser process is stopped.

Wrong-tenant and delegated-grant checks use an isolated fake-engine signal fixture:
operator CDP intentionally permits one trust domain and refuses delegated mode.

## Limits

`engine_disconnected` is an observed loss of the backing browser or context. It does
not identify the human or process responsible and does not assert a crash. Page-only
close/crash events remain page facts. An adapter without the optional signal cannot
provide this classification. Terminal history remains bounded and in memory; this
change adds no reconnection, replay, durable recovery or profile restoration.

See the [design](../design/session-disconnect.md) and
[close-cause foundation](../design/session-close-causes.md).
