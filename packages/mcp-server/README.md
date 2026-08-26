# @agentbrowser/mcp-server

Exposes AgentBrowser as a small set of high-level, safe, composable MCP tools
(ADR-009). Raw engine operations — evaluate, routing, selectors, low-level
input — are deliberately not exposed.

## Tool surface

| Tool | Purpose |
|---|---|
| `browser_create` | Create an isolated session (also creates the first page) |
| `browser_close` | Close a session, invalidating its refs |
| `browser_navigate` | Navigate a page to an http(s) URL |
| `browser_observe` | Semantic snapshot with stable element refs (`e<revision>_<ordinal>`) |
| `browser_act` | click / fill / select / scroll / press — by ref, never by selector |
| `browser_screenshot` | Capture optional visual evidence |

## Running it

### Release consumers: the single binary (recommended)

Download `agentbrowser-mcp-<target>` from the [GitHub releases](../../releases)
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
beyond the protocol handshake. Deploy the server once (Docker image or
`node packages/api/dist/bin.js`); every consumer process spawns the binary.

### Development: from the workspace

```sh
pnpm --filter @agentbrowser/mcp-server build
node packages/mcp-server/dist/bin.js
```

### Environment

| Variable | Meaning |
|---|---|
| `AGENTBROWSER_BASE_URL` | AgentBrowser server to proxy to (default `http://localhost:3000`) |
| `AGENTBROWSER_MCP_VERSION` | Override the reported `serverInfo.version` (debugging; the binary is otherwise stamped at build time from `package.json`) |

## Building and gating the binary

```sh
pnpm --filter @agentbrowser/mcp-server compile   # -> dist-bin/agentbrowser-mcp (needs bun)
pnpm --filter @agentbrowser/mcp-server smoke     # stdio handshake + 6-tool catalog gate
```

Cross-compile with `node scripts/compile.mjs --target=bun-linux-arm64 --outfile=...`.
CI runs both on every PR (`Bun compile + smoke` job), and every `v*` tag
publishes the five-target release matrix — see `docs/td/TD-BROWSER-5-single-binary-mcp-distribution.md`.
