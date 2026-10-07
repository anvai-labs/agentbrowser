# AgentBrowser from shell-based agents

Baseline: AgentBrowser 1.10.1 includes offline `describe`, bounded JSON input,
plan/autofill result validation, receipt-correlated `outcome`, offline `test evaluate`,
reusable `form prepare`, checked uploads and capture readiness waits. Synthetic
fixture qualification does not prove production evidence or durable recovery.
The 1.11.0 candidate adds extraction budgets, MCP page provisioning and captured
launch diagnostics; publication and installed qualification are separate release gates.

The CLI is a thin SDK client to the shared AgentBrowser service. It owns no browser
session state or alternate executor. Use ordinary Bash/shell tools to inspect JSON;
MCP is an alternative adapter to the same execution and authority boundaries.

## Find the answer in CLI help first

`agentbrowser --help` gives the service/client configuration split and a narrow LAN
startup example. `agentbrowser session create --help` covers headed sessions and
page creation; `agentbrowser session cookies --help` documents file formats and
private credential handoff; `agentbrowser navigate --help` explains policy refusals.
These notes and examples are also available as `command.notes` and
`command.examples` in offline `describe` output. They are static guidance, never a
dump of the current environment, and are not proof of a running server's settings.

```sh
agentbrowser describe session create | jq '.command | {usage, notes, examples}'
agentbrowser describe session cookies
agentbrowser describe plan --schema
```

For an authorized headed workflow, reuse an existing session where possible:

```sh
agentbrowser --json health
agentbrowser --json session list
agentbrowser session create --tenant TENANT --no-headless --viewport 1440x1000 \
  --ttl 14400000 --idle-timeout 3600000
# Replace SESSION with the returned ID; CLI creation does not create a page.
agentbrowser page create SESSION --url https://example.com
# Replace PAGE with the returned ID; snapshot supplies current element refs.
agentbrowser snapshot SESSION PAGE --max-elements 40
```

The visible window belongs to the **server host**. A fresh isolated session does not
inherit a daily Chrome profile. MCP `browser_create` differs from CLI creation: it
also provisions an initial page and returns both IDs. Cookie seeding is only an
attempt to reuse authentication; verify the expected signed-in UI afterward.

### Which process must receive an environment variable?

| Setting | Reader | Effect |
| --- | --- | --- |
| `--base-url` | CLI | Selects the REST service. |
| `AGENTBROWSER_BASE_URL` | MCP adapter | Selects the REST service; the CLI does not use this variable. |
| `AGENTBROWSER_API_KEY` | CLI and MCP adapter | Sends an existing bearer credential. |
| `AGENTBROWSER_API_KEYS` | Server at startup | Configures `key:tenant` credentials; unset means an unauthenticated local service. |
| `HOST`, `PORT` | Server at startup | Selects the listener; keep local instances on loopback. |
| `AGENTBROWSER_ALLOWED_CIDRS` | Server at startup | Operator-authorized private-IP exceptions, never a loopback or metadata bypass. |
| `AGENTBROWSER_MAX_RESPONSE_BYTES` | Server at startup | Per-response network byte cap: defaults to 10 MiB; operator override from 1 through 67108864 bytes (64 MiB). Session/CLI requests cannot raise it. |

An existing Homebrew service keeps its startup environment. Exporting a variable in
a new CLI/MCP process does not reconfigure that service. Preserve active sessions
before an authorized restart, or start a separate local service on an unused port:

```sh
# Operator-authorized example: one lab host, not the entire LAN.
AGENTBROWSER_ALLOWED_CIDRS=192.168.1.89/32 HOST=127.0.0.1 PORT=5719 agentbrowser-server
# In another shell, connect explicitly to that service.
agentbrowser --base-url http://127.0.0.1:5719 --json health
agentbrowser --base-url http://127.0.0.1:5719 session create --tenant TENANT --no-headless
```

