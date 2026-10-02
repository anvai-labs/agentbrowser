# Release 1.15.0 delivery record

Status: released from develop commit (this PR's head), main merge and tag
v1.15.0 follow the promotion PR. Built by `.github/workflows/release.yml`
(release assets on GitHub Releases; `@anvailabs/agentbrowser-mcp` on npm
per [ADR-014](../../adr/014-npm-distribution.md)).

## What shipped (develop range ee9b999..this release)

- F1 all-hop egress enforcement: redirect chains walked in the routing
  choke point with per-hop verdicts, a redirect cap, and loop detection;
  the R4 later-redirect policy bypass is closed (truth guard flipped to
  pin the fix, zero forbidden hits on real Chromium).
- F2 journal clock-movement rows: admission/retention horizons monotonic
  across wall-clock rollback via the persisted high-water; reopen below
  the persisted high-water refuses as configuration.
- T6 frame observation slices 1/1b/2: child-frame observation and
  frame-scoped ref binding, the frameCoverage block through all four
  layers, frame-extended fileInputs/formControls scans, frame-scoped
  form identity with act-time re-verification through the owning frame,
  per-frame snapshot slices, and the child-frame egress pin.
- N1 slice 1: pageerror capture, cursor paging on events/replay, bounded
  vocabulary emission hygiene, redaction pin.
- N1 slice 2: the events/replay surface outside REST —
  browser_events_replay MCP tool (17/15 catalog), session events
  --since/--limit CLI paging, SDK paged overload.
- Operator loopback opt-in (AGENTBROWSER_ALLOW_LOOPBACK) for
  local-machine sessions, with the named page→service-self escalation
  disclosure.
- T8: installed 1.14.0 MCP tool-call path + cursor
  consumption/retirement qualified; explicit footprint gates (peak RSS
  on the shipped binaries) CI-enforced.

## Evidence

- Frame budgets: t6-frame-budgets.md.
- Frame-observation design + handoff: t6-frame-observation.md,
  consumer-ovh-iframe-observation-2026-09-30.md.
- N1 design: n1-bounded-network-observation.md.
- Installed harnesses: t8-installed-harness-availability.md (2026-10-01
  MCP-path + cursor updates).
- Foundation-first refinements: tasks/foundation-refinements.md.
