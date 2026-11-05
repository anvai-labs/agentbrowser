# Contributing to agentbrowser

Issues and pull requests are welcome.

## CLA (one-time, lightweight)

First-time contributors sign the [CLA](.github/CLA.md) by checking the **CLA** box in
the pull request template. The checked box plus the PR's edit history is the signature
record; a maintainer then adds you to `.github/cla-signatories.json` so future PRs pass
automatically. The `cla-check` workflow enforces all of this.

Why a CLA: it keeps every contribution public under the project's current license
(Apache-2.0) while preserving the project owner's right to relicense future versions.
Your contribution stays yours.

## Development

- Node 22.12+ (24.x pinned via `.tool-versions`), pnpm 9.15+
- `pnpm install`, then `pnpm test` (Vitest) and `pnpm biome check` for lint/format
- Protocol first: public API changes start as versioned schemas in `packages/protocol/`
- Behavior changes update the relevant docs (`docs/operations.md`, TD/T10 notes)

See [CLAUDE.md](CLAUDE.md) for the full architecture map.
