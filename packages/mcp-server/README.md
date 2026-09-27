# @anvailabs/agentbrowser-mcp

The MCP server for [AgentBrowser](https://github.com/anvai-labs/agentbrowser). Two install paths, one source:

```sh
npm i -g @anvailabs/agentbrowser-mcp   # Node >= 18
# or: download the bun-compiled standalone binary from the GitHub Releases
```

The package is **only the MCP stdio adapter** — it proxies to an AgentBrowser service. Point it at one with `AGENTBROWSER_BASE_URL` (default `http://localhost:5709`).

Exposes AgentBrowser as a small set of high-level, safe, composable MCP tools
(ADR-009). Raw engine operations — evaluate, routing, selectors, low-level
input — are deliberately not exposed.

## Tool surface

See the [generated tool catalog](../../docs/mcp-tool-catalog.md) for unbound and delegated
surfaces, required arguments and output contracts. It comes from actual `tools/list`
responses, with a digest over complete descriptions and schemas. The existing release
artifact check rejects drift. Regenerate after building with
`node scripts/mcp-catalog-docs.mjs --write`.

`browser_session` inspects metadata and pages when given a `sessionId`. On a delegated
connection the binding supplies that ID and the same response also includes current
control status. The tool requires both `session.control` and `page.observe`; application
mode therefore does not expose it. Delegated mode removes create/close/cookies and adds
`browser_operation` (operation status). `AGENTBROWSER_MODE` fixes one profile for the
lifetime of the bridge connection. Reconnect to change profiles; clients may cache
catalogs. Obtain the effective catalog from your own connection with `tools/list`;
metadata never enlarges a session grant, and the service rejects a tool call that the
bearer grant's profile does not allow even if a mismatched bridge advertises it.

`qa`, `operations`, `appsec`, `bounty`, and `forms` currently project the complete
browser catalog. `audit` omits bulk autofill. `application` exposes only delegated
operation reconciliation until T4 publishes typed application tools. These deliberate
duplicates avoid fictional context savings; the generated catalog records exact result
bytes for every profile and binding.

### Protocol and result compatibility

The foundation candidate supports MCP `2024-11-05` and `2025-06-18`. Explicit legacy
clients keep text JSON and catalogs without output schemas/annotations. Newer or
unknown requested versions are offered `2025-06-18`; clients must support that returned
version or disconnect. Missing initialization retains historical text behavior; clients
should always perform the handshake. A connection cannot renegotiate while calls run.

Under `2025-06-18`, `browser_autofill` and `browser_plan` advertise canonical
`urn:agentbrowser:autofill-report:v1` and `urn:agentbrowser:plan-report:v1` schemas and return validated
`structuredContent` **plus identical serialized JSON text**. Plan retains optional mode/revision metadata to preserve the existing SDK contract;
the current server always supplies it. Other tools still return
text JSON; no unqualified output schemas are invented. Both tools' annotations explicitly
state that it mutates and is not safe to repeat. Hints are not authorization or proof
of browser/backend support. The [MCP tools specification](https://modelcontextprotocol.io/specification/2025-06-18/server/tools)
defines the structured/text compatibility behavior.

Failed autofill and plan reports (`ok: false`) now set `isError: true` in both protocols
while retaining complete receipt/result JSON. This changes error signaling from 1.8.18;
clients should inspect the retained report and must not treat it as a retry instruction.
Successful `verify: none` reports do not establish verification or application commit.
Invalid upstream bulk reports return a sanitized text error with uncertainty
instructions, never a fabricated structured success or an automatic second write.
Errors before a valid report exists remain text diagnostics without structured content.

This transport qualification does not yet certify structured-result consumption by
installed Victor, Codex or Claude clients. That remains T8 harness acceptance.

For qualified native forms, prefer `browser_autofill`; inspect each field's verification
receipt and preserve uncertain writes. For explicit heterogeneous steps use
`browser_snapshot` → `browser_plan` — see the
[main README](../../README.md#the-fast-path-for-forms-snapshot-then-plan).

## Multiple pages and large research results

`browser_create` still returns its initial `pageId`. Use `browser_page_create` with
that `sessionId` and an optional HTTP(S) `url` to create another page in the same
cookie context. Use `browser_pages` to discover page IDs, including adopted popups;
never invent an ID or expect navigation to create a page implicitly. These tools
delegate to the existing SDK, and the service remains the authorization/policy owner.
The equivalent shell interfaces remain `agentbrowser page create --help` and
`agentbrowser page list --help`.

Bound creation requires `operationId` chosen before dispatch. Controlled sessions
deduplicate that ID, but operation status does not retain the resulting page ID.
Ordinary sessions made by `browser_create` do not acquire deduplication from an ID
alone. Do not automatically retry an uncertain create in either case; inventory is
not proof of which page a concurrent create produced. A general explicit-page quota
and result correlation remain follow-ups, separate from the existing popup cap.

`browser_extract` preserves complete `data` and evidence within `maxBytes`. Its
default ceiling is 1 MiB of compact JSON including evidence; the operator can raise
the ceiling with `AGENTBROWSER_EXTRACT_MAX_BYTES` before starting the service.
Raw HTML size is not the extracted result size. Over-limit results fail explicitly,
with no partial JSON. The MCP text envelope is separately serialized and can be
larger. Any overflow files written by Claude or another harness belong to that
harness; AgentBrowser does not define their paths.

For the reproducible headed research smoke and its limits, see
[research qualification](../../docs/spec/evidence/consumer-research-smoke.md).

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
      AGENTBROWSER_BASE_URL: http://localhost:5709
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
| `AGENTBROWSER_BASE_URL` | AgentBrowser server to proxy to (default `http://localhost:5709`) |
| `AGENTBROWSER_API_KEY` | Bearer key for the service, when it has `AGENTBROWSER_API_KEYS` configured |
| `AGENTBROWSER_SESSION_ID` | Operator-configured delegated session binding; use its current delegated credential as the API key |
| `AGENTBROWSER_MODE` | Fixed mode profile for this connection: `qa` (default), `operations`, `audit`, `appsec`, `bounty`, `forms`, or `application` |
| `AGENTBROWSER_MCP_VERSION` | Override the reported `serverInfo.version` (debugging; the binary is otherwise stamped at build time from `package.json`) |

## Building and gating the binary

```sh
pnpm --filter @anvailabs/agentbrowser-mcp compile   # -> dist-bin/agentbrowser-mcp (needs bun)
pnpm --filter @anvailabs/agentbrowser-mcp smoke     # stdio handshake + full tool-catalog gate
```

Cross-compile with `node scripts/compile.mjs --target=bun-linux-arm64 --outfile=...`.
CI runs both on every PR (`Bun compile + smoke` job), and every `v*` tag
publishes the five-target release matrix — see `docs/td/TD-BROWSER-5-single-binary-mcp-distribution.md`.
