# Changelog

All notable changes to **AgentBrowser** are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); releases are tagged `vX.Y.Z` and
built by `.github/workflows/release.yml` (binaries + server tarballs on GitHub Releases;
`@anvailabs/agentbrowser-mcp` on npm from 1.7.0 — [ADR-014](docs/adr/014-npm-distribution.md)).

## [Unreleased]

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

## [1.6.1] — 2026-09-02

TD-BROWSER-7 Phase 1: per-session engine registry. See the `v1.6.1` GitHub Release.

## [1.6.0] — 2026-09-01

TD-BROWSER-6 (headed sessions + credential handoff). See the `v1.6.0` GitHub Release.

## [1.1.0] — earlier

MCP MVP through TD-BROWSER-5 (single-binary distribution). See the GitHub Releases for
`v1.1.0`–`v1.5.0`.
