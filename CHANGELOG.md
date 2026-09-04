# Changelog

All notable changes to **AgentBrowser** are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); releases are tagged `vX.Y.Z` and
built by `.github/workflows/release.yml` (binaries + server tarballs on GitHub Releases;
`@anvailabs/agentbrowser-mcp` on npm from 1.7.0 — [ADR-014](docs/adr/014-npm-distribution.md)).

## [Unreleased]

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
- A leftover debug `console.log` in the plan executor's stale-ref remap path is removed, the
  `churn` tracking map (introduced with TD-BROWSER-8) is now cleaned up on session/page teardown
  instead of leaking one entry per session:page pair for the life of the process, and `verified`
  mode (raised after repeated ref churn) now requires a role+label match before accepting a
  remapped ref — previously it changed nothing behaviorally and could silently rebind an action to
  the wrong element on a reordering page.

### Added

- Bounded-collection eviction discipline (TD-BROWSER-9, née TD-BROWSER-8): `BoundedCache`/
  `RingBuffer` primitives in `@agentbrowser/core`, applied to the redaction cache, span buffer, and
  network-policy request log (previously **fully unbounded**, not just large); indexed lookups for
  approval-token-by-session and element-by-ref replace per-call linear scans.

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
  ⚠️ **Corrected in 1.7.1** — see Unreleased above: this renumbering collided a second time.

## [1.6.1] — 2026-09-02

TD-BROWSER-7 Phase 1: per-session engine registry. See the `v1.6.1` GitHub Release.

## [1.6.0] — 2026-09-01

TD-BROWSER-6 (headed sessions + credential handoff). See the `v1.6.0` GitHub Release.

## [1.1.0] — earlier

MCP MVP through TD-BROWSER-5 (single-binary distribution). See the GitHub Releases for
`v1.1.0`–`v1.5.0`.
