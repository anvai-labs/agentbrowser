# Operating AgentBrowser

A practical guide to running the AgentBrowser service: installation,
configuration, health and metrics, day-to-day operation, and
troubleshooting. For what AgentBrowser is and how to drive it as a
client, start with the [README](../README.md); for the security model,
see the [threat model](threat-model.md) and the
[safety ADRs](README.md#core-architecture-adrs).

## Installation

### Homebrew (macOS / Linux)

```bash
brew install anvai-labs/tap/agentbrowser
brew services start anvai-labs/tap/agentbrowser   # the service, on 127.0.0.1:3000
```

One install ships both halves:

- the **browser service** (`agentbrowser-server`) — REST + WebSocket on
  port 3000; first start bootstraps Chromium into
  `$(brew --prefix)/var/agentbrowser/browsers`;
- the **MCP server binary** (`agentbrowser-mcp`) — a standalone stdio
  binary that proxies to the service; no Node runtime needed.

### Release assets

Without Homebrew, take `agentbrowser-server-<target>.tar.gz` and
`agentbrowser-mcp-<target>` from the [GitHub
Releases](https://github.com/anvai-labs/agentbrowser/releases) (they need
only `node` on PATH). The MCP server is also on npm as
[`@anvailabs/agentbrowser-mcp`](https://www.npmjs.com/package/@anvailabs/agentbrowser-mcp)
([ADR-014](adr/014-npm-distribution.md)). A Docker image builds from the
repo root (CI builds it every push); no registry copy is published.

### From source

```bash
pnpm install            # Node 22, pnpm 9.15
pnpm -r build
node packages/api/dist/bin.js       # the service
node packages/mcp-server/dist/bin.js  # the MCP server (stdio)
```

## Configuration

Everything is configured through environment variables; there is no
config file.

| Variable | Who reads it | Meaning |
| --- | --- | --- |
| `AGENTBROWSER_API_KEYS` | service | Bearer auth for `/v1`, format `key:tenant[,key:tenant...]`. **Without it, `/v1` is unauthenticated** — the service logs a loud warning at startup. Each key maps to one tenant; sessions are isolated per tenant. |
| `AGENTBROWSER_API_KEY` | MCP server, CLI, SDK | The bearer key sent to the service. |
| `AGENTBROWSER_BASE_URL` | MCP server, CLI, SDK | Service location; default `http://localhost:3000`. |
| `AGENTBROWSER_LOG_LEVEL` | service | `debug` or `info` (default). Logs are structured JSON, scrubbed of registered secrets. |
| `AGENTBROWSER_CHROME_PATH` | service (Playwright engine) | Prefer a specific real Chrome for headed sessions ([ADR-013](adr/013-headed-sessions-and-walled-logins.md)). |
| `AGENTBROWSER_ARTIFACT_KEY` | service | Bearer key guarding artifact download URLs, when set. |

Port and bind address default to `3000` on `0.0.0.0`
(`ServerOptions`); when exposing the service beyond localhost, set
`AGENTBROWSER_API_KEYS` first — the egress policy constrains what
*browser sessions* may reach, not who may reach the *service*.

## Health, metrics, and logs

| Endpoint | Purpose |
| --- | --- |
| `GET /health/live` | Liveness: the process is up. |
| `GET /health/ready` | Readiness: the service can accept sessions. |
| `GET /health` | Combined summary. |
| `GET /metrics` | Prometheus text exposition format — scrape directly. |
| `GET /openapi.json` | Machine-readable REST contract. |

The metrics surface is counters (`sessions_created_total`,
`sessions_closed_total`, `sessions_crashed_total`, …), gauges
(`sessions_active`), and per-operation latency summaries. As of 1.7.1,
summary quantiles are computed over a bounded window of the most recent
samples per series (default 1,000, configurable via
`MetricsRegistryOptions.maxSamplesPerSummary`) while `_count` and `_sum`
stay exact over all time — alert on `count`/`sum` rates; treat
quantiles as recent-window signals, not all-time promises.

Logs are JSON lines on stdout (`AGENTBROWSER_LOG_LEVEL=debug` for the
remap/engine-detail level). Under `brew services`, they land in
`$(brew --prefix)/var/log/agentbrowser-server.log` (errors in the
sibling `.err.log`); `brew services list` shows run state.

## Session lifecycle

Sessions are **ephemeral by default** ([ADR-005](adr/005-ephemeral-sessions-explicit-persistence.md)):

- default TTL **15 minutes**, default idle timeout **2 minutes** — both
  overridable per session (`ttlMs`, `idleTimeoutMs` on create);
- a 30-second sweep expires lapsed sessions, drops their pages,
  listeners, and per-session policy state, and emits `page.destroyed`
  (reason `session-expired`) on the session's event stream;
- closing a session (`DELETE /v1/sessions/:id`, CLI `session close`,
  MCP `browser_close`) releases the browser context immediately and
  invalidates all of its element refs.

Engine crashes are not silent: the affected session is terminated,
removed from tracking, counted in `sessions_crashed_total`, logged at
error level, and recorded in the crash audit — callers get a typed
`ENGINE_CRASHED` error, never a hang.

## Choosing an engine

Sessions name their engine (`engine` field on create / MCP
`browser_create`). The registry resolves the primary engine by default
and fails loudly (`ENGINE_NOT_FOUND`) on unknown names — a session never
silently runs on a different engine than requested. The full matrix,
including per-engine egress guarantees, is in the
[engine matrix](engines.md). Notes for operators:

- **Chromium (Playwright)** is the production default; the egress policy
  is enforced per request, per redirect hop, and against DNS-resolved IPs.
- **Safari** (`engine-safari`) is macOS-only and always headed; it
  refuses policy-bearing sessions loudly (`EGRESS_UNSUPPORTED`) rather
  than enforcing nothing quietly.
- **Obscura** (`engine-obscura`) is experimental, unregistered, and
  benchmark-only — it cannot be selected by a session, by design; see the
  Obscura section in [engines.md](engines.md).

## Operating through the CLI

The `agentbrowser` CLI (`packages/cli`) is a thin, scriptable surface over
the SDK — useful for smoke checks and ad-hoc automation. It currently
ships from a source checkout only (`pnpm --filter @agentbrowser/cli build`,
then `node packages/cli/dist/bin.js`); it is not yet in the Homebrew
formula or the release tarballs:

```bash
export AGENTBROWSER_BASE_URL=http://localhost:3000
# The bearer is the KEY segment only - the server parses `key:tenant` pairs
# and matches on the key's hash, so sending `key1:tenant1` as the bearer 401s.
export AGENTBROWSER_API_KEY=key1

agentbrowser session create --tenant tenant1 --json
agentbrowser navigate <sessionId> <pageId> https://example.com
agentbrowser act click <sessionId> <pageId> <ref>
agentbrowser session list
agentbrowser session close <sessionId>
```

`--json` emits raw API payloads for scripting; `--no-headless` opens a
headed session for interactive logins (export the cookies afterward and
seed future headless sessions with them — [TD-BROWSER-6](td/TD-BROWSER-6-headed-sessions-and-credential-handoff.md)).

## Deployment notes

- **Docker**: images build from the repo root; process/container
  isolation is the minimum bar for hostile multi-tenancy
  ([ADR-008](adr/008-process-container-isolation.md)). Run one service
  process per container; the service is single-node by design — scale
  horizontally, not vertically shared.
- **Disk**: Chromium bootstrap (first start) and artifacts are the only
  on-disk state; sessions themselves hold no persistence unless a client
  explicitly exports cookies/artifacts.
- **Upgrades**: the service is stateless between sessions; restarts are
  safe whenever no session is mid-flight. Check the
  [changelog](../CHANGELOG.md) for behavior changes before rolling.

## Troubleshooting

| Symptom | Likely cause / fix |
| --- | --- |
| Startup warns `/v1 is UNAUTHENTICATED` | `AGENTBROWSER_API_KEYS` unset — set `key:tenant` pairs before exposing the service. |
| `404 SESSION_NOT_FOUND` for a session that existed | The session TTL/idle expired (15 min / 2 min defaults). Create a fresh session; seed cookies if continuity matters. |
| `STALE_TARGET` on every action on a dynamic page | Refs die with their revision — re-observe, or prefer `browser_snapshot` + `browser_plan`, which self-heals stale refs once per step. |
| Plan aborts with `AMBIGUOUS_REMAP` | The page churned enough to enter `verified` mode and no remap candidate matched the original element's role+label. Re-observe and rebuild the plan — the executor refused to guess rather than act on the wrong element. |
| Browser download slow/failing | First service start bootstraps Chromium; on Homebrew installs it lands in `$(brew --prefix)/var/agentbrowser/browsers`. |
| Engine crash loops | Check `sessions_crashed_total` and the JSON error log for the crash reason; the session is terminated cleanly — retry with a new session, and file an issue with the log line if it reproduces. |
