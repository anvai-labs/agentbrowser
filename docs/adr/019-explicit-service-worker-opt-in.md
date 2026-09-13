# ADR-019: Explicit Per-Session Service-Worker Opt-In

**Status:** Accepted
**Context:** 2026-09-13
**Related:** [ADR-006](006-network-egress-policy-ssrf.md) (network egress policy / SSRF
choke point), [ADR-013](013-headed-sessions-and-walled-logins.md) (headed sessions,
de-fingerprinting, and walled logins - "the probe is configuration, not detection")

## Context

Real job-application submissions on a live Ashby-hosted ATS (`jobs.ashbyhq.com`) were
rejected at "Submit Application" with "flagged as possible spam" - reproduced twice, on
two different postings, once from an accidental automated click and once from a human
deliberately clicking Submit inside the same headed session. Reproduction with a genuine human click suggests a browser-context or session
factor, but does not establish which signal caused the rejection.

The v1.8.10 body-corruption fix (ADR-006's Implementation Notes) already routes
POST/PUT/PATCH requests through native `route.continue()` passthrough without body
replay. Investigation also confirmed that `createSession()` sets
`serviceWorkers: 'block'` on the browser context whenever a request policy is attached
(effectively every session created through the API service), because Playwright's
`context.route()` - the mechanism the egress choke point depends on - cannot intercept
requests made by a Service Worker. This is a still-open upstream limitation
([microsoft/playwright#1090](https://github.com/microsoft/playwright/issues/1090));
Playwright's own documentation recommends blocking service workers whenever request
interception is in use, for exactly the reason the code comment already gave: "a choke
point with a bypass hole is not a choke point."

That default is necessary for the routing-based SSRF boundary, but prevents sites
from using service workers. Whether this restriction contributed to Ashby's rejection
is an open hypothesis. Live verification of this opt-in and the accompanying headed
`navigator.languages` change against Ashby remains incomplete; neither change has
been demonstrated to resolve the rejection.

This is not a bug to patch silently. It is a real, disclosed trade-off between two
things a session cannot always have simultaneously: full egress-choke-point coverage,
and compatibility with a destination whose own behavior depends on service workers
actually running. ADR-013 already establishes how this project treats site-side
detection it cannot outrun: no stealth or evasion machinery, but an explicit,
caller-configured choice is fine ("the probe is configuration, not detection"). This
case fits that shape exactly, just at the network-policy layer (ADR-006) rather than the
launch-fingerprint layer (ADR-013).

## Decision

Add `allowServiceWorkers`, an explicit, off-by-default session option, threaded end to
end: MCP tool (`browser_create`) -> REST API (`policy.allowServiceWorkers` on
`POST /v1/sessions`) -> CLI (`--allow-service-workers`) -> `AgentBrowserService` ->
`SessionCoordinator` -> `EngineSessionOptions.allowServiceWorkers` -> the Playwright
engine's context-creation options.

When a session's request policy is active and `allowServiceWorkers` is **not** set, the
context still gets `serviceWorkers: 'block'` - today's behavior, unchanged. When a
caller explicitly passes `allowServiceWorkers: true`, that override is skipped and
service workers run normally for that one session. A caller who does this is
consciously accepting that service-worker-originated requests in that session will not
be checked by the egress choke point - not a silent weakening, not a new default, and
not evasion of anything on the destination site's side. It changes nothing about how the
browser presents itself; it only stops blocking a browser feature that a legitimate site
may depend on.

## Consequences

- Sessions that don't opt in are bit-identical to before this ADR: `serviceWorkers:
  'block'` still applies whenever a request policy is attached. Pinned by test
  (`playwright-engine.test.ts`, "service-worker choke-point opt-in (ADR-019)" -
  including a real-Chromium behavioral check that a service worker never reaches the
  `active` state by default, and does when explicitly allowed).
- A caller can enable service-worker-dependent functionality for one session with
  `allowServiceWorkers: true`, accepting the loss of routing-based egress coverage
  for service-worker traffic.
- The tests establish service-worker registration behavior and option propagation.
  They do not establish the cause of Ashby's rejection or prove that enabling service
  workers or changing the headed language chain resolves it.
- Does not reopen the choke point for anything except the caller's own explicit request:
  the option is per-session, must be set at session-creation time, and is visible on
  the session request the same way `allowedHosts`/`blockedHosts`/`allowDownloads` are.
- No launch-fingerprint changes and no interaction with ADR-013's headed
  de-fingerprinting - this is purely a network-policy-layer option and applies to
  headless and headed sessions alike.

## Rationale

Building stealth machinery to make automation *look* like it has a working service
worker while still blocking its network traffic would be exactly the "arms race" ADR-013
already declines to fight, and would not actually be true - the goal here is to let a
real service worker run, not to fake one. Silently changing the default (always allowing
service workers) would quietly reopen the SSRF bypass ADR-006 closed. An explicit,
off-by-default, caller-initiated opt-in is the only option that is both honest about the
trade-off and safe by default.

## Related Decisions

- [ADR-006](006-network-egress-policy-ssrf.md) - the choke point this option carves a
  disclosed, opt-in exception into.
- [ADR-013](013-headed-sessions-and-walled-logins.md) - the precedent for "the probe is
  configuration, not detection" and for declining to build evasion machinery against
  site-side defenses.
- [docs/threat-model.md](../threat-model.md) - "Service-worker choke-point bypass"
  entry.

## Implementation Notes

- `packages/engine/src/types.ts`: `EngineSessionOptions.allowServiceWorkers?: boolean`.
- `packages/engine-playwright/src/index.ts` (`createSession`): the context-creation
  option is now `...(egress !== undefined && options.allowServiceWorkers !== true ?
  { serviceWorkers: 'block' as const } : {})`.
- `packages/protocol/src/{schemas,types}.ts`: `SessionPolicy(Schema).allowServiceWorkers`.
- `packages/api/src/server.ts`: flattens `policy.allowServiceWorkers` onto
  `ServiceSessionRequest`, alongside `allowedHosts`/`blockedHosts`/`allowDownloads`.
- `packages/api/src/service.ts` (`createSession`): copies it onto the engine request.
- `packages/core/src/session-coordinator.ts` (`create`): copies it onto
  `EngineSessionOptions` before calling `engine.createSession` - this is the layer that
  previously silently dropped it even after `service.ts` set it, since the coordinator
  builds its own options object field-by-field rather than passing the request through.
- `packages/cli/src/cli.ts`: `--allow-service-workers` rides the same nested `policy`
  object as `--allow-downloads`/`--allow-hosts`/`--blocked-hosts`.
- `packages/mcp-server/src/mcp-server.ts` (`browser_create`): a top-level tool
  parameter, mapped onto `request.policy.allowServiceWorkers`.