For `request.failed` with `RESPONSE_TOO_LARGE (actual-byte cap)`, a large site
JavaScript bundle may have been blocked. A page may then show only a loading screen
or a secondary JavaScript error. This is not evidence of an expired login or a site
bot wall. An operator can start a separate server with a bounded larger budget:

```sh
AGENTBROWSER_MAX_RESPONSE_BYTES=33554432 HOST=127.0.0.1 PORT=5719 agentbrowser-server
```

Use an unused port; do not restart another operator's active service. This setting
applies to all sessions on that server, so prefer an isolated server for an exception.
With Homebrew Services, persist the override in
`~/.homebrew/services/agentbrowser.env` (one `KEY=value` per line), then restart
the service only after its active sessions have finished. Setting the variable in
the CLI's shell does not change an already-running server.
Unset/blank preserves the 10 MiB default. Non-decimal, zero, negative, fractional,
or over-64-MiB values abort startup. It does not change extraction-output budgets or
download authorization/budgets. Existing SSRF and host restrictions still apply.
The Playwright adapter checks the actual body after buffering; this is a limit on
bytes delivered to the page, not a peak-memory guarantee.

The allowlist is comma-separated CIDRs and must be configured by the operator.
It permits the named private addresses through the base policy; it does not restrict
ports. `--allow-hosts` only narrows a session's permissions. Loopback and cloud
metadata remain denied even with a broad CIDR. A `POLICY_DENIED` result can reflect
other rules; inspect its bounded reason and operator configuration before acting.
Do not invent an allow-loopback flag or use CDP attachment as a policy workaround.
For exact enforcement semantics, see [LAN policy](HANDOFF-LAN-CIDR-ALLOWLIST.md).

### Explicitly authorized loopback testing

The stock server intentionally blocks loopback. Adding `127.0.0.1/32` to
`AGENTBROWSER_ALLOWED_CIDRS` does **not** override it; neither does `--allow-hosts`.
Do not retry these settings as a workaround for a refusal. Stop and obtain an
explicit operator exception if a local synthetic test requires loopback.

After that authorization, the existing trusted embedding API supports a separate
test service. This is operator deployment code, not a session/MCP parameter or a
new environment flag. In a workspace with these packages built and resolvable:

```ts
import { startServer } from '@agentbrowser/api';
import { NetworkPolicy } from '@agentbrowser/policy';
import { PlaywrightChromiumEngine } from '@agentbrowser/engine-playwright';

const server = await startServer({
  host: '127.0.0.1',
  port: 5727, // First verify this port is unused.
  engine: new PlaywrightChromiumEngine(),
  networkPolicy: new NetworkPolicy({
    blockLoopback: false,
    blockPrivateIPs: true,
    blockMetadata: true,
    allowedPrivateCIDRs: ['127.0.0.1/32', '::1/128'],
  }),
});
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => { await server.close(); process.exit(0); });
}
```

Keep it loopback-bound, use synthetic data and configure authentication when
credentials or other local users are in scope. Connect a **new** isolated session
with `--base-url http://127.0.0.1:5727 session create --tenant local-test
--no-headless --allow-hosts localhost,127.0.0.1`. The session allowlist restricts
hosts, not ports. This is not permission to browse unrelated local services.
Existing sessions stay owned by their original service and authority; restarting
the main service or guessing its session IDs is unnecessary.

`localhost` often resolves to **both** IPv4 `127.0.0.1` and IPv6 `::1`. The router
checks every resolved address: permitting only IPv4 can let a literal IPv4 URL
work while `localhost` fails. Inspect the intended listener/address family and
permit both loopback CIDRs only within the approved exception. Keep cloud metadata
and other private ranges denied. A policy pass does not prove TCP reachability;
check the tunnel and application response separately. Stop the test service and
tunnel when finished; do not change the shared server's default policy.

Code references: `packages/api/src/network-policy-config.ts`, trusted
`ServerOptions.networkPolicy` in `server.ts`, and `checkResolvedAddresses` in
`packages/policy/src/network-policy.ts`. The Sandesha headed synthetic smoke on
2026-10-01 reproduced stock loopback refusal, IPv4-only/dual-stack disagreement,
and successful localhost navigation after explicit owner approval.

