# Release 1.17.1 delivery record

Status: **released 2026-10-13.** Tag `v1.17.1` on main `cf7c03b` (promotion PR #438); release
run 38337894100 green; 16 assets on the GitHub Release (5 MCP binaries, 5 CLI binaries, 4 server tarballs, the Windows zip, `sha256sums.txt`); `@anvailabs/agentbrowser-mcp@1.17.1` on npm
(`sha512-aydb0NjQJy4dXTURwl9FlrEzbYIpV0yBg001yfjufmsYag0L0WZP3MELJj90Ts5HnR3UEeVfyKsvoMuMqZ2qkA==`). Homebrew: **none dispatched** (the tap formula still pins 1.17.0; see Residual). Main back-synced into develop by #439 (`369a6ff`, 2026-10-13).

Recorded retroactively on 2026-10-15 from the tag, the release run, the GitHub Release, npm and
the CHANGELOG; the per-PR review and CI evidence lives on the PRs themselves.

## What shipped

- **Windows service ships as the bundled-Node zip** (ADR-023): Windows server tree, launcher,
  bundle assembly and clean-room smoke, owner-only credential files on Windows; the v1.17.0
  single-file server exe (Bun froze Playwright's `__dirname` to the CI checkout) does not come back.
- Fixes: server artifacts ship only built output; the server command line; the winget package.
- Extracted-package acceptance runs on Windows; dependency updates (#426); environment-variable
  reference and Windows install docs.

Full notes: the `[1.17.1]` section of the CHANGELOG.

## Residual

- The Homebrew tap was not updated for 1.17.1: `update-agentbrowser.yml` in anvai-labs/homebrew-tap
  (a manual `workflow_dispatch`) was never run for `v1.17.1`. Recorded 2026-10-15; the owner
  decides whether to dispatch it for 1.18.0 (superseding 1.17.1).
