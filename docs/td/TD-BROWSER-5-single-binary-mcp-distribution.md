# TD-BROWSER-5: Single-Binary MCP Server Distribution (Bun `--compile`) + Release CI

**Status:** Accepted (implementation pending)
**Context:** 2026-08-25
**Related:** [ADR-009](../adr/009-mcp-high-level-tools.md) (MCP exposes high-level safe tools)

## Context

MCP consumers spawn the AgentBrowser MCP server as a child process over stdio.
Today the only way to do that is `node <repo>/packages/mcp-server/dist/bin.js` —
which requires a Node.js runtime, a pnpm workspace install, and a built
`dist/` tree. That is fine for this monorepo's own CI, but hostile to polyglot
consumers:

- **Victor** (Python) hardcodes `["node", ".../mcp-server/dist/bin.js"]` in
  `~/.victor/mcp.yaml` — a checkout-specific path that breaks the moment the
  repo moves.
- Any non-Node consumer (Go, Rust, a plain Claude/agent sandbox) must install
  Node solely to spawn a ~200-line stdio JSON-RPC loop.
- There is no versioned distribution at all: consumers track `develop` tip.

The MCP server is the ideal single-binary candidate: it is a thin, pure-TypeScript
adapter (newline-delimited JSON-RPC over stdio, one HTTP client dependency) with
no dynamic `require`, no native addons, and no browser binaries of its own.

## Verified feasibility (2026-08-25, bun 1.4.0, macOS arm64)

Not asserted — measured:

```
$ bun build --compile packages/mcp-server/src/bin.ts --outfile agentbrowser-mcp
  [11ms]  bundle  5 modules
  [81ms]  compile  agentbrowser-mcp          # 57 MB
```

The compiled binary was driven end-to-end through Victor's `MCPClient`
(spawned as `/tmp/agentbrowser-mcp`, no Node in the process tree):

| Step | Result |
|---|---|
| MCP `initialize` handshake | ✓ |
| `tools/list` | ✓ 6 tools, full parameter schemas (inputSchema survives the bundle) |
| `browser_create` → `browser_navigate` (example.com) → `browser_observe` (3 elements) → `browser_close` | ✓ against a live AgentBrowser server on `:3000` |
| Process exit | ✓ clean, no leaked Chromium |

## Decision

1. **Distribute `agentbrowser-mcp` as a self-contained executable** compiled
   with `bun build --compile`, attached to GitHub Releases per version tag.
2. **Add a `compile` script** to `packages/mcp-server` so the same command CI
   uses is reproducible locally:
   `"compile": "bun build --compile src/bin.ts --outfile dist-bin/agentbrowser-mcp"`
3. **Release workflow** (`.github/workflows/release.yml`, triggered on `v*`
   tags) building a target matrix:

   | Target | Runner | Blocking |
   |---|---|---|
   | `darwin-arm64` | `macos-latest` | yes |
   | `darwin-x64` | `macos-13` | yes |
   | `linux-x64` | `ubuntu-latest` | yes |
   | `linux-arm64` | `ubuntu-latest` (+ arm cross-compile) | yes |
   | `windows-x64` | `windows-latest` | yes |

   Each artifact: `agentbrowser-mcp-<target>[.exe]` + a `sha256sums.txt`
   covering all artifacts. Bun cross-compiles from any host for these
   targets; where a native runner exists, prefer building on it.

4. **Smoke gate on the binary itself, not just the bundle:** every release
   build pipes `initialize` and `tools/list` into the compiled artifact over
   stdio and requires the 6-tool catalog back. A binary that compiles but
   cannot answer the protocol must not ship.
5. **Per-PR compile guard:** a `bun-compile` job in `ci.yml` (ubuntu,
   compile + the same stdio smoke) so a change that breaks bundling fails
   the introducing PR instead of the release tag.
6. **Version stamping:** the binary's `serverInfo.version` comes from the
   package version at build time (build-time inject or
   `process.env.AGENTBROWSER_MCP_VERSION` override), never a hardcoded
   `1.0.0` — consumers diagnosing protocol drift need the real version.

## Scope boundary (explicit non-goal)

The binary packages **only the MCP stdio adapter**. It still requires a
reachable AgentBrowser server (`AGENTBROWSER_BASE_URL`, default
`http://localhost:3000`) for anything beyond the handshake — the server owns
sessions, the engine, Playwright/Chromium, egress policy, and approval gates
(ADR-006, ADR-007, ADR-008). Compiling the REST server + Playwright into the
binary is explicitly rejected: Playwright needs per-platform browser downloads
and a driver process, which `--compile` cannot embed, and it would blur the
ADR-008 isolation boundary. Consumers deploy the server once (Docker image or
`node packages/api/dist/bin.js`); every consumer process then spawns the
lightweight binary.

## Consumer wiring (after this lands)

```yaml
# ~/.victor/mcp.yaml — no Node, no checkout path
mcpServers:
  agentbrowser:
    command: /usr/local/bin/agentbrowser-mcp   # from the GitHub Release
    env:
      AGENTBROWSER_BASE_URL: http://localhost:3000
```

## Acceptance criteria

- [ ] `pnpm --filter @agentbrowser/mcp-server compile` produces a working binary (requires local bun).
- [ ] Tagging `v*` produces 5 release artifacts + `sha256sums.txt`.
- [ ] Each artifact passes the stdio smoke (`initialize` + `tools/list` = 6 tools) on its build runner.
- [ ] The per-PR `bun-compile` job runs on every PR to `develop`/`main`.
- [ ] Binary reports the release version in `initialize` `serverInfo.version`.
- [ ] Victor's `mcp.yaml` example in this repo's docs points at the binary, not a `dist/` path.
- [ ] Release notes state the scope boundary (server still required).

## Consequences

- Polyglot consumers depend on one static file; Node and a workspace checkout
  are no longer prerequisites for the MCP surface.
- A 57 MB artifact per target (~285 MB per release) — acceptable for GitHub
  Releases; not containerized into the Docker image.
- Bun becomes a build dependency for releases and one CI job (not for local
  dev or the server runtime, which stay pnpm/Node).
- Bun version becomes part of the build environment; pin it in the workflow
  (`oven-sh/setup-bun`) and record it in release notes.

## Name reservations

`TD-BROWSER-1..4` were handles reserved during the 2026-08 integration review;
none were filed as documents. For the record: 1 = approval-token REST
endpoints, 2 = expose `browser_extract` over MCP, 3 = approval persistence,
4 = tenant-ID validation (**landed** in commit `b16363b`, no doc needed).
The names stay reserved to keep this numbering stable.
