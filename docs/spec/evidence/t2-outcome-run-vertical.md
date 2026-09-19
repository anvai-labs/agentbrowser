# T2 outcome-run vertical

Status: active implementation evidence for the seventh T2 slice. This slice exposes a
configurable vertical seam; it does not qualify a production application oracle,
durable TestRun store, new MCP tool, or all of T2.

## Contract and reuse boundary

`POST /v1/sessions/{sessionId}/pages/{pageId}/outcomes` accepts one bounded request:
the existing plan actions plus an exact trusted verifier ID/version and verifier input.
An optional `verification.evidenceCorrelationId` selects a business receipt for a source
that explicitly requires it; it grants no authority and is separate from the service ID.
It returns the existing plan report beside the canonical outcome projection. There is
no caller-supplied or returned aggregate `ok`/`pass` field. The request-relative parser
pins action count, verified-fill evidence requirements and verifier identity before
execution, then rejects contradictory reports.

The control package owns one reusable `runVerifiedOutcome` composition helper. It:

1. resolves the verifier, exact evidence-source capability and correlation compatibility,
   then snapshots and parses verifier input before dispatch;
2. executes the injected existing executor at most once;
3. polls only the registered read-only source within verifier read/time budgets,
   yielding for the trusted interval after each pending result;
4. evaluates the first ready evidence once;
5. settles source and caller cleanup concurrently within a trusted cleanup deadline; and
6. returns availability, execution, verification and cleanup independently.

The helper owns no browser, service session, HTTP route, artifact store or retrying
write path. The API supplies current session/page authority and the existing plan
executor. Evidence adapters receive session/page/tenant identity and an abort signal;
an opted-in source receives the validated correlation ID as a separate argument.
Request data cannot register code, arbitrary evidence readers or verifier
predicates.

Missing evidence capability is an honest `unsupported/not_started` result with a
value-free synthetic plan report. Unknown verifier identity is rejected before
execution. Once execution fails or becomes unknown, evidence is not read. Authority is
checked before execution and around every read; late or cancelled reads cannot produce
a pass. Authority and cancellation are checked again after cleanup before output;
revocation drops execution data and evidence references and preserves uncertainty
about dispatched effects. Every cleanup receives a cancellation signal. A rejection is failed cleanup;
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
than relabel this report. Production-source qualification and independent UI/API parity
remain T4 gates; durable recovery remains T5. The shared foundation closes against the
T2 acceptance matrix, with unsupported levels explicit; see the current
[foundation qualification](t2-foundation-qualification.md).

## Delivery record

- Repository: `agentbrowser`
- Base: released 1.8.19 develop commit `b4360b93276146123076f776f7a7592bc4bf1740`
- Delivery: PR #194 merged to develop as `52b54d7e7da6b15957de251a75d0591c22a15ee8`; not yet promoted to main or released
- Reused owners: protocol parsers, plan executor, session authority, SDK request boundary,
  CLI command registry and API composition root
- New dependencies and services: none
- MCP changes: none
- Remaining limit: no production evidence source is registered by default

## Terminal authority regression follow-up

Three runner regressions first failed because authority loss during asynchronous cleanup,
cancellation during cleanup, or revocation inside verifier evaluation still returned a
passing projection. The final synchronous authority/signal check makes them pass and
retains the existing executor, cancellation, registry and result-schema owners.

Service coverage closes a page during cleanup and verifies that the result is withheld.
Delegated HTTP coverage performs human takeover during cleanup, observes refusal with
no plan/evidence payload, and reconciles `outcome_unknown` with dispatch recorded. The
old grant cannot redispatch. An unavailable execution report now says that effects may
be unknown instead of incorrectly claiming the plan never executed. Independent review
confirmed that `requirePage` already invokes the shared authority check; no duplicate
service guard was added. This closes one terminal boundary, not the full T2 matrix.

## Verifier input preflight follow-up

