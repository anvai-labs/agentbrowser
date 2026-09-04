# Changelog

All notable changes to **AgentBrowser** are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); releases are tagged `vX.Y.Z` and
built by `.github/workflows/release.yml` (binaries + server tarballs on GitHub Releases;
`@anvailabs/agentbrowser-mcp` on npm from 1.7.0 — [ADR-014](docs/adr/014-npm-distribution.md)).

## [Unreleased]

### Added

- **Nine new delivered actions** (spec §5.1 parity): `hover`, `dblclick`,
  `clear`, `check`, `uncheck`, `wait`, `goBack`, `goForward`, `reload` — across
  REST, MCP (`browser_act`), CLI, and SDK; `hover`/`wait` are non-mutating
  (refs survive them). `upload` (needs file transport + size policy) and
  `download`-as-action (already first-class policy-gated endpoints) are
  deliberately excluded.
- **Working per-session policy from every client**: the nested `policy` object
  on session create is validated and mapped onto the session (previously
  silently ignored outside REST flat fields); the SDK type surface now mirrors
  the protocol's.
- `browser_extract` gains the `schema` argument (format `schema` was
  REST-only); the MCP tool's format list had omitted it.

### Fixed

- **Every HTTP `select` was rejected** — the flat transport's single `value`
  was never coerced into the protocol action's `values` array (latent since
  select shipped; regression-tested end-to-end).
- **maxBytes hardened**: measured in real UTF-8 bytes (was UTF-16 units —
  multibyte pages could exceed the budget ~3x), the text field and diff
  `changes` are now budgeted (previously only the element list), the
  sinceRevision diff path and post-action observations no longer bypass the
  budget, and non-integer/zero values are rejected.

### Changed

- **ADR-015 implemented** (Proposed → Accepted): contract primitives live once
  in `@agentbrowser/protocol` — the `e<rev>_<ord>` grammar (`REF_PATTERN`/
  `parseRef`, replacing four divergent copies), the extract-format list
  (seven copies had drifted on whether `schema` exists), `UsageError` + one
  user-facing error formatter (the copies had diverged on the STALE_TARGET
  hint), `ActionEffectType`/`EngineTarget` aliases (a latent same-name type
  collision between protocol and engine), and compiled TypeBox request/action
  validation replacing per-surface `typeof` checks — with type-level contract
  tests so schema/type drift fails `type-check`.