### Cookie handoff without exposing credentials

```sh
agentbrowser session cookies SESSION --output /private/path/cookies.json
agentbrowser session create --tenant TENANT --no-headless \
  --cookies-file /private/path/cookies.json --cookies-format json
```

Export refuses existing files and creates mode `0600`; omitting `--output` prints
credential values. Prefer canonical JSON exports. Formats are explicit, independent
of filename: Netscape has seven tab-separated columns; DevTools TSV has exactly
twelve in the order shown by `session cookies --help`. Extra trailing columns or
headers are refused. Current source accepts UTC ISO DevTools expiry as well as Unix
seconds and `Session`; older installed builds may differ. Expired entries are
rejected, and `--cookies-skip-unsupported` only omits entire partitioned records.
Keep domain, path, Secure, HttpOnly and SameSite intact. A parser error is not a
reason to strip scope attributes or expose cookies in logs.

### When a command fails

| Symptom | Next check |
| --- | --- |
| LAN `POLICY_DENIED` | `navigate --help`; verify the **server's** authorized CIDR setting and session host rules. |
| No visible local window | `session get SESSION`; inspect launch diagnostics and which host runs the server. |
| Missing page ID after CLI create | `page create SESSION`; MCP creation already returns an initial page. |
| Cookie row/expiry refusal | `session cookies --help`; export a supported fresh format without discarding security attributes. |
| Invalid plan JSON | `describe plan --schema`; steps use `action` and `target: {ref}`, not CLI positional arguments or CSS selectors. |
| Stale refs | Take a fresh snapshot on the same session/page; inspect before acting. |
| Timed-out mutation | Reconcile its operation ID; do not blindly repeat the write. |

## Background service and harness setup

The Homebrew formula installs the service and compiled CLI/MCP binaries together.
Shell-capable harnesses can use the CLI directly; no MCP registration is needed:

```sh
brew services start anvai-labs/tap/agentbrowser
agentbrowser --base-url http://127.0.0.1:5709 --json health
agentbrowser --version
```

Compare both versions: upgrading the installed binary does not restart an older
process. At an explicit session checkpoint, use `brew upgrade anvai-labs/tap/agentbrowser`
and `brew services restart anvai-labs/tap/agentbrowser`, then check health again.
Restarting interrupts service-owned browser sessions; preserve interactive logins.

Suggested project instruction for Codex's `AGENTS.md` or Claude Code's `CLAUDE.md`:

> Use AgentBrowser through its CLI and the existing service at http://127.0.0.1:5709.
> Run `agentbrowser --base-url http://127.0.0.1:5709 --json ...`. Discover only the
> needed command with `agentbrowser describe <command> --schema` and command help.
> Reuse authorized sessions/pages, preserve interactive logins, prefer bulk autofill,
> and inspect verification receipts. Reconcile uncertain mutations by operation ID.
> Do not restart the service or submit applications without applicable authorization.

For optional MCP, register the stable Homebrew adapter path (Apple Silicon):

```sh
codex mcp add agentbrowser \
  --env AGENTBROWSER_BASE_URL=http://127.0.0.1:5709 \
  -- /opt/homebrew/opt/agentbrowser/bin/agentbrowser-mcp

claude mcp add --scope user \
  --env AGENTBROWSER_BASE_URL=http://127.0.0.1:5709 \
  --transport stdio agentbrowser \
  -- /opt/homebrew/opt/agentbrowser/bin/agentbrowser-mcp
```