The shared registry prepares an evidence-only evaluator from bounded, detached input
before the runner invokes its executor. `defineVerifier` parses that input once;
mutating the caller's input during asynchronous execution cannot change the expected
outcome. Direct and prepared verification reuse one evidence/projection helper.

Invalid input produces `blocked/not_started` with unknown verification and no evidence
references. It dispatches no plan, reads no evidence and still settles registered
cleanup. A legacy trusted definition with only `evaluate` remains compatible with
direct registry evaluation, but outcome execution requires `prepare`; otherwise it
reports `unsupported/not_started`. Preparation errors never expose parser details or
input values. Authority and cancellation are rechecked after preparation before dispatch.
Asynchronous parser/preparation results are rejected before execution; promise and
thenable rejections are consumed without exposing their errors. Asynchronous evidence
parsers or predicates yield unknown verification rather than an accidental pass.

Five runner regressions and a service regression first reproduced the missing preflight.
Adversarial review identified asynchronous input parsing as another dispatch bypass;
three additional regressions reproduced it before the synchronous-result guard was added.
Coverage also exercises bounded/accessor/cyclic input, callback capture, prepared
evidence validation and delegated HTTP replay recording `failed/dispatched: false`.
No protocol schema, public CLI command, dependency or second execution path is added.
Production evidence-source qualification remains open.

## Business receipt correlation follow-up

The request's optional `verification.evidenceCorrelationId` uses the same bounded
operation-ID schema as the operation ledger: 1–128 ASCII letters, digits, underscores
or hyphens. The business ID is not inferred from `X-AgentBrowser-Operation-Id`.
It is not a URL, resource binding, tenant, credential or session incarnation.

Trusted source descriptors opt in with `correlation: 'required'`. Missing correlation
for such a source, or supplied correlation for an uncorrelated source, returns
`unsupported/not_started` before plan execution or evidence I/O. Malformed request IDs
fail canonical input validation; malformed programmatic IDs block the runner. Registered
cleanup still settles. Existing uncorrelated requests/sources retain their behavior.

`TrustedEvidenceSourceRegistry.prepareRead` validates once and captures the stored reader,
context and primitive business ID. All polls use that prepared reader; direct registry
reads delegate to the same preparation logic. The service forwards only the canonical
request field. SDK and CLI need no separate implementation, and their offline schema
and OpenAPI projections expose the same optional field. Reports do not add correlation
or raw receipt data; adapters remain responsible for safe evidence references.

Protocol and runner tests first exposed rejection of a valid correlated request and
silent ignoring of correlation by an uncorrelated source. Tests cover bounded/malformed
IDs, immutable callback/descriptor capture, caller mutation during execution, every poll
using the same ID, and no dispatch/read on correlation mismatch. Operator-authorized REST fixtures
bind and seed receipts through the public application API added in v1.8.20, then use
the service-owned `ApplicationAuthority.readReceiptInScope` inside the admitted outcome
with distinct outer/business IDs. Missing and cross-session receipts cannot pass; replay performs no
second plan/read, and changed correlation with the same outer ID conflicts.

The fixture receipt is pre-created and its boolean predicate is fixture-specific. This
proves correlation, admission and session isolation, not that the UI caused an application
commit. No default production source, new binding endpoint, receipt store, workflow engine,
MCP tool or dependency is added. This correlation-only slice left causal qualification
open; the follow-up [installed CLI matrix](t2-cli-application-outcome.md) supplies controlled
G4 negative controls. Production-source acceptance remains a separate T4 limit.

Application receipt verification by delegated browser modes remains a separate permission
boundary. Browser grants intentionally cannot use the application API. The fixture uses
operator authorization; production evidence context remains data-only. A production
receipt source must enforce an explicit permission/declassification policy during
preflight, before any delegated UI dispatch. `correlation: 'required'` validates an ID;
it grants no application capability and does not establish that policy. Raw receipt
access and permission to expose a verified predicate must be reviewed separately.
