# Research sessions: browser ownership prerequisite

Status: implementation candidate after PR #286; launch diagnostics remain proposed.
Load only for [research follow-ups](consumer-research-intake.md), session lifecycle
or engine ownership work. This does not expand default mode context.

## Problem and observed failures

A local probe on the PR #286 tree produced two launches for two concurrent headless
session creations. The engine cached only a resolved browser, so both callers
passed the empty-cache check. Closing the engine could release only the last one.

The same probe connected to its own external Chromium and created two contexts.
Closing a session requested with `headless: false` disconnected its sibling while
the external browser process remained alive. The remote session had incorrectly
received ownership of the engine's shared connection.

Service shutdown also closed only its primary engine. Auxiliary engines' contexts
were closed by the coordinator, but their shared pools/connections were not released.
Diagnostics must not be built on top of ambiguous resource ownership.

## One owner per resource

| Lane | Browser/connection owner | Session owner |
| --- | --- | --- |
| Local headless | Existing engine's shared browser promise | New isolated context |
| Local headed | Dedicated browser transferred to the ready session | Browser and context |
| Remote CDP | External host owns process; existing engine owns connection | New isolated context only |

The engine caches initialization itself, not only its result. Concurrent callers
share one launch/connect. A failed initialization clears only its own cache entry,
allowing a subsequent explicit create to try again. No action or create is replayed.

Engine close is terminal for that instance. It stops admission, drains pending
session setup, then closes its shared browser/connection once. Checks after launch,
after context creation and before session publication refuse setup that overlaps
shutdown. Late dedicated launches and contexts are cleaned by their setup owner.
Already published dedicated sessions remain session-owned; service shutdown closes
sessions through the coordinator before closing every distinct registered engine.
Registry aliases are deduplicated by object identity, and one close failure does
not skip another engine. The first engine-close failure is still reported.

One private cleanup helper releases a context and any dedicated local browser on
setup failure or normal session close. Browser cleanup is attempted even when
context/page cleanup fails. Setup preserves its original error. Invalid snapshot
timeout input is refused before allocating resources.

This is a drain, not a force-kill or bounded shutdown guarantee. A driver that never
settles can hold shutdown open. This packet does not automatically replace a cached
browser after a later disconnect, restore sessions/grants, or add durable recovery.
New-context CDP remains distinct from operator-profile adoption.

## Acceptance and evidence

- Concurrent local/CDP initialization, shared failure and explicit retry.
- Dedicated local headed separation, remote context-only close, idempotent engine close.
- Shutdown during launch, context creation and late cookie setup: no session publication
  and resources released before shutdown completes.
- Failure at context creation, init-script registration, routing or cookie seeding:
  release only owned resources; preserve original setup failure if cleanup also fails.
- Real CDP sibling observation after a headed-request session closes; external host
  remains connected after the engine releases its client connection.
- Service closes distinct primary/auxiliary engines after sessions, with alias
  deduplication and failure isolation.
- Rerun the existing headed [research smoke](../evidence/consumer-research-smoke.md)
  before commit: retain complete extraction, evidence, tabs, cookies and authority.

Local validation before commit: 29 ownership tests, 147 service tests, and the
existing headed/remote engine tests passed; workspace build, type checks and lint
passed. A real-browser before/after probe changed concurrent launches from two to
one and remote sibling survival from false to true; the external host remained
connected. The rebuilt headed research smoke passed with unchanged extraction
bytes and evidence hashes for both 13/52 MiB fixtures. It closed only its own
sessions/service. These checks do not qualify installed harnesses or a new release.

## Next R4 contract, not yet implemented

Capture immutable selected adapter name/version at session creation; current
create/get/list can mix an auxiliary name with the primary engine's version.
Keep actual browser runtime version separate. Capture launch facts once at the
engine, validate a bounded protocol snapshot, and project it through existing
service/SDK/CLI/MCP views. Do not repeat detection in each transport.

Prefer factual labels: `playwright_default` selection, `no_viewport`, init script
`registered`. For remote CDP, launch mode is unknown and executable selection is
not applicable. Local launches can report headed/headless and the actual local
selection. Exclude raw paths, arguments, profile names, CDP URLs, credentials and
environment values. `navigator.webdriver` is a separately authorized page observation.

Resolve MCP inspection capability parity explicitly: current `browser_session`
advertises `page.observe` but calls a control endpoint requiring `session.control`.
Do not silently broaden a grant or copy diagnostics into another authority's response.
Ordinary session inspection does not yet promise the guarded publication used by
browser/review execution; do not claim that guarantee without its shared-owner adoption.