Update an existing named entry instead of duplicating it, or remove that registration
in its existing scope before adding it again. Start a new harness session and inspect
`/mcp`. On other Homebrew prefixes, substitute the installed adapter path. See the
[Codex MCP configuration](https://developers.openai.com/codex/mcp) and
[Claude Code MCP configuration](https://code.claude.com/docs/en/mcp).

The adapter speaks stdio to the harness and REST to the service. Port 5709 is not
an HTTP MCP endpoint. `AGENTBROWSER_BASE_URL` configures the adapter; the CLI uses
`--base-url`. Both support `AGENTBROWSER_API_KEY` when service authentication is
enabled. Keep credentials out of committed project instructions and configuration.

## Inspect captured session identity and launch facts

```sh
agentbrowser --base-url http://127.0.0.1:5709 session get "$SESSION_ID"
agentbrowser --base-url http://127.0.0.1:5709 --json session get "$SESSION_ID" \
  | jq '{sessionId, engine, diagnostics}'
agentbrowser --base-url http://127.0.0.1:5709 --json session list
```

Create/get/list reuse the server's captured adapter identity and optional diagnostics.
The adapter version and browser runtime version are distinct. `playwright_default`
does not certify browser branding; `registered` confirms init-script registration,
not its effect on every document. Remote CDP launch mode is `unknown` and its context
is newly isolated, not an adopted logged-in profile. Missing diagnostics mean the
adapter supplied no valid snapshot. The CLI performs no local launch detection.
See the [shared contract](spec/design/session-launch-diagnostics.md) for ownership,
privacy and authorization boundaries. No MCP registration is required.

## Discover only the command you need

```sh
agentbrowser describe
agentbrowser describe act
agentbrowser describe act press
agentbrowser describe session create
agentbrowser describe autofill --schema
agentbrowser describe plan --schema
agentbrowser describe outcome --schema
agentbrowser describe application execute --schema
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
schema by default. `describe autofill --schema`, `describe plan --schema`,
`describe outcome --schema`, `describe application execute --schema`, and
`describe test evaluate --schema` include
canonical input and output schemas (plan input is an array, matching its CLI
payload); other commands currently return `schemas: null` with that flag.
Schemas are emitted only on request, with nested constraints intact. Protocol semantic
checks (such as exactly one value/option and the supported regex subset) still apply;
a JSON-schema match alone is not execution authorization or semantic validation.
Unknown paths exit 1, write a diagnostic to stderr and emit no partial JSON to stdout.
Discovery includes static option defaults, never supplied option values or API keys.

## Execute with bounded context and explicit outcomes

### Extraction output budgets (after 1.10.1)

`extract --max-bytes` passes a response budget to the service; ordinary output no
longer silently cuts data after 4,000 characters. Use `--json` for the complete
result envelope, including evidence:

```sh
agentbrowser --json extract "$session_id" "$page_id" --format text --max-bytes 262144
```

The budget counts UTF-8 bytes of the compact JSON envelope after redaction, including
evidence. It does not count pretty-print whitespace or cap records; `records.limit`
still controls record count. Omission uses the server ceiling, default 1 MiB.
An oversized result returns `OUTPUT_TRUNCATED` with no partial output; a request above
the server ceiling returns `INVALID_REQUEST`. Inspect the error's size metadata and
narrow selectors or deliberately increase the budget within the ceiling.

Operators may set `AGENTBROWSER_EXTRACT_MAX_BYTES=2097152` in the server process's
startup environment for a 2 MiB ceiling. Invalid configuration aborts startup.
It is not a per-client environment setting. A running Homebrew service keeps its
existing environment until explicitly restarted at a session checkpoint. See the
[design and limits](spec/design/extraction-output-budget.md); use matching upgraded
CLI/service builds for enforcement, since older servers can ignore `maxBytes`.

### Session and action usage

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

When a service returns an existing operation record, the SDK/CLI validates the complete
bounded replay envelope and requires its operation ID to equal the requested ID. A
malformed or mismatched replay is an uncertain invalid response, never a new outcome.

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
| Offline finalized regression evaluation | CLI `test evaluate`; setup, observations and cleanup stay application-owned |
| Durable workflow recovery | Planned; operation records do not survive a service restart |

## Attach the bytes you reviewed (develop slice)

The existing upload command accepts an optional digest; no MCP tool or separate
file-transfer service is required:

```sh
agentbrowser describe act upload
agentbrowser describe plan --schema
agentbrowser --json --operation-id "$operation_id" act upload \
  "$session_id" "$page_id" /service-host/resume.pdf \
  --sha256 "$reviewed_sha256" --mime-type application/pdf
```

The absolute path is on the **service host**, even when the CLI runs remotely.
With `--sha256`, exactly one regular file of at most 16 MiB is read, checked and
uploaded as the same bytes; symlinks and mismatches refuse. MIME is caller-supplied
metadata (default `application/octet-stream`), not document validation. Without
these flags, legacy multiple-file uploads retain their behavior. Discover a ref
with `observe --include fileInputs` when more than one file input is present.

A page may send a file immediately on attachment; apply the operator's upload
approval policy before disclosing sensitive data. A matching upload digest does
not establish complete-form consent or application acceptance. The current
synthetic draft qualification denies final submit; see the
[bounded design](spec/design/t6-verified-upload-draft.md).

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

For a trusted source configured to require business receipt correlation, include
`"evidenceCorrelationId": "save-profile-42"` inside `verification` in `outcome.json`.
This is the application's receipt operation ID, obtained through that application's
supported contract. It is separate from the CLI `--operation-id`, which identifies
the service invocation. The correlation ID permits 1–128 ASCII letters, digits,
underscores or hyphens and grants no additional access. Do not substitute the service
ID or invent a receipt ID for an application that provides no correlation contract.
A missing ID for a source that requires it, or an ID supplied to a source that does
not support correlation, prevents execution with `unsupported/not_started`. Changing
correlation under an already-used service operation ID conflicts; it cannot replay a
write. No production receipt source is registered by default. AgentBrowser 1.9.0
qualifies application-receipt verification only with a controlled, operator-authorized
G4 fixture; delegated browser modes require an explicit permission policy before
production use.

Follow the shared [modular implementation plan](spec/tasks/README.md). T0 is complete;
T8 owns installed-harness qualification. The existing MCP increment has a
[generated catalog](mcp-tool-catalog.md) and negotiated structured autofill and plan
reports. Outcome remains CLI/SDK/REST only unless measured demand justifies an MCP
projection; other MCP result contracts remain to be qualified.

For cross-version integration and common-helper reuse, use the on-demand
[Claude foundation handoff](agent-handoffs/claude-foundation-reuse.md). It separates
published capabilities, installed binaries and the T3 candidate.

## Evaluate a completed case offline (develop candidate)

```sh
agentbrowser describe test evaluate --schema
agentbrowser test evaluate --help
# evaluation.json is captured by your trusted test coordinator, after cleanup.
umask 077
report_dir="$(mktemp -d)"
evaluation_status=0
agentbrowser --json test evaluate - <evaluation.json >"$report_dir/evaluation.json" || evaluation_status=$?
# Keep the directory private; do not print or upload its full report by default.
exit "$evaluation_status"
```

No service, browser, API key or MCP connection is needed for evaluation. Executing the
underlying UI actions still requires the existing service and authorized coordinator.
Inline JSON and `@file` also work; stdin avoids private payloads in shell arguments.
`--operation-id` has no effect on this offline operation.

The strict input is `{schemaVersion:1, descriptor, invocations, report}`; discover its
full schema only when needed. The entire parsed JSON snapshot must fit the existing
64 KiB verification budget (with depth/node limits), within the CLI reader's 1 MiB
transport cap. The coordinator captures expected requests before dispatch, observes
actual fixture/service/CLI versions independently, and completes owned cleanup before
evaluation. It must not copy expected pins into observed environment fields.

A valid passing case exits 0. A valid failed case exits 1 with a complete JSON report;
invalid input exits 1 with no stdout and a generic stderr diagnostic. Human output is
only the case ID and verdict. The JSON report includes `provenance: "caller_observed"`
and omits invocation requests, but its diagnostic strings/evidence references may still
be sensitive. Preserve the exit status even when collecting a failure artifact.

This checks consistency against supplied expectations. It does not execute a test,
fetch or authenticate evidence, or prove that its caller performed the work. A fabricated
passing bundle is not regression evidence. Setup/finalizer failures in the conventional
runner must fail the whole run even if an earlier case passed. Portable deployment setup,
conventional-runner qualification and JUnit/HTML adapters remain later T3 work.

## Qualified evidence reviews (develop)

The existing `session approval <sessionId> <tokenId>` and `session approval-decide
<sessionId> <tokenId> --decision approve|deny` commands also work for host-created
qualified evidence records when a trusted embedding configures an
`evidenceReviewProvider`. The stock service has no provider and refuses those
records. This is deployment code, not an environment flag or caller-supplied source.
The CLI remains a thin SDK/REST client; MCP is optional.

Text output contains only token ID and status. `--json` includes private action and
witness data: use a private output destination. Each inspection and new decision
reauthorizes the source; revoked generations cannot be restored by regranting access.
Operation-ID replay returns status only, so reread the approval to inspect private
content under current permission. Inspect the stored snapshot before deciding.

Approval records operator credential authority, not proof of a human's presence or
unchanged live content. Public creation, consumption and submission are not exposed
by this slice. A later internal consumption recollects evidence and refuses drift;
atomic app-owned submission and independent acceptance remain separate gates. See the
[public review design](spec/design/t6-public-evidence-review.md) and
[qualification evidence](spec/evidence/t6-public-evidence-review.md).

### Sampled session lifetime

`agentbrowser session get SESSION_ID` displays the server's sampled lease deadlines;
`--json` preserves the optional `lease` object on create/get/list. All four timestamps
(`sampledAt`, `expiresAt`, `lastActivityAt`, `idleExpiresAt`) are Unix epoch milliseconds.
Inspection does not refresh idle activity. TTL expires at its deadline; idle expiry
uses the existing strictly-after boundary. Grants and browser attachment can end sooner.
Older servers or non-active session states may omit the lease: absence means unknown,
not unlimited lifetime. See [R5a design](spec/design/session-lease-visibility.md).

An authenticated `session get` for a recently ended owned session keeps the existing
not-found error and may add bounded close cause, end time and sampled deadlines.
Terminal availability is zero; the original deadlines remain visible to explain an
early close. Live remaining time is derived at its sample, not a countdown.
A revoked delegated token and another tenant receive no terminal facts. Engine or
window intent is not inferred from error text. See the
[R5b1 design](spec/design/session-close-causes.md).

### Replay session event ledgers

`agentbrowser session events SESSION_ID` replays the retained console + request
ledgers oldest-first. Every flag combination prints the same paging envelope —
`nextCursor:` followed by one line per event — and `--json` returns
`{events, nextCursor}` (since 1.15.2 the object-selector SDK form resolves to
that envelope for type-only and limit-only queries too; only the legacy
string/undefined selector returns a bare array).

```bash
agentbrowser session events ses_x --type console.log --limit 50   # newest 50 console lines
agentbrowser session events ses_x --type request.failed           # network failures
agentbrowser session events ses_x --type console.log --since 412  # continue past a cursor
agentbrowser session events ses_x                                  # merged ledger view
```

`--since`/`--limit` require `--type`: cursors are per-ledger entry sequences, so
paging crosses one stream at a time. Ledger content is page-derived and untrusted;
console lines can contain anything the page logged, so never paste raw ledgers
into instructions. Do not dump raw ledgers to hunt for credentials — if a
credential may have been exposed, follow the incident process instead.

### Navigation failure diagnostics

`agentbrowser navigate SESSION PAGE URL --json` preserves successful result JSON.
Blocked or timeout results include `reason` and exit 1; recognized thrown navigation
failures emit an `{ "error": { "code", "message", "retryable", "details" } }` object
on stderr with exit 1. `details` contains the bounded reason and any valid operationId
needed for reconciliation. Read both exit status and the JSON; do not infer a bot wall
or automatically repeat a navigation after an ambiguous timeout. The SDK and REST
keep the corresponding result/error fields, and MCP marks failed navigation `isError`.
See [reason definitions and limits](spec/design/navigation-failure-reasons.md).
