# @anvailabs/agentbrowser-mcp

The MCP server for [AgentBrowser](https://github.com/anvai-labs/agentbrowser). Two install paths, one source:

```sh
npm i -g @anvailabs/agentbrowser-mcp   # Node >= 18
# or: download the bun-compiled standalone binary from the GitHub Releases
```

The package is **only the MCP stdio adapter** — it proxies to an AgentBrowser service. Point it at one with `AGENTBROWSER_BASE_URL` (default `http://localhost:3000`).

Exposes AgentBrowser as a small set of high-level, safe, composable MCP tools
(ADR-009). Raw engine operations — evaluate, routing, selectors, low-level
input — are deliberately not exposed.

## Tool surface

| Tool | Purpose |
|---|---|
| `browser_create` | Create an isolated session (also creates the first page; accepts seed cookies for authenticated re-entry) |
| `browser_close` | Close a session, invalidating its refs |
| `browser_navigate` | Navigate a page to an http(s) URL |
| `browser_observe` | Semantic observation with stable element refs (`e<revision>_<ordinal>`) |
| `browser_snapshot` | Self-contained page payload (url, title, revision, mode, `fields`) — one call to plan a whole form |
| `browser_plan` | Execute an ordered batch of fill/click/press/scroll steps in one call; stale refs self-heal, with a role+label guard under churn |
| `browser_act` | click / fill / select / scroll / press / dialogs — by ref, never by selector |
| `browser_extract` | Structured page extraction |
| `browser_screenshot` | Capture optional visual evidence |
| `browser_pdf` | Page-to-PDF capture |
| `browser_cookies` | Export session cookies — persist and seed `browser_create` to re-enter an authenticated session |

The fast path for multi-field forms is `browser_snapshot` → `browser_plan`:
one call to read the page, one call to act on it — see the
[main README](../../README.md#the-fast-path-for-forms-snapshot-then-plan).

## Running it

### Release consumers: the single binary (recommended)

Download `agentbrowser-mcp-<target>` from the
[GitHub releases](https://github.com/anvai-labs/agentbrowser/releases)
(verify against `sha256sums.txt`), then point any MCP client at it — no Node,
no pnpm, no repo checkout:

```yaml
# ~/.victor/mcp.yaml
mcpServers:
  agentbrowser:
    command: /usr/local/bin/agentbrowser-mcp
    env:
      AGENTBROWSER_BASE_URL: http://localhost:3000
```

The binary is **only the MCP adapter** (TD-BROWSER-5 scope boundary): it needs
a reachable AgentBrowser server over `AGENTBROWSER_BASE_URL` for anything
beyond the protocol handshake. Deploy the server once (release tarball, or
`node packages/api/dist/bin.js`); every consumer process spawns the binary.

### Development: from the workspace

```sh
pnpm --filter @anvailabs/agentbrowser-mcp build
node packages/mcp-server/dist/bin.js
```

### Environment

| Variable | Meaning |
|---|---|
| `AGENTBROWSER_BASE_URL` | AgentBrowser server to proxy to (default `http://localhost:3000`) |
| `AGENTBROWSER_API_KEY` | Bearer key for the service, when it has `AGENTBROWSER_API_KEYS` configured |
| `AGENTBROWSER_MCP_VERSION` | Override the reported `serverInfo.version` (debugging; the binary is otherwise stamped at build time from `package.json`) |

## Building and gating the binary

```sh
pnpm --filter @anvailabs/agentbrowser-mcp compile   # -> dist-bin/agentbrowser-mcp (needs bun)
pnpm --filter @anvailabs/agentbrowser-mcp smoke     # stdio handshake + full tool-catalog gate
```

Cross-compile with `node scripts/compile.mjs --target=bun-linux-arm64 --outfile=...`.
CI runs both on every PR (`Bun compile + smoke` job), and every `v*` tag
publishes the five-target release matrix — see `docs/td/TD-BROWSER-5-single-binary-mcp-distribution.md`.
