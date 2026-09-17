# T2 outcome-run vertical

Status: active implementation evidence for the seventh T2 slice. This slice exposes a
configurable vertical seam; it does not qualify a production application oracle,
durable TestRun store, new MCP tool, or all of T2.

## Contract and reuse boundary

`POST /v1/sessions/{sessionId}/pages/{pageId}/outcomes` accepts one bounded request:
the existing plan actions plus an exact trusted verifier ID/version and verifier input.
It returns the existing plan report beside the canonical outcome projection. There is
no caller-supplied or returned aggregate `ok`/`pass` field. The request-relative parser
pins action count, verified-fill evidence requirements and verifier identity before
execution, then rejects contradictory reports.

The control package owns one reusable `runVerifiedOutcome` composition helper. It:

1. resolves the verifier and exact evidence-source capability before dispatch;
2. executes the injected existing executor at most once;
3. polls only the registered read-only source within verifier read/time budgets,
   yielding for the trusted interval after each pending result;
4. evaluates the first ready evidence once;
5. settles source and caller cleanup concurrently within a trusted cleanup deadline; and
6. returns availability, execution, verification and cleanup independently.

The helper owns no browser, service session, HTTP route, artifact store or retrying
write path. The API supplies current session/page authority and the existing plan
executor. Evidence adapters receive only session/page/tenant identity and an abort
signal. Request data cannot register code, arbitrary evidence readers or verifier
predicates.

Missing evidence capability is an honest `unsupported/not_started` result with a
value-free synthetic plan report. Unknown verifier identity is rejected before
execution. Once execution fails or becomes unknown, evidence is not read. Authority is
checked before execution and around every read; late or cancelled reads cannot produce
a pass. Every cleanup receives a cancellation signal. A rejection is failed cleanup;
a timeout is unknown cleanup, releases the request, and prevents a passing outcome.
Outcome requests require at least one action because this route attests the UI seam.

## Interface projection

REST is the canonical service boundary. The TypeScript SDK validates the same
request-relative report. CLI `outcome` accepts the existing bounded inline, `@file` or
stdin JSON forms, prints the canonical report, and exits zero only when the shared
`isPassingOutcome` predicate succeeds. `describe outcome --schema` provides offline
discovery from the same protocol schemas.

MCP is intentionally unchanged. Agents can use the CLI with ordinary shell tools or
call the SDK/HTTP service directly, so the feature does not require an MCP client,
stdio bridge or additional daemon. Controlled sessions still require the existing
operation ID and authority ledger because the plan can mutate state.
The REST 200 schema also documents the existing no-redispatch operation replay
envelope. SDK/CLI callers receive the existing `OPERATION_RECORDED` reconciliation
error for that envelope instead of treating it as a fresh outcome report. The replay
schema is strict and bounded, and its operation ID must equal the requested operation
ID; malformed or misrouted data becomes a private-safe `INVALID_RESPONSE`.

## TDD coverage and limits

Focused tests cover exact source/capability preflight, unknown verifier refusal,
at-most-once execution, no evidence read after failed/unknown execution, bounded
monotonic deadlines, per-read cancellation, authority revocation, malformed source
data, first-ready single evaluation, cleanup settlement, request mutation, private
field rejection, REST projection, SDK validation, CLI schema discovery and exit codes.

The final local candidate on 1.8.19 passed the full pre-commit gate: workspace
type-check, lint, build and package tests, including 183 protocol, 62 control, 56 SDK,
106 CLI and 566 API tests (two API tests skipped by their declared environment gates).
Focused replay validation subsequently passed all 42 SDK client tests. Independent
adversarial review found and then verified fixes for cleanup cancellation, poll yielding,
empty UI plans, strict/private replay parsing and request/replay operation-ID binding.

This seam reports `testedSeam: ui` because it executes the browser plan. A future
application-mode adapter must retain its own seam and durable receipt identity rather
than relabel this report. T2 remains open until at least one production evidence source
is qualified and the remaining authority/recovery acceptance matrix passes.

## Delivery record

- Repository: `agentbrowser`
- Base: released 1.8.19 develop commit `b4360b93276146123076f776f7a7592bc4bf1740`
- Status: active PR candidate; not yet merged or released
- Reused owners: protocol parsers, plan executor, session authority, SDK request boundary,
  CLI command registry and API composition root
- New dependencies and services: none
- MCP changes: none
- Remaining limit: no production evidence source is registered by default
