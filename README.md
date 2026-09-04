# AgentBrowser: Agent-First Browser Automation

[![CI](https://github.com/anvai-labs/agentbrowser/actions/workflows/ci.yml/badge.svg)](https://github.com/anvai-labs/agentbrowser/actions/workflows/ci.yml)
![Release](https://img.shields.io/github/v/release/anvai-labs/agentbrowser)

AgentBrowser lets AI agents safely and reliably operate **authorized** websites through a compact, deterministic interface: semantic observations instead of screenshots, stable element references with staleness detection, egress policy enforcement, and approval gates for side effects.

## Install (Homebrew)

```bash
brew install anvai-labs/tap/agentbrowser
brew services start anvai-labs/tap/agentbrowser   # the service, on 127.0.0.1:3000
```

One install ships both halves: the **MCP server binary** (`agentbrowser-mcp`, no Node runtime needed) and the **browser service** (first start bootstraps Chromium into `$(brew --prefix)/var/agentbrowser/browsers`). Without Homebrew, grab the release assets: the `agentbrowser-mcp-<target>` binary needs no Node at all, and the `agentbrowser-server-<target>.tar.gz` needs only `node` on PATH.

### Consuming as an MCP server

`agentbrowser-mcp` speaks newline-delimited JSON-RPC over stdio (MCP 2024-11-05):

- **Claude Code**: `claude mcp add agentbrowser -- $(brew --prefix)/opt/agentbrowser/bin/agentbrowser-mcp`
- **Claude Desktop** (`claude_desktop_config.json`):
  ```json
  {"mcpServers": {"agentbrowser": {"command": "/opt/homebrew/opt/agentbrowser/bin/agentbrowser-mcp"}}}
  ```
- **Codex** (`~/.codex/config.toml`):
  ```toml
  [mcp_servers.agentbrowser]
  command = "/opt/homebrew/opt/agentbrowser/bin/agentbrowser-mcp"
  ```
- **Victor** (`~/.victor/mcp.yaml`): `command: /opt/homebrew/opt/agentbrowser/bin/agentbrowser-mcp`

Tool calls drive the **AgentBrowser service** (default `http://localhost:3000`;
override with `AGENTBROWSER_BASE_URL`, authenticate with `AGENTBROWSER_API_KEY`).

## Engines

Engine-neutral by contract ([ADR-002](docs/adr/002-engine-neutral-protocol.md)); every engine passes the same [contract suite](packages/testkit). See the [engine matrix](docs/engines.md).

| Engine | Status | Notes |
| --- | --- | --- |
| Chromium (Playwright) | Production default | Egress choke point enforced per request |
| Chromium (remote CDP) | Supported | `cdpEndpoint` engine option |
| Firefox / WebKit (Playwright) | Supported | Same contract suite |
| **Real Safari (safaridriver)** | **Phase 2 shipped** ([TD-BROWSER-7](docs/td/TD-BROWSER-7-safari-webdriver-engine.md), [ADR-011](docs/adr/011-safari-via-safaridriver-webdriver.md)) | macOS only, always headed; `safaridriver --enable` required; egress unsupported (loud refusal) |
| Obscura (Rust) | Experimental, benchmark-only | |

### Headed sessions and credential handoff

Real-login flows (Keychain, device-trust SSO) are first-class
([TD-BROWSER-6](docs/td/TD-BROWSER-6-headed-sessions-and-credential-handoff.md)):
create a session with `headless: false` — the engine launches a dedicated
headed browser owned by that session, so interactive crashes never touch the
headless pool. Cookies export/import (httpOnly included) closes the loop: log
in once by hand, export, seed future headless sessions via the create
request's `cookies` option.

Engines that cannot run headless (Safari) declare `alwaysHeaded`; the service
rejects explicit `headless: true` for them loudly
(`SAFARI_HEADLESS_UNSUPPORTED`) instead of silently running headed.

## Branching & releases

**`develop` is the integration branch** — feature PRs target `develop`
(CI-gated). Promotion is explicit: `develop` → `main` via a release PR
(CI-gated), releases are tagged on `main`. Docs-only changes skip CI
(`paths-ignore`) — prose cannot burn compute.

## Architecture

TypeScript control plane (Node 22, pnpm workspace) over an engine-neutral
protocol:

```
packages/
├── protocol/           # Versioned schemas - the public contract
├── engine/             # BrowserEngine interface + core types
├── engine-playwright/  # Chromium / Firefox / WebKit (Playwright)
├── engine-obscura/     # Experimental Rust engine adapter
├── engine-safari/      # Real Safari via safaridriver (WebDriver)
├── core/               # Session coordination, normalization, actions
├── policy/             # Egress / network policy
├── extraction/         # Page extraction
├── testkit/            # FakeEngine + the reusable contract suite
├── sdk-typescript/     # TypeScript client SDK
├── mcp-server/         # The MCP stdio server (11 high-level tools)
├── api/                # REST + WebSocket service
├── cli/                # Operator CLI
└── benchmarks/         # Performance benchmarks
```

Eleven MCP tools today: `browser_create`, `browser_navigate`,
`browser_observe`, `browser_act`, `browser_extract`, `browser_screenshot`,
`browser_pdf`, `browser_cookies`, `browser_close`, and the batched pair
`browser_snapshot` + `browser_plan`. No raw selectors, no evaluate - element
refs come from observations and die with their revision (ADR-009).

### The fast path for forms: snapshot then plan

Filling a multi-field form one `browser_act` at a time costs a round trip
per field, because every action bumps the page revision. The batched pair
collapses that to two calls ([TD-BROWSER-8](docs/td/TD-BROWSER-8-batched-snapshots-and-action-plans.md)):

1. `browser_snapshot` returns a self-contained page summary - url, title,
   revision, the page's adaptive `mode`, and `fields` (`{ref, role, label}`).
2. `browser_plan` executes the whole ordered sequence (fill/click/press/
   scroll) in one call, reporting per-step results. A stale ref self-heals
   once per step; once a page has churned enough to enter `verified` mode,
   the executor requires a role+label match before remapping and aborts
   loudly (`AMBIGUOUS_REMAP`) rather than risk acting on the wrong element.

## Development

```bash
pnpm install          # Node 22, pnpm 9.15
pnpm -r build && pnpm -r type-check
pnpm -r test          # unit + contract; Safari tests self-gate on macOS
pnpm -r lint          # Biome
```

## Documentation

New here? Read top to bottom: the README above covers install and the MCP
surface; the rest depends on who you are.

**Using AgentBrowser**

- [Consuming as an MCP server](#consuming-as-an-mcp-server) - Claude Code, Claude Desktop, Codex, Victor wiring
- [Snapshot then plan](#the-fast-path-for-forms-snapshot-then-plan) - the two-call form-filling flow
- [TypeScript SDK](packages/sdk-typescript) - programmatic clients (`SessionsClient.plan` / `.snapshot`)
- REST: every route is documented by the service itself at `GET /openapi.json`

**Running AgentBrowser**

- [Operations guide](docs/operations.md) - configuration, auth, health and metrics, session lifecycle, deployment, troubleshooting
- [Engine matrix](docs/engines.md) - engines, their contract-suite status, and egress guarantees
- [Changelog](CHANGELOG.md) - what changed in each release

**Understanding the design**

- [Docs index](docs/README.md) - the full map: ADRs (the "why"), threat model, audits
- [Architecture decisions](docs/README.md#architecture-decision-records-adrs) - ADR-001…015
- [Technical designs](docs/td/) - TD-BROWSER-5…9 feature records
- [Threat model](docs/threat-model.md) - the security posture and its named limits

## License

Apache-2.0

## Inspired By

- [Cloudflare Kitesurf](https://blog.cloudflare.com/kitesurf/) - stateless browser architecture
- [Playwright](https://playwright.dev/) - browser automation foundation
- [Obscura](https://github.com/h4ckf0r0day/obscura) - Rust headless engine reference
