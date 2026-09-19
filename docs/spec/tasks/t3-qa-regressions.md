# T3: deterministic regressions and reports

Status: active; first internal foundation under qualification. Repository: agentbrowser. Depends on: T2.
Inputs: core, qa mode, contracts, grounding, quality-ci.

## Reuse and scope

Use shared run/result contracts, testkit fixtures, browser/application ports and
artifact storage. Evaluate a thin integration/export to existing Playwright tests
before creating user-facing scheduling or assertion syntax. Registered predicates
and ordered steps are sufficient for the first slice; no new workflow language.

The [first-slice design](../design/t3-regression-report.md) limits initial work to a
bound assertion report and one existing-CLI reference case. Lifecycle stays in package
acceptance; public runners, generic callbacks and report adapters remain deferred.

## Slices

1. Fixture-backed TestCase with explicit UI seam, setup, assertions and cleanup.
2. Deterministic replay and reusable test export/integration with no LLM at run time.
3. JUnit/HTML report adapters and failure-linked evidence, reusing common renderers.
4. Local impact selection inside existing jobs; any CI gate change is reviewed with T9.

## TDD and acceptance

An intentionally broken save flow fails even if the UI and model report success.
The fixed flow passes repeatedly; an API-only shortcut cannot pass the UI assertion.
Required skipped assertions fail/invalidate the result. Test baseline drift, fixture
cleanup failure, navigation reset and exact environment/version reporting.

Produce a reusable regression definition, deterministic invocation and report through
an actual delivered surface. Compare agent calls/context size and measured run cost.
Do not add scanner dependencies or cross-browser jobs for unrelated changes.

## Current implementation state

The candidate adds one protocol-owned bound TestCase contract and extends existing
packaged CLI/application acceptance. It adds no public CLI command, endpoint, SDK or
MCP projection, dependency or CI job. At least one assertion must be required, so an
all-optional or all-skipped case cannot pass.

The local controlled matrix has 12 cases: two fixed runs produce distinct application
events; lost response passes once; historical, ignored, failed action, stale application state,
wrong resource and API shortcut cannot satisfy the UI assertion; required skip,
partial setup and cleanup failure stay non-passing. Ten assertions and ten exact-ID
replays used the compiled CLI, two calls used offline discovery, and no model or MCP
call participated. Reports were 340–923 bytes. See the
[local qualification record](../evidence/t3-bound-regression-report.md).

The complete extracted-package acceptance passed all eight groups under Node
v22.23.2; 37 helper tests and 206 protocol tests passed. The dirty candidate reported
`releaseEvidence: false`.

This is an internal foundation, not T3 completion. Exact-head/post-commit CI remains
pending, as do a reusable product-facing regression surface, exports/report adapters,
navigation reset and the later slices below.

## Completion / stop

Close R04 QA aspects and establish the product's first marketable workflow. Preserve
failure evidence and independent oracle results. Reject automatic assertion rewriting
or green-by-skipping behavior. Only completed T3 may unlock T7 audit and T8 full-run
qualification; this first foundation does not.
