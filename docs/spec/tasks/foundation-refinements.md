# Foundation-first refinements (2026-09-30, from the tooling comparison)

The published comparison (../../comparison.md) made the plan's ordering
testable: AgentBrowser's governance layer (refs, staleness, approvals,
tenancy) is differentiated, its absence of a debug surface is a deliberate
boundary, and its load-bearing weakness is that egress containment is
partial. Future tasks that make safety claims (T6 live gates, T7 scope
enforcement, the bounty use case) would compound on that sand. The
foundation-first order is therefore:

- **F1 — all-hop egress enforcement (gates T6 live gates and T7 scope
  enforcement). DELIVERED 2026-09-30.** The routing choke point now walks
  redirect chains Node-side — fresh verdict, ten-hop cap, loop detection
  per hop — fulfills only the terminal response, and disposes
  intermediates; the R4 truth guard was flipped to pin zero forbidden hits
  on real Chromium, and the threat model's row moved to resolved with the
  residuals named (body-bearing POST/PUT/PATCH passthrough, DNS pinning,
  OS containment).
- **F2 — clock-movement conformance rows (finishes T5's CI-testable
  surface).** Backward/forward clock movement, rollback detection and
  wall-clock-below-persisted-high-water refusals in the fake-timer record
  conformance, completing the journal's gate surface before any C4b
  runtime-enablement decision.
- **F3 — C4b durable-journal runtime enablement.** The first public
  durable-journal capability (delegated-session receipts stop being
  ephemeral). Requires explicit user authorization to enable; not
  self-starting.
- **N1 — bounded network-error observation (comparison-informed, design
  first).** The comparison shows debugging depth is chrome-devtools-mcp's
  lane by choice; the missing agent-relevant slice is bounded,
  policy-filtered network/console *error facts* as evidence (not JS eval,
  not bodies, not traces). Design against the ADR-009 boundary before any
  implementation; a generic URL blocklist is not that evidence.
- **N2 — OS-enforced egress pairing.** The threat model already says
  hostile multi-tenancy needs an OS-level layer; make that an explicit T7
  prerequisite with the pairing documented, per the egress-transport
  reassessment's "not a substitute" boundaries.

Sequence: F1, F2 (independent, small) -> F3 decision point (user
authorization) -> T4 production evidence -> T6 normalization/live gates ->
T8 installed qualification -> T1 consumption -> T7, with N1/N2 slotted by
design readiness.
