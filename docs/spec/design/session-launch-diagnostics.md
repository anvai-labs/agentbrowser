# Immutable session identity and shared launch diagnostics

Status: merged in PR #288 (`0b1f1da`), pre/post-merge CI 8/8 green. Included in
the 1.11.0 release candidate; publication remains a separate gate. Base: `1a1afc7`
(PR #287). Load only for session inspection, launch diagnosis or the R4 packet in
[consumer research intake](consumer-research-intake.md); no default context expansion.

## Owners and data flow

The existing engine owns browser allocation and captures launch/context decisions.
The coordinator captures the selected adapter name/version before asynchronous setup,
then validates and detaches optional diagnostics once. Capabilities resolve before
allocation, so a rejected capability lookup leaves no inaccessible live session.
One service view builder projects this captured context for create/get/list.

`protocol/session-diagnostics.ts` owns the strict bounded schema, runtime version
validation, detached freeze helper and actual HTTP `SessionView` type. The SDK
aliases that wire type; CLI and MCP only render or forward it. The coordinator's
older capability-bearing result remains distinct from the HTTP view. This corrects
an SDK typing error: HTTP session responses never included `engine.capabilities`.
Existing tenant-field omission in list responses and tenant authorization remain.

Playwright stores the browser and its facts in one allocation. A shared headless/CDP
promise retains both; a dedicated headed allocation carries its own facts. No global
"last launch" cache, second filesystem probe, session registry or diagnostics route
is introduced. Executable provenance comes from the exact selection used to launch;
viewport policy comes from the exact `newContext` option. Init-script registration
is recorded only after the awaited registration succeeds. See [browser ownership](research-browser-ownership.md).

## Bounded snapshot contract

| Field | Meaning / permitted values |
| --- | --- |
| `attachment` | `local_launch`, `remote_cdp`, `unknown` |
| `browserFamily` | `chromium`, `firefox`, `webkit`, `unknown` |
| `browserVersion` | Optional runtime-reported version, bounded to 128 safe characters; distinct from adapter version |
| `executableSelection` | `explicit`, `detected`, `playwright_default`, `not_applicable`, `unknown` |
| `launchMode` | `headed`, `headless`, or `unknown` for a remote browser |
| `resourceModel` | `dedicated_local_browser`, `shared_local_browser`, `shared_remote_connection`, `unknown` |
| `context.isolation` | `new_context` or `unknown` |
| `context.viewport` | `fixed` with bounded dimensions, `no_viewport`, or `unknown` |
| `context.initScript` | `registered`, `not_registered`, `unknown` |

No raw paths, launch flags, profile data, CDP URLs, credentials or adapter error text
are projected. Malformed/extra fields or throwing/changing getters omit the optional
snapshot; session creation still succeeds. Snapshots are detached and deeply frozen.
Other engines may omit diagnostics; consumers must not invent facts from absence.

`playwright_default` does not prove a bundled or branded executable. `no_viewport`
describes context policy rather than measured window dimensions. `registered` does
not prove a script's effects. `navigator.webdriver` would be separately authorized,
page-specific observed evidence and is deliberately not an immutable launch fact.
Remote CDP does not probe this service host's executables or infer remote launch mode;
it creates a new isolated context and does not reuse an operator's logged-in profile.

## Transport and authority contract

REST create/get/list, SDK equivalents and CLI session JSON share the canonical view.
CLI create/get human output uses one formatter. MCP reuses `browser_session`:

- Unbound: required `sessionId`; returns `{sessionId, session, pages}`.
- Bound: injected session ID, with mismatched IDs refused; returns the same fields
  plus existing `control`.
- Both `session.control` and `page.observe` must be present for catalog availability.
  One MCP-local predicate checks the nonempty capability tuple at both filter sites.
  Application-only mode retains its existing catalog; no grant is broadened.

Each SDK read has server authorization. MCP combines those reads and returns no
partial aggregate on error, but this is not one atomic guarded publication. This
packet does not migrate ordinary session reads to the execution/review publisher or
introduce another authority machine. No availability or bot-wall bypass is promised.

## Verification and follow-up

Failing-first regressions cover auxiliary-engine identity drift, capability failure
before allocation, immutable/private-field handling, actual HTTP schema/tenant
behavior, CLI rendering and MCP bound/unbound permissions. Engine tests cover explicit,
detected and default selection, remote unknowns, shared allocation and concurrent
headed isolation. Existing ownership shutdown/failure tests remain required.

The existing [research smoke](../evidence/consumer-research-smoke.md) compares actual
headed create/get/list snapshots through REST, SDK, CLI and MCP, then retains the
13/52 MiB extraction, evidence, cookies, page provisioning and revoked-grant checks.
Build before running it; smoke must pass before commit/PR. Local tests use bounded
workers; normal hooks and one PR CI cycle remain the merge gates.

R5 next: lease/close-cause visibility at the coordinator and engine lifecycle owners,
including stale-event protection. Later profile adoption and journal/recovery require
their own designs. No reconnect/replay, durable store, observed webdriver field or
release/install qualification is enabled by this snapshot.
