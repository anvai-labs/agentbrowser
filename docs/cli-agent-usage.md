# AgentBrowser from shell-based agents

Status: CLI bulk autofill shipped in 1.8.18 (#177/#178). Offline `describe`, optional
autofill schemas and bounded JSON input are local foundation-discovery additions;
use a build containing this increment for the examples below.

The CLI is a thin SDK client to the shared AgentBrowser service. It owns no browser
session state or alternate executor. Use ordinary Bash/shell tools to inspect JSON;
MCP is an alternative adapter to the same execution and authority boundaries.

## Discover only the command you need

```sh
agentbrowser describe
agentbrowser describe act
agentbrowser describe act press
agentbrowser describe session create
agentbrowser describe autofill --schema
agentbrowser describe plan --schema
agentbrowser describe outcome --schema
agentbrowser describe act press | jq '{usage: .command.usage, options: .command.options}'
agentbrowser act press --help
```

`describe` always emits one JSON object, without constructing a service client,
connecting to a server or launching a browser. It includes the discovery schema and
product versions, usage, arguments, local/global options and immediate child commands.
The command definitions already used by the parser/help are the source; there is no
parallel CLI command catalog. A child listing omits descendants and their options;
request that child's path to expand it.

`scope: "cli-command-definitions"` means installed CLI syntax, **not** live backend
capabilities or granted permissions. This is metadata, not a complete action JSON
schema by default. `describe autofill --schema`, `describe plan --schema`, and
`describe outcome --schema` include canonical input and output schemas (plan input is
an array, matching its CLI payload); other commands currently return `schemas: null`
with that flag.
Schemas are emitted only on request, with nested constraints intact. Protocol semantic
checks (such as exactly one value/option and the supported regex subset) still apply;
a JSON-schema match alone is not execution authorization or semantic validation.
Unknown paths exit 1, write a diagnostic to stderr and emit no partial JSON to stdout.
Discovery includes static option defaults, never supplied option values or API keys.

## Execute with bounded context and explicit outcomes

Examples assume an authorized existing session/page and fresh element refs. Keep
credentials in the existing `AGENTBROWSER_API_KEY` environment mechanism; avoid passing
secrets as shell arguments, enabling shell tracing or saving private output in logs.

```sh
set -euo pipefail
session_id='AUTHORIZED_SESSION_ID'
page_id='AUTHORIZED_PAGE_ID'

agentbrowser --json session control "$session_id"
agentbrowser --json snapshot "$session_id" "$page_id" --max-elements 30 --max-bytes 12000 \
  | jq '{url, revision, mode, truncated, fields}'
```

Check completeness and current authority before mutation. Truncated/degraded evidence
does not prove uniqueness. Discover the next command's syntax with `describe`; quote
all data arguments and use JSON tools rather than evaluating generated shell strings.

For a mutation in a delegated session, select a fresh operation ID before dispatch and
retain it for reconciliation. The following is an example syntax, not permission to
operate an arbitrary page:

```sh
operation_id="$(uuidgen)"  # requires uuidgen; retain this ID for this one attempt
agentbrowser --json --operation-id "$operation_id" \
  act press "$session_id" "$page_id" ArrowDown --count 2

# After a lost response, query this operation before considering another write:
agentbrowser --json session operation "$session_id" "$operation_id"
```

Run the status query separately after a failed command; `set -e` stops a failing script.
Do not place mutations in automatic retry loops. Missing/expired operation records
leave the outcome uncertain and require independent application evidence. Operation
records currently do not provide durable report recovery across service restart.

Autofill and plan now exit 1 for `ok: false`, preserving the complete report on stdout
with `--json`. This is a deliberate change from 1.8.18: scripts must capture stdout even
on nonzero exit. Exit 0 still does not prove verification (for example, `verify: none`);
inspect receipts and per-step outcomes. Other action commands retain existing exit semantics. A browser command's success
does not establish an application commit. Existing commands have command-specific
output: use `--json` for structured results; raw HTML is sensitive even in JSON form.

## Choose the execution primitive

| Need | Surface today |
| --- | --- |
| Current semantic targets | CLI `snapshot` / `observe`; corresponding MCP tools |
| Explicit bounded ordered steps | CLI `plan`; MCP `browser_plan` |
| One interaction | CLI `act <command>`; MCP `browser_act` |
| Qualified native scoped bulk forms | CLI `autofill`, SDK/REST autofill or MCP `browser_autofill` |
| Plan plus independently registered outcome verifier | CLI `outcome` or SDK/REST outcome; MCP has no outcome tool |
| Uncertain delegated mutation | CLI `session operation`; delegated MCP `browser_operation` |
| Repeatable TestRun / durable workflow | Planned; do not infer availability from the design spec |

## Submit bulk JSON without putting private values in argv

Autofill and plan share one reader: inline JSON remains supported, `@path` reads a
regular file, and `-` consumes piped stdin once. Each JSON argument has a 1 MiB UTF-8
byte ceiling; stream reading has a 30-second total deadline, including waiting for EOF.
The input deadline is separate from HTTP/execution timeouts. Invalid UTF-8, malformed
JSON, oversized input, interactive stdin, directories and named FIFOs fail before
dispatch. Diagnostics omit payload excerpts and filesystem error details. File open
and metadata operations still depend on filesystem responsiveness; prefer local files.

```sh
# form.json contains {"fields":[...],"policy":{...}} under the canonical schema.
# Keep this file and the resulting receipts private.
operation_id="$(uuidgen)"
if agentbrowser --json --operation-id "$operation_id" \
    autofill "$session_id" "$page_id" @form.json >report.json; then
  jq '{ok, receipts, snapshot, snapshotError}' report.json
else
  # An available report records partial effects; no report may mean a lost response.
  if test -s report.json; then jq . report.json; fi
fi

# Alternative: pipe one already-prepared plan. Do not run this as a retry of autofill.
operation_id="$(uuidgen)"
agentbrowser --json --operation-id "$operation_id" \
  plan "$session_id" "$page_id" - <steps.json

# outcome.json contains actions plus an exact registered verifier ID/version and input.
operation_id="$(uuidgen)"
agentbrowser --json --operation-id "$operation_id" \
  outcome "$session_id" "$page_id" @outcome.json >outcome-report.json
jq '{plan, outcome}' outcome-report.json
```

Use a **different fresh operation ID for each intended mutation**, including the plan
alternative. Retain the chosen ID outside command output for uncertain-response
reconciliation. A script must not blindly resubmit failed reports. `--policy` keeps its
existing wholesale replacement semantics and uses the same reader; request and policy
cannot both consume stdin. Native widget support and all server authority checks are
unchanged. Full-form snapshot artifacts and JSON receipts may contain private data.
The `outcome` command exits 0 only when availability, execution, verification and
cleanup all satisfy the canonical pass predicate. A nonzero exit may still include a
complete report on stdout. Preserve it for diagnosis and reconcile uncertain writes;
do not replay the mutation automatically. The server deployment must register the
exact verifier and read-only evidence source. Verifier input is bounded JSON and can
be private; the response contains only verifier metadata and opaque evidence IDs.

Follow the shared [modular implementation plan](spec/tasks/README.md). Remaining T0
work includes broader canonical schema coverage and installed-harness qualification.
The subsequent MCP increment adds a [generated catalog](mcp-tool-catalog.md) and negotiated
structured autofill and plan reports; other MCP result contracts remain to be qualified.
