# T3: deterministic regressions and reports

Status: active; bound-report, navigation reset and offline CLI evaluation implemented. Repository: agentbrowser. Depends on: T2.
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

The foundation merged through PR #212 and adds one protocol-owned bound TestCase
contract to existing packaged CLI/application acceptance. It adds no public CLI command, endpoint, SDK or
MCP projection, dependency or CI job. At least one assertion must be required, so an
all-optional or all-skipped case cannot pass.

The original controlled matrix had 12 cases: two fixed runs produce distinct application
events; lost response passes once; historical, ignored, failed action, stale application state,
wrong resource and API shortcut cannot satisfy the UI assertion; required skip,
partial setup and cleanup failure stay non-passing. Ten assertions and ten exact-ID
replays used the compiled CLI, two calls used offline discovery, and no model or MCP
call participated. Reports were 340–923 bytes. See the
[local qualification record](../evidence/t3-bound-regression-report.md).

The original extracted-package candidate passed all eight groups under Node v22.23.2;
37 helper tests and 206 protocol tests passed. PR run `35459535641` and merge run
`35459717523` then passed all eight required checks at develop commit `4dd96e9`.
Adversarial review `133085aa` was clean.

PR #214 delivered the thirteenth `navigation-reset` case at develop `9e36292`. The QA CLI navigates
the same page from the earlier `pass` fixture to a fresh target, snapshots bounded
current state, rejects the old ref with `STALE_TARGET`, then passes and replays the
fresh bound outcome. See the
[navigation-reset evidence](../evidence/t3-navigation-reset.md). All eight candidate
package acceptance groups passed on Node 22.23.2. PR run `35461246329` and merge
run `35461465463` each passed all eight checks. The handback recheck at `4601e77`
also passed all eight groups with the complete 13-case matrix.

This is still an internal foundation, not T3 completion. A reusable product-facing
integration/export, report adapters and the later slices below remain pending.

## Offline binary integration

The [offline CLI evaluation design](../design/t3-cli-evaluation.md) is implemented
through `test evaluate`. It projects the existing bound contract through the compiled
binary while conventional tests retain setup, fixture observation and cleanup ownership.
All 13 cases retain their expected verdicts after outer cleanup; candidate gates require
the command/schema. See [qualification and limits](../evidence/t3-cli-evaluation.md).
This adds no service/fixture registry and is not published in 1.9.0.

Next is conventional-runner/report qualification against a preconfigured deployment,
then report adapters and impact selection. T3 is not complete; portable end-to-end
fixture setup and installed harness qualification are not implied.

## Completion / stop

Close R04 QA aspects and establish the product's first marketable workflow. Preserve
failure evidence and independent oracle results. Reject automatic assertion rewriting
or green-by-skipping behavior. Only completed T3 may unlock T7 audit and T8 full-run
qualification; this first foundation does not.
