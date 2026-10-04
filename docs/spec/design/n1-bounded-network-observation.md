# N1: bounded network and console error observation — gap-fill design

Status: slice 1 DELIVERED 2026-09-30; G4 (events replay) DELIVERED in 1.15.0.
Design-first per the foundation-first refinements
(docs/spec/tasks/foundation-refinements.md); the implementation is
recorded in this packet's delivery-status section below.

## Ground truth first: most of this layer already ships

The first draft of this packet proposed building a fact layer that — the
adversarial review of the draft proved — substantially exists:

- **Bounded event ledgers** live in the service, not the engine:
  `requestHistory` (1000 entries) and `eventHistory` (console, 500 entries),
  `JsonLedger` pairs with a 64 KiB per-entry cap and eviction metrics
  (`packages/api/src/service.ts`, the spec 5.1 network summary comment).
- **A replay surface** already serves them: `GET
  /v1/sessions/{sessionId}/events/replay` (`openapi.ts`, `server.ts`,
  `service.ts`) with a `?type=` filter and `NOT_FOUND` for missing sessions.
- **Console capture exists engine-side**: `page.on('console')` with
  sessionId/pageId attribution, detached on page close (hygiene D1).
- **Policy denials are already recorded**: the all-hop walker and the
  routing deny paths emit blocked facts with reasons.

So N1 is not "add a fact layer". N1 is the **gap-fill** that makes the
existing fact layer complete, trustworthy, and discoverable — without
duplicating any of it at the wrong layer.

## The actual gaps

| # | Gap | Evidence it is real |
| --- | --- | --- |
| G1 | `pageerror` is never captured — no listener exists anywhere in the engine; uncaught page exceptions are invisible to agents | zero `pageerror` references in `engine-playwright/src` |
| G2 | Replay paging is type-only — no `since`/`limit`, so an agent asking "what failed since my last action" replays the whole ledger | replay OpenAPI parameters |
| G3 | Redaction of stored console/network entries is unverified — the service redacts *outputs*, but whether ledger entries pass through `SecretManager` before storage is not established | `service.ts` redaction sites vs ledger writes |
| G4 | The facts are invisible outside REST — no MCP tool or CLI surface exposes `events/replay`, so the catalog's consumers cannot ask the question at all | catalog + CLI docs |
| G5 | F1 denial details leak unbounded/unredacted text and query strings: `REDIRECT_LOOP`/`MAX_REDIRECTS (N hops)` are free-form strings outside the bounded `NavigationFailureReason` vocabulary, and two walker emissions carry `search` in the redirect field | walker emission sites |
| G6 | Fact rows lack `pageId` — sessions are multi-page (F10 popups); an agent cannot attribute an entry to "this page" | service attribution exists; projection omits it |

## Boundary (unchanged from the first draft)

ADR-009 stands: no `evaluate()`, no raw network handles, no response or
request bodies, no timing traces, no replay-execution. Facts are events the
service already observes at existing choke points; nothing new is
intercepted except the `pageerror` event. Every stored entry is byte-capped
(existing 64 KiB per-entry cap) and the ledgers stay bounded (existing
counts). This is not debugger parity with chrome-devtools-mcp — failure
facts, not a debugger.

## The work, sized

1. **G1 — pageerror capture**: an engine `pageerror` listener beside the
   existing console listener, routed through the same sessionId/pageId
   attribution into `eventHistory`. Entry marked `untrustedContent: true`.
   Hermetic engine unit: uncaught page exception lands in the ledger,
   detached on close, redacted through the registry (this gate also settles
   G3 for console lines — if today's ledger stores raw text, the fix lands
   here and the test names it).
2. **G2 — paging**: `since` (event sequence id or timestamp) and `limit` on
   replay; response carries the next cursor. Budget on the envelope per the
   existing extraction-budget discipline. Hermetic service tests: ordering,
   cursor edges, foreign-session `NOT_FOUND`.
3. **G5 — vocabulary and hygiene**: walker/routing reason strings mapped
   into the bounded `NavigationFailureReason` vocabulary (R3's
   classification pattern — `MAX_REDIRECTS`/`REDIRECT_LOOP`/size-cap codes
   map to `egress_policy` with the detail in the existing bounded
   `details`), and the two redirect-emission sites strip `search` from the
   redirect field like every other URL field.
4. **G4 — surface exposure**: one MCP tool (`browser_events_replay`) and a
   CLI subcommand over the same projection. Catalog deltas stated per
   profile — the full profile is 16 tools and the reduced profile 14 today,
   so 16→17 and 14→15; `docs/mcp-tool-catalog.md` and schema sync are the
   pins (there is no numeric count test today; the docs plus schema sync
   are the contract).
5. **G6 — pageId in the projection**: replay rows carry the pageId the
   service already attributes; the projection type includes it.

## TDD gate plan

Engine units (G1): pageerror lands, detaches cleanly, untrusted flag,
redaction with a canary secret. Service units (G2): cursor paging, envelope
budget, foreign-session NOT_FOUND. Vocabulary units (G5): every walker
denial emission maps into the bounded vocabulary — a truth-guard asserts
today's free-form strings fail the map, then the map lands. Surface tests
(G4): catalog/schema sync, CLI JSON identity with REST. One real-Chromium
end-to-end: a fixture page with an uncaught exception, a failing
subresource, and a policy-denied navigation yields exactly the bounded
facts with pageId attribution and a denied hop named.

## Non-goals

Debugger parity; bodies; headers beyond status; timing; WebSocket frames;
JS eval; capture before session start; pushing facts into per-call results
(the replay surface exists precisely so cost tracks the question).

## Sequencing

This design review first. Then two PRs: (1) engine + service gap-fill
(G1, G2, G3, G5, G6) with the unit gates; (2) surface exposure (G4) with
catalog/CLI/schema sync. Each carries its own evidence record per T9.

## Delivery status

- **Slice 1 DELIVERED 2026-09-30**: G1 pageerror capture (untrusted, real
  Chromium-pinned); G2 cursor paging on replay (`since`/`limit` require a
  type filter — cursors are per-stream ledger sequences; the legacy
  positional/array form is preserved for every existing caller); G3
  verified as already-shipped (the event pump redacts through the
  SecretManager before storage — pinned by a canary test rather than
  rebuilt); G5 walker denials mapped to the bounded `egress_policy`
  reason with bounded `detail`, and redirect location fields stripped of
  query strings; G6 pageId confirmed present on rows.
- **Slice 2 (G4 — MCP/CLI surface exposure)** remains.

