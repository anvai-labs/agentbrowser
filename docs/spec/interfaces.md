# Interfaces, harness integration and human experience

Status: shared interface design; new profiles, remote MCP and public application tools
remain implementation tasks. Reuse existing adapters and SDK rather than add gateways.

## One operation contract, several projections

CLI, MCP, REST and operator UI translate into the same admission, execution and result
contracts. None owns a second journal, policy engine or retry loop. Keep logical
sessions independent of transport connections. Stdio remains a compatibility bridge
to an independently managed service. HTTP is the portable service boundary; retain
current WebSocket events and qualify cursor polling before adding another stream.

UDS/Windows named pipes are optional local transport adapters. POSIX FIFO is not
the common bus. A different transport cannot repair missing authority, correlation,
durable receipts or event resynchronization.

## Tool and schema selection

Proposed profiles project a subset of one canonical tool registry. Avoid parallel
names such as `qa_click`, `forms_click` and `security_click`. Global instructions
cover shared invariants once; individual descriptions state purpose, selection rule,
preconditions, side effects and result limitations. Workflow recipes load on demand.

| Task | Preferred existing primitive / future extension |
| --- | --- |
| Read current page | Bounded semantic observation or snapshot |
| Fill qualified native controls with known values | `browser_autofill` |
| Execute explicit bounded heterogeneous steps | `browser_plan`, with its actual remap semantics |
| One interaction or diagnostic step | `browser_act` with fresh target evidence |
| Reconcile a delegated write | Existing operation-status surface |
| Inspect raw markup | Explicit `browser_html` or authorized artifact read; sensitive data |
| Run a repeatable test | Future TestRun adapter over shared operations |
| Execute an application operation | Existing in-process typed port; public adapter pending |

The baseline catalog is 13 unbound tools, or 12 delegated tools. Treat counts as
generated release facts, not constants replicated in README, smoke scripts and agent
recipes. Preserve explicit acceptance expectations where they catch missing exports;
compare generated declarations to actual runtime catalogs, not to themselves alone.

Profile omission reduces context but does not secure the service. Calls to hidden or
unsupported operations still require server policy checks. For clients that cache
tools and cannot handle list-change semantics, use a fixed profile per bridge
connection. Profile changes require reconnection/refresh and server reauthorization;
they do not replay pending mutations. Do not trim a mutating tool's input union into
a purportedly read-only profile unless the server enforces the same restriction.

Add typed output schemas and structured results with serialized text compatibility
for older clients. Preserve nested constraints and conservative effect annotations.
The MCP spec supports these result mechanisms; annotations are hints, not authority.
[MCP tool contract](https://modelcontextprotocol.io/specification/2025-11-25/server/tools)

## Protocol and harness compatibility

Current AgentBrowser advertises `2024-11-05`. Negotiate only tested revisions; never
change a version constant and claim full compatibility. Service session IDs, operation
IDs and event cursors remain application contracts independent of MCP transport
sessions. In particular, newer HTTP transport semantics differ from older optional
MCP-session/event-stream behavior. Pin the source revision used for implementation.
[Upstream HTTP transport design](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/docs/specification/2026-07-28/basic/transports/streamable-http.mdx)

| Harness | Reuse boundary | Qualification requirement |
| --- | --- | --- |
| Victor (`../codingagent`) | Existing MCP client, registry and tool projector | One response dispatcher; nested schemas/results intact; bounded pending calls and retirement |
| Codex / Claude | Existing configured MCP or CLI integration | Record installed versions, profile catalog, actual structured results and recovery behavior |
| Generic CLI harness | Existing CLI/SDK | JSON output, exit status, artifact references and no automatic write retry |
| Browser operator UI | Existing delegated control panel | Authority transitions, resync, keyboard accessibility and uncertain-result display |

The inspected Victor checkout still has a per-request stdout reader and warns on
response-ID mismatch. That source finding is not qualification of another installed
Victor build. Repair/reuse one transport implementation before enabling overlapping
calls. Compare the official MCP client behind the existing interface before expanding
a custom transport; dependency and lifecycle tests decide, not framework preference.

## Human interaction contract

Show session, account/resource, active mode, capabilities, current controller and
pending operation. Takeover displays requested/draining/complete states; disconnection
cannot look like confirmed takeover. Resume requires fresh evidence and authority.
Make warnings specific: unsupported widget, incomplete observation, changed binding,
unknown write outcome, expired evidence or cleanup failure.

Questions and decisions must appear inline in the main activity flow. Support mouse,
Tab/Enter and plain text answers; do not require a left-arrow key or hidden side panel.
Reuse one accessible form/decision component across modes. Preserve existing approved
scope; avoid asking again for each field. An uncertain write offers status/reconciliation,
not a default Retry button. Show per-step effects without requiring users to understand
transport internals. Baseline changes and compensation are reviewable explicit actions.

## Application-native interfaces

Use trusted application adapters for setup, cleanup, independent outcome checks and
browser-free workflows. WebMCP can expose structured application operations but stays
an optional adapter behind the same scope and verification rules.
[WebMCP application tools](https://developer.chrome.com/docs/ai/agents)

Do not silently replace a requested UI test with an API call. Record seam coverage
independently for UI, application API and agent-native tools. UI/API parity shares
business predicates and fixtures, not the execution path under test.