- `SessionRequest.engine` accepts registered engine names (the registry
  routes arbitrary names and fails loudly on unknown ones; the old
  two-literal enum couldn't express the shipped semantics).

## [1.7.1] — 2026-09-04

### Added

- Bounded-collection eviction discipline (TD-BROWSER-9, née TD-BROWSER-8): `BoundedCache`/
  `RingBuffer` primitives in `@agentbrowser/core`, applied to the redaction cache, span buffer, and
  network-policy request log (previously **fully unbounded**, not just large); indexed lookups for
  approval-token-by-session and element-by-ref replace per-call linear scans; the plan executor's
  churn map is cleaned up on session/page teardown instead of leaking one entry per session:page
  pair for the life of the process.
- **Summary quantiles over a bounded window** (TD-BROWSER-9, A2): metrics summaries keep
  incremental all-time-exact `_count`/`_sum` and compute quantiles over the most recent
  `maxSamplesPerSummary` samples (default 1,000) — quantiles are now recent-window signals, not
  all-time promises; identical to prior behavior below the window size.
- **Operations guide** (`docs/operations.md`): configuration, auth, health/metrics, session
  lifecycle, engine selection, deployment notes, and a troubleshooting table.
- **`docs/README.md` re-indexed by audience** with a task-based routing table; stale
  "planned documentation" entries resolved (the threat model has existed for a while; the
  operations guide now does too).
- engine-obscura's scope relative to ADR-013's no-evasion rule is now stated explicitly in
  `docs/engines.md` — outside the rule (unregistered, unreachable by `createSession`,
  benchmark-only), and barred from the engine registry until a follow-up ADR closes its tested
  egress-enforcement gap.
- **A `check-doc-links.mjs` CI check** (`scripts/`) validates every relative markdown link and
  heading anchor across the repo; wired into the lint job.
- **Documentation audit and reconciliation**: `CLAUDE.md` no longer claims the project is in
  "Phase 0" (the MVP and five post-MVP TDs have shipped since); the MVP planning docs
  (`technical-design.md`, `implementation-roadmap.md`, the phase progress summaries) carry
  historical-record banners instead of presenting a completed plan as still-open work; 11 of 15
  ADRs are reconciled against current code (isolation-tier honesty in ADR-008, the real 11-tool
  MCP surface in ADR-009, the real approval-token flow in ADR-007, real egress defaults in
  ADR-006, and more).

### Fixed

- **The two decision-record numbering collisions introduced while "resolving" the prior pair are
  now actually resolved.** 1.7.0's changelog entry below claimed the ADR/TD-BROWSER-8 collisions
  were closed; the renumbering picked 012 and TD-BROWSER-8, which — unnoticed at the time — were
  *already* taken by the Accepted, shipped snapshot/plan-batching work (ADR-012, TD-BROWSER-8).
  The Proposed, not-yet-implemented docs move again: the cross-package-contract ADR is now
  **ADR-015**, and the bounded-in-memory-collections TD is now **TD-BROWSER-9**. `docs/README.md`'s
  index is corrected to list all four documents (the two Accepted/shipped ones were previously
  missing from it entirely).
- **`browser_plan`'s MCP schema didn't declare `sessionId`/`pageId`**, so a caller that omitted
  them got the literal string `"undefined"` sent to the service instead of a validation error.
  Fixed alongside a new `browser_snapshot` MCP tool (TD-BROWSER-8's snapshot half had a server
  route and service method but no SDK or MCP path — unreachable from any real client until now).
  The same `"undefined"` coercion on `browser_close`, `browser_cookies`, and `browser_create`'s
  `tenantId` is fixed too, and `browser_plan` no longer reports `ok` for a missing/non-array
  `actions` argument (it was an empty plan with zero steps).
- **Verified mode has teeth** — and its remap works past the first stale step. `verified` mode
  (raised after repeated ref churn) now requires a role+label match before accepting a remapped
  ref (previously it changed nothing behaviorally and could silently rebind an action to the wrong
  element on a reordering page), matching on the redacted form so labels embedding secrets still
  match their own element, reading the pre-failure baseline from the mint-time revision history
  (the self-heal's own re-observe used to invalidate it, killing remap for every stale step after
  the first), reporting a gone element as the honest `PLAN_STEP_FAILED` instead of a misleading
  `AMBIGUOUS_REMAP`, and surfacing a remap-retry failure as the plan envelope instead of a thrown
  error. A leftover debug `console.log` in the same path is removed.
- **Memory/reclamation fixes**: `RingBuffer.clear()` (used by `clearLogs`) now releases item
  references instead of only resetting cursors; per-session teardown is deduplicated into one
  helper, fixing shipped drift where a crashed session's event listeners survived
  `recoverFromCrash` while the sibling paths dropped them.
- The snapshot payload type is declared once (`PageSnapshot` in the SDK) instead of hand-copied
  across three packages, and the release smoke test reports the real tool count instead of a
  hardcoded `9`.

## [1.7.0] — 2026-09-03

### Added

- **npm distribution** (ADR-014): the MCP server ships to npm as `@anvailabs/agentbrowser-mcp`
  via OIDC Trusted Publishing — no publish token exists anywhere. The bun-compiled GitHub-Release
  binaries remain for standalone/no-Node users; the server stays tarballs + Docker.
- **Headed de-fingerprinting + ADR-013**: headed sessions launch with automation fingerprints
  stripped (`--disable-blink-features=AutomationControlled`, no `--enable-automation`,
  `navigator.webdriver` scrubbed) and prefer real Google Chrome (`channel: 'chrome'`) when
  installed (`AGENTBROWSER_CHROME_PATH`). Doctrine: no arms race with CDP-fingerprinting walls —
  the cookie-seeding handoff is the prescribed route. The headless pool keeps stock defaults.
- **`--no-headless` on the CLI**: headed sessions were unreachable from the CLI (the `--headless`
  flag could only ever send `true`). The OpenAPI create-session schema now documents `headless`
  semantics and the `cookies` seeding field the runtime has accepted all along.

### Fixed

- **Both decision-record numbering collisions resolved** (ADR-011 ×2 → the contract ADR became
  ADR-012; TD-BROWSER-6 ×2 → the bounded-collections TD became TD-BROWSER-8), and the branch-flow
  rule that caused them (main merges must be followed by a main→develop back-sync) is now in
  CLAUDE.md. Stale "6-tool catalog" counts corrected to the enforced 9.
  ⚠️ **Corrected in [1.7.1](#171-2026-09-04) above**: this renumbering collided a second time.

## [1.6.1] — 2026-09-02

TD-BROWSER-7 Phase 1: per-session engine registry. See the `v1.6.1` GitHub Release.

## [1.6.0] — 2026-09-01

TD-BROWSER-6 (headed sessions + credential handoff). See the `v1.6.0` GitHub Release.

## [1.1.0] — earlier

MCP MVP through TD-BROWSER-5 (single-binary distribution). See the GitHub Releases for
`v1.1.0`–`v1.5.0`.
