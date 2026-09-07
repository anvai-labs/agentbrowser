# Operating AgentBrowser

A practical guide to running the AgentBrowser service: installation,
configuration, health and metrics, day-to-day operation, and
troubleshooting. For what AgentBrowser is and how to drive it as a
client, start with the [README](../README.md); for the security model,
see the [threat model](threat-model.md) and the
[safety ADRs](README.md#core-architecture-adrs).

## Operator approval policy

`AGENTBROWSER_APPROVAL_POLICY` accepts a JSON object, or embedders can pass
`ServerOptions.approvalPolicy`. Rules use exact hostname/action/role/name matches;
the first matching rule wins. They are trusted deployment configuration, not
instructions accepted from the page or from an agent request. For example:

```json
{"unknownRisk":"required","rules":[{"hostname":"shop.example","action":"click","name":"Pay","effect":"transaction"}]}
```

Unknown-risk actions default to `allow` for local automation; select `required`
for conservative operation. Recognized high-risk effects require confirmation
unless an operator rule explicitly allows or denies them. Session
`policy.approval.transactions` and `externalMessages` can tighten a decision to
`required` or `deny`, but cannot relax the operator policy. Rules do not infer
transaction semantics from arbitrary page text; audit them for your workflows.

On `APPROVAL_REQUIRED`, clients must obtain operator confirmation before retrying
with `details.tokenId` as `approvalToken`. The token is single-use and bound to
page, revision, resolved target fingerprint and action parameters. This protocol
records caller confirmation; it does not independently authenticate a human.
Stale targets must be reobserved and require new confirmation.

## Installation

### Release version consistency

Root `package.json` owns the product version. When preparing a release, change
that version once, run `pnpm release:sync`, and commit the synchronized manifests
and generated stamps together. `pnpm release:check` is read-only; after building,
`pnpm release:artifacts` exercises API health, CLI `--version`, and MCP initialize.
CI rejects drift and release tags must equal `v<product-version>`. Matching package
versions identify one shipped product; they do not claim every package changed.

### Upgrading from 1.8.4 to the 1.8.5 candidate

The owner retained the 1.8.5 release label after compatibility review. This is
an explicit versioning exception, not a claim of a bug-fix-only SemVer patch:
page listing adds a public REST endpoint, and custom-policy embeddings have a
migration requirement. The packages' private npm status does not establish that
exported embedding interfaces are unsupported. No unchanged-behavior guarantee
is made for those integrations.

- Existing REST/CLI/MCP request shapes remain supported; page listing is additive.
- The built-in idle default changes from two to ten minutes, retaining idle
  browser resources longer. Set `AGENTBROWSER_DEFAULT_IDLE_TIMEOUT_MS=120000` or
  per-session `idleTimeoutMs: 120000` to retain the previous idle window. Explicit
  overrides still win; session TTL is a separate limit.
- Snapshot recovery requires fresh semantic evidence before acting.
  On `STALE_TARGET`, obtain a new observation and reconsider the action. Do not
  blindly retry a mutation after a timeout: failure does not prove no side effect.
- Embedders injecting custom `NetworkPolicy` subclasses or overridden methods
  must implement `snapshot()` with immutable rules preserving **all** custom
  checks before creating download-enabled sessions. Otherwise creation fails
  with `ENGINE_UNSUPPORTED`. Do not bypass this refusal by copying only base
  configuration or returning a mutable policy. Built-in policies need no custom
  implementation; sessions without downloads retain injected-policy behavior.
- Download-enabled sessions capture policy before engine creation. Later base
  `updateConfig()` calls affect new sessions, not existing captured generations;
  close/recreate those sessions to apply updated rules, including deny changes.

See the [production integration contract](connection-authority-design.md#t2b2-production-integration-boundary)
for policy snapshot and cancellation semantics. Validate custom integrations
before upgrading. The [release tracker](release-milestones.md) distinguishes
candidate integration checks from published and installed acceptance; version
preparation alone is not release completion.

### Homebrew (macOS / Linux)

```bash
brew install anvai-labs/tap/agentbrowser
brew services start anvai-labs/tap/agentbrowser   # the service, on 127.0.0.1:3000
```

One install ships all three surfaces:

- the **browser service** (`agentbrowser-server`) — REST + WebSocket on
  port 3000; first start bootstraps Chromium into
  `$(brew --prefix)/var/agentbrowser/browsers`;
- the **MCP server binary** (`agentbrowser-mcp`) — a standalone stdio
  binary that proxies to the service; no Node runtime needed;
- the **CLI binary** (`agentbrowser`) — scriptable commands that also connect
  to the service; no Node runtime needed for the compiled client.

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

The service and MCP process use environment variables; there is no config file.
The CLI also has explicit flags. SDK embedders provide `ClientOptions.baseUrl`
and `ClientOptions.apiKey`; the SDK does not read these environment variables.

| Variable | Who reads it | Meaning |
| --- | --- | --- |
| `AGENTBROWSER_API_KEYS` | service | Bearer auth for `/v1`, format `key:tenant[,key:tenant...]`. **Without it, `/v1` is unauthenticated** — the service logs a loud warning at startup. Each key maps to one tenant; sessions are isolated per tenant. |
| `AGENTBROWSER_API_KEY` | MCP server, CLI | The bearer key sent to the service; CLI `--api-key` takes precedence. |
| `AGENTBROWSER_BASE_URL` | MCP server | Service location; default `http://localhost:3000`. The CLI uses `--base-url`, not this variable. |
| `AGENTBROWSER_LOG_LEVEL` | service | `debug` or `info` (default). Logs are structured JSON, scrubbed of registered secrets. |
| `AGENTBROWSER_CHROME_PATH` | service (Playwright engine) | Prefer a specific real Chrome for headed sessions ([ADR-013](adr/013-headed-sessions-and-walled-logins.md)). |
| `AGENTBROWSER_ARTIFACT_KEY` | service | Bearer key guarding artifact download URLs, when set. |
| `AGENTBROWSER_DEFAULT_TTL_MS` | service | Operator-level default session TTL (ms); per-session `ttlMs` still wins. Unset/garbage → the 15-min default. |
| `AGENTBROWSER_DEFAULT_IDLE_TIMEOUT_MS` | service | Operator-level default idle timeout (ms); per-session `idleTimeoutMs` still wins. Unset/garbage → the 10-min default. Useful for deployments that are mostly headed human-in-the-loop flows. |
| `AGENTBROWSER_SNAPSHOT_TIMEOUT_MS` | service (Playwright engine) | Shared snapshot-wait budget per observation and timeout per action-time semantic check, in integer ms (1–30000; default 1000). Invalid environment values use the default; invalid explicit engine options throw. Timed-out element captures use a successful whole-document accessibility snapshot as fallback evidence, which must still match before acting. Unrelated document changes can therefore stale a fallback ref; observe again. Missing semantic evidence refuses actions, and non-timeout errors propagate. This bounds snapshot waiting, not all observation DOM work. |

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

### Observation and event budgets

Observation `maxBytes` measures the final redacted UTF-8 JSON, including cursor
metadata. Element pagination addresses the complete prioritized observation;
pass `continuation.nextOrdinal` as `continueFrom` while the page revision remains
unchanged. The default page contains at most 300 elements. Text and diff details
are truncated without a separate text/diff cursor; request a larger budget for
those. If identity plus the next element cannot fit, `OUTPUT_TRUNCATED` reports
`details.minBytes` instead of returning an oversized or non-advancing result.

Service event replay retains at most 500 other events / 1 MiB and 1,000 request
events / 2 MiB per session. Events over 64 KiB are dropped before replay and
broadcast. `events_dropped_total` and `events_evicted_total` expose loss with
bounded-cardinality labels. These byte counts cover serialized service ledgers,
not engine-side queues, live DOM snapshots, serialization temporaries, or total
process memory. Pending approval tokens have a hard admission cap; full capacity
returns `QUOTA_EXCEEDED` until used or expired tokens can be reclaimed.

Sessions are **ephemeral by default** ([ADR-005](adr/005-ephemeral-sessions-explicit-persistence.md)):

- default TTL **15 minutes**, default idle timeout **10 minutes** — both
  overridable per session (`ttlMs`, `idleTimeoutMs` on create), and the
  defaults themselves are operator-tunable
  (`AGENTBROWSER_DEFAULT_TTL_MS` / `AGENTBROWSER_DEFAULT_IDLE_TIMEOUT_MS`);
- expiry is **lazy on access plus a 1-hour background sweep** (the
  coordinator's 30-second default is unused by the API service): a lapsed
  session is reaped the moment anything touches it, and the periodic sweep
  catches anything idle between touches, dropping its pages, listeners,
  and per-session policy state, and emitting `page.destroyed`
  (reason `session-expired`) on the session's event stream;
- closing a session (`DELETE /v1/sessions/:id`, CLI `session close`,
  MCP `browser_close`) releases the browser context immediately and
  invalidates all of its element refs.

Engine crashes are not silent: the affected session is terminated,
removed from tracking, counted in `sessions_crashed_total`, logged at
error level, and recorded in the crash audit — callers get a typed
`ENGINE_CRASHED` error, never a hang.

## Choosing an engine

### Egress and download limits

Delivery note: the direct-download and captured-download improvements below
merged into `develop` in [PR 80](https://github.com/anvai-labs/agentbrowser/pull/80).
This is a partial correction, not browser containment: R4 remains open in the
[delivery tracker](engineering-review-remediation.md). Integration into `develop`
does not itself publish a release.

Direct URL downloads validate every redirect and resolved address, pin the
validated connection address, and bound decoded bytes and the whole-operation
deadline. Captured browser downloads are disabled unless `allowDownloads` is
enabled. Completed captures have unique `downloadId` values; collect by ID when
filenames repeat. Collection consumes the retained bytes, and page close drops
uncollected captures (at most 100 entries / 20 MiB retained per page).

These are application limits, not a process-isolation guarantee. Playwright's
interception fetch buffers a response before the actual-size check, and its
connection resolution is separate from the policy DNS check. Browser downloads
can also occupy temporary disk before the completed-file size check. Untrusted
multi-tenant deployments need network-enforced egress and memory/disk quotas at
the process/container boundary described by ADR-008; trusted local deployments
retain that explicit deferral.

Sessions name their engine (`engine` field on create / MCP
`browser_create`). The registry resolves the primary engine by default
and fails loudly (`ENGINE_NOT_FOUND`) on unknown names — a session never
silently runs on a different engine than requested. The full matrix,
including per-engine egress guarantees, is in the
[engine matrix](engines.md). Notes for operators:

- **Chromium (Playwright)** is the production default; the egress policy
  checks routed requests, first redirect targets and resolved IPs. Later hops
  and connection pinning remain open; see the deployment limitations below.
- **Safari** (`engine-safari`) is macOS-only and always headed; it
  refuses policy-bearing sessions with `ENGINE_UNSUPPORTED` and
  `details.reason: EGRESS_UNSUPPORTED`. The REST service always attaches
  policy, so driver enablement alone does not make REST Safari sessions work.
  Direct-engine local use without policy is distinct and trusted-only; it
  offers no network interception or console/network event evidence. Driver
  requests have whole-response deadlines, but timeout does not prove an
  action failed to execute and must not trigger an automatic mutation retry.
- **Obscura** (`engine-obscura`) is experimental, unregistered, and
  benchmark-only — it cannot be selected by a session, by design; see the
  Obscura section in [engines.md](engines.md).

## Operating through the CLI

The `agentbrowser` CLI (`packages/cli`) is a thin, scriptable surface over
the SDK — useful for smoke checks and ad-hoc automation. It ships as a compiled
binary in GitHub Releases and with `brew install anvai-labs/tap/agentbrowser`.
Source-checkout use remains available: `pnpm --filter @agentbrowser/cli build`,
then `node packages/cli/dist/bin.js`. The CLI connects to a separately running
API service:

```bash
# The bearer is the KEY segment only - the server parses `key:tenant` pairs
# and matches on the key's hash, so sending `key1:tenant1` as the bearer 401s.
export AGENTBROWSER_API_KEY=key1

agentbrowser --base-url http://localhost:3000 session create --tenant tenant1 --json
agentbrowser navigate <sessionId> <pageId> https://example.com
agentbrowser act click <sessionId> <pageId> <ref>
agentbrowser session list
agentbrowser session close <sessionId>
```

The remaining commands use the default local URL. For a nondefault service,
pass `--base-url` on every command; exporting `AGENTBROWSER_BASE_URL` configures
the MCP process only.

`--json` emits raw API payloads for scripting; `--no-headless` opens a
headed session for interactive logins (export the cookies afterward and
seed future headless sessions with them — [TD-BROWSER-6](td/TD-BROWSER-6-headed-sessions-and-credential-handoff.md)).

### Executable release checks

From a source checkout, test downloaded or installed executables against an
explicit expected release version, independently of the checkout's version:

```bash
node packages/cli/scripts/smoke.mjs --expected-version 1.8.4 /absolute/path/to/agentbrowser
node packages/mcp-server/scripts/smoke.mjs --expected-version 1.8.4 /absolute/path/to/agentbrowser-mcp
```

Omit `--expected-version` only for builds matching the checkout. A Node entry
point is also supported: pass the absolute Node executable followed by the
entry-point path. Success emits JSON evidence; failures exit nonzero.
Each child has a 20-second deadline and a combined 1 MiB stdout/stderr limit;
failure cleanup escalates from termination to forced termination with bounded
waits. CLI checks exact version and help. MCP checks the negotiated protocol,
exact version, all eleven tools, valid output and clean shutdown, clearing the
runtime version override to prevent false version evidence. These checks do
not launch a browser or certify API connectivity, downloads, containment or a
Homebrew upgrade. Those are separate [release acceptance gates](release-milestones.md).

### Extracted-package candidate checks

PR CI and release packaging use the same packager and real-Chromium harness.
From a clean, built checkout, with compiled CLI/MCP binaries and `qpdf` and
`openssl` on PATH:

```sh
RUN_DIR="$(mktemp -d /private/tmp/agentbrowser-acceptance.XXXXXX)"
# On Linux, use /tmp in place of /private/tmp.
VERSION="$(node -p "require('./package.json').version")"
TARGET="$(node -p "process.platform + '-' + process.arch")"
COMMIT="$(git rev-parse HEAD)"
node scripts/package-server.mjs --output-dir "$RUN_DIR/package" --target "$TARGET" --expected-version "$VERSION" --commit "$COMMIT"
tar -xzf "$RUN_DIR/package/agentbrowser-server-$TARGET.tar.gz" -C "$RUN_DIR"
node scripts/package-acceptance.mjs --server-root "$RUN_DIR/server" --expected-version "$VERSION" --expected-commit "$COMMIT" \
  --cli "$PWD/packages/cli/dist-bin/agentbrowser" --mcp "$PWD/packages/mcp-server/dist-bin/agentbrowser-mcp" --install-browser --report "$RUN_DIR/acceptance.json"
```

The packager refuses existing output directories, mismatched versions/commits
and dirty source. `--allow-dirty` is for explicitly unverified local work only;
the archive is marked dirty and acceptance cannot report release evidence.
Retain the JSON report and archive checksum with the candidate SHA. Remove the
allocated `RUN_DIR` after recording evidence and confirming it is no longer used.
This is a shared packaging procedure, not a byte-for-byte reproducible-build claim.

The stock launcher checks authentication and private-address/default-download
denial. A separate process imports only extracted modules and uses trusted
`buildServer({ networkPolicy })` injection for deterministic loopback fixtures;
session rules remain restrict-only. Fixture TLS trust is child-local, never a
host CA change. This process exercises browser actions, PNG/PDF validation,
HTTP/TLS downloads, cancellation, snapshot fault injection and live CLI/MCP calls.
`qpdf` is an acceptance-only parser dependency, not a new server requirement;
its checks do not establish that every PDF renderer accepts a document.
Cleanup failures fail acceptance; forced API termination leaves browser-descendant
cleanup unverified. No existing Homebrew service is restarted.

Published/npm and installed upgrade checks remain separate delivery gates.
The exact 1.8.4 server archive has an escaping pnpm self-link and cannot pass the
strict package-tree audit; its baseline profile also lacks injected-workflow
support. Record these limitations rather than substituting workspace code.

## Deployment notes

- **Browser egress is partial**: routed requests and first redirect targets are
  checked, but later redirect hops bypass routing. Browser DNS checks do not pin
  connections, and response-size checks run after buffering. Page WebSocket
  denial is not proof of worker or transport-wide coverage. Direct-download
  pinning and streaming caps do not extend to browser traffic. Do not rely on
  this layer alone for required SSRF containment. Native local operation remains
  available; a contained profile requires OS-enforced gateway-only egress and
  independent bypass tests before it can be released.
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
| `404 SESSION_NOT_FOUND` for a session that existed | The session TTL/idle expired (15 min / 10 min defaults). Create a fresh session; seed cookies if continuity matters. |
| `STALE_TARGET` on every action on a dynamic page | Refs die with their revision — re-observe, or prefer `browser_snapshot` + `browser_plan`, which self-heals stale refs once per step. |
| Plan aborts with `AMBIGUOUS_REMAP` | The page churned enough to enter `verified` mode and no remap candidate matched the original element's role+label. Re-observe and rebuild the plan — the executor refused to guess rather than act on the wrong element. |
| Browser download slow/failing | First service start bootstraps Chromium; on Homebrew installs it lands in `$(brew --prefix)/var/agentbrowser/browsers`. |
| Engine crash loops | Check `sessions_crashed_total` and the JSON error log for the crash reason; the session is terminated cleanly — retry with a new session, and file an issue with the log line if it reproduces. |
