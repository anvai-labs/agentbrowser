# AgentBrowser: Agent-First Browser Automation

[![CI](https://github.com/anvai-labs/agentbrowser/actions/workflows/ci.yml/badge.svg)](https://github.com/anvai-labs/agentbrowser/actions/workflows/ci.yml)
![Release](https://img.shields.io/github/v/release/anvai-labs/agentbrowser)

AgentBrowser lets AI agents safely and reliably operate **authorized** websites through a compact, deterministic interface: semantic observations instead of screenshots, stable element references with staleness detection, egress policy enforcement, and approval gates for side effects.

The opt-in [delegated-session workflow](docs/delegated-sessions.md) adds a human control panel, revocable session tokens, and operation reconciliation for cooperating agent harnesses. Use a build containing this feature; the existing release installation below remains the legacy entry point.

## Install (Homebrew)

```bash
brew install anvai-labs/tap/agentbrowser
brew services start anvai-labs/tap/agentbrowser   # the service, on 127.0.0.1:5709
```

One install ships all three surfaces: the **browser service**, the standalone
**CLI** (`agentbrowser`) and the optional **MCP adapter** (`agentbrowser-mcp`).
The first service start bootstraps Chromium into
`$(brew --prefix)/var/agentbrowser/browsers`. The compiled CLI and MCP binaries
need no Node runtime. Without Homebrew, use the
`agentbrowser-cli-<target>` and `agentbrowser-mcp-<target>` client assets for
macOS, Linux or Windows. Service archives are published for macOS and Linux as
`agentbrowser-server-<target>.tar.gz`; they require Node 22 and separately
provisioned Chromium (plus its platform libraries on Linux). See the
[operations guide](docs/operations.md#release-assets) for deployment details.

### Consuming directly from a shell

The CLI is the smallest universal agent interface. It connects directly to the
HTTP service, emits structured JSON matching the service contracts and can
describe one command at a time without contacting the service:

```bash
agentbrowser describe
agentbrowser describe autofill --schema
agentbrowser describe outcome --schema
agentbrowser --base-url http://localhost:5709 --json health
```

For a local deployment, install the service and CLI; for a remote deployment,
only the CLI is required on the agent host. MCP is optional in both cases. See
[the shell-agent CLI guide](docs/cli-agent-usage.md) for bounded JSON input,
operation reconciliation and bulk plan/autofill/outcome examples.

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

Tool calls drive the **AgentBrowser service** (default `http://localhost:5709`;
override with `AGENTBROWSER_BASE_URL`, authenticate with `AGENTBROWSER_API_KEY`).

## Engines

Engine-neutral by contract ([ADR-002](docs/adr/002-engine-neutral-protocol.md)); every engine passes the same [contract suite](packages/testkit). See the [engine matrix](docs/engines.md).

| Engine | Status | Notes |
| --- | --- | --- |
| Chromium (Playwright) | Production default | Partial routing enforcement; redirect/DNS limitations in the [engine matrix](docs/engines.md) |
| Chromium (remote CDP) | Supported | `cdpEndpoint` engine option |
| Firefox / WebKit (Playwright) | Supported | Same contract suite |
| **Real Safari (safaridriver)** | **Direct-engine local use only** ([TD-BROWSER-7](docs/td/TD-BROWSER-7-safari-webdriver-engine.md), [ADR-011](docs/adr/011-safari-via-safaridriver-webdriver.md)) | macOS only, always headed; guarded REST creation unsupported because egress is not enforceable |
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
├── mcp-server/         # MCP stdio adapter to the shared service
├── api/                # REST + WebSocket service
├── cli/                # Human and shell-agent CLI; offline command discovery
└── benchmarks/         # Performance benchmarks
```

The unbound MCP catalog exposes thirteen tools: `browser_create`, `browser_navigate`,
`browser_observe`, `browser_act`, `browser_extract`, `browser_html`,
`browser_screenshot`, `browser_pdf`, `browser_cookies`, `browser_close`, and the
batched tools `browser_snapshot`, `browser_plan`, and `browser_autofill`.
Delegated mode exposes twelve: it replaces create/close/cookies with
`browser_session` and `browser_operation`. No raw selectors, no evaluate - element
refs come from observations and die with their revision (ADR-009).

### The fast path for forms: snapshot then plan

For supported native forms, prefer [scoped bulk autofill](docs/bulk-autofill.md):
send structured fields once through CLI `autofill`, REST/SDK or `browser_autofill`; the server
resolves and verifies them with per-field receipts. Custom widgets remain qualified
separately.

For explicit heterogeneous steps, the snapshot/plan pair remains available:

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

### Shell and CLI agents

Use `agentbrowser describe` to discover immediate commands as JSON without a running
service, then `agentbrowser describe act press` to load only one command's details.
Execution uses the existing SDK/service: pass `--json`, quote shell arguments and
inspect outcomes rather than relying on exit code alone. See the
[CLI agent guide](docs/cli-agent-usage.md) for Bash/jq examples and reconciliation.

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

- [CLI and shell agents](docs/cli-agent-usage.md) - offline command discovery, JSON output and safe reconciliation
- [Consuming as an MCP server](#consuming-as-an-mcp-server) - Claude Code, Claude Desktop, Codex, Victor wiring
- [Snapshot then plan](#the-fast-path-for-forms-snapshot-then-plan) - the two-call form-filling flow
- [Interactive forms recipe](docs/recipes/interactive-forms.md) - custom comboboxes, async menus, sectioned plans, verifying what got selected
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
- [Human handoff](docs/human-handoff.md) - working a session with a person in the loop: approval gates, headed credential entry, re-observe discipline
- [Delegated sessions](docs/delegated-sessions.md) - human takeover, revocable agent credentials, and regression checks
- [Synthetic input limitations](docs/synthetic-input-limitations.md) - browser input trust, application acceptance, and independent outcome checks

## License

Apache-2.0

## Inspired By

- [Cloudflare Kitesurf](https://blog.cloudflare.com/kitesurf/) - stateless browser architecture
- [Playwright](https://playwright.dev/) - browser automation foundation
- [Obscura](https://github.com/h4ckf0r0day/obscura) - Rust headless engine reference
