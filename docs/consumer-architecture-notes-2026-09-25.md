# Consumer architecture notes — bird's-eye review of v1.11.0, 2026-09-25

**Status:** Advisory observations from an intensive consumer (2026-09-24/25
research workload + UI audits). No decisions made here; several items land
inside existing ADRs/T-tasks and say so.
**Reviewed:** v1.11.0 tree, live brew service behavior across ~80 tool calls
(EDGAR research, UI audits, smoke runs).

## What is already strong (keep doing this)

* **Contract-test culture.** The engine is wrapped in 23+ focused test
  files (egress boundaries, popup lifecycle, fill verification, refusal
  details, browser ownership, launch diagnostics…). The 1.11.0 protocol
  corrections from live verification were possible because failures were
  typed and testable.
* **Bounded everything.** Observations are size/element-bounded,
  extraction has a response budget (1.11.0), artifacts expire, sessions
  have leases. Token-discipline is a first-class design constraint.
* **Safety spine.** Single egress choke point, approval gates, secret
  redaction, loud refusals (ADR-011 pattern) — held up under a full day
  of hostile-site work.
* **Changelog quality.** 1.11.0's entries read like consumer release
  notes, which is exactly why a consumer could re-verify their own
  findings against it in minutes.

## Scale recommendations

1. **Decompose the two god-files.** `api/src/service.ts` (4,405 lines)
   and `engine-playwright/src/index.ts` (3,428 lines) each hold launch,
   lifecycle, routing, and domain logic in one class/module. The seams
   already exist (`session-authority.ts`, `http-publication.ts`,
   `connection-authority.ts` are prior extractions); continue along them
   — one extraction per T-task PR. Payoff is not aesthetics: ten open
   T-tasks currently touch the same two files, which is merge friction
   and review-surface risk at exactly the moment parallel work is
   increasing.
2. **Prioritize T5 durable recovery over new features.** The 1.11.0
   storage-neutral operation journal is the right truck: today a service
   restart (or the 10-minute idle reaper) orphans every session, and the
   2026-09-24 audit lost three sessions mid-work with full manual
   re-entry. Journal-backed session resume converts the largest
   remaining consumer pain into a non-event.
3. **Engine pooling behind the ADR-010 benchmark gate.** Sessions
   allocate dedicated browsers; 1.11.0 began sharing pending
   initialization. A small bounded pool (N contexts per browser,
   contexts — not browsers — as the tenant isolation boundary in hosted
   mode) would cut launch latency and memory for fan-out workloads.
   Measure pool-vs-dedicated through the ADR-010 harness before
   committing to a default.
4. **Reaper granularity.** The sweep is a single `setInterval` walking
   all sessions. Fine at lab scale; when tenants multiply, prefer
   per-session deadlines in a min-heap (or per-session timers) and emit
   the close-cause at the sweep point (pairs with handoff Brief 2).
5. **Tenant-key the journal from day one.** ADR-008 puts hostile
   multi-tenancy in containers, but any journal/artifact store that
   outlives a process must be tenant-keyed at the key level before
   hosted mode ships — retrofitting tenancy into storage is the classic
   leak.
6. **Artifact delivery thresholds.** MCP screenshots inline base64 (a
   132 KB response overflowed the consumer's tool budget). Default to
   reference-by-ID with `artifact get` for anything over a small
   threshold (e.g. 32 KB), inline only below it. Bandwidth + agent
   context budget both win.

## UX recommendations

7. **Finish the failure taxonomy (Brief 1).** 1.11.0's typed
   `browser_error_document` failure was immediately useful; the NXDOMAIN
   case is the remaining gap (still bare `blocked`).
8. **Session resume UX (with item 2).** When a session dies, the error
   should carry `closeCause` + `leaseRemainingMs` (Brief 2) and — post-T5
   — a resume handle. "Your session died and you can get it back" is the
   single biggest trust upgrade for long audits.
9. **MCP surface parity.** `browser_page_create`/`browser_pages` shipped;
   keep the MCP catalog mechanically derived from the REST surface (the
   generated tool catalog doc is the right instinct) so CLI/REST/MCP
   never drift again (the 1.11.0 page verbs existed at the service layer
   before the MCP exposed them).
10. **Recipes for the walls.** With Brief 1's taxonomy, publish a
    short "reading a failed navigation" explainer next to the EDGAR
    recipe (Brief 4): what `dns_nxdomain` vs `browser_error_document` vs
    `egress_policy` means, and the sanctioned escape hatch (cookie
    seeding, ADR-013) for each class.

## Non-recommendations (considered and declined)

* **Rust engine now** — ADR-010 already gates this on benchmarks; the
  1.11.0 numbers do not present a control-plane bottleneck, and the
  god-file decompositions (item 1) are the cheaper performance lever.
* **Replacing in-process Maps with Redis/Postgres today** — the journal
  contract (T5) is the intended seam; adding an external store before it
  matures would create a second source of truth.
