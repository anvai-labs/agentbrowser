# T3: deterministic regressions and reports

Status: active; bound reports, navigation reset, offline CLI evaluation, native JUnit
qualification and the fixed application-owned recipe are implemented. Repository:
agentbrowser. Depends on: T2.
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
contract to existing packaged CLI/application acceptance. It added no public CLI
command, endpoint, SDK or MCP projection, dependency or CI job. At least one assertion
must be required, so an all-optional or all-skipped case cannot pass.

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

This foundation did not complete T3. Later merged slices now expose offline evaluation
and one fixed external recipe, while general integration and later slices remain.

## Offline binary integration

PR #225 merged the [offline CLI evaluation design](../design/t3-cli-evaluation.md)
through `test evaluate` at develop `ba31a09`. It projects the existing bound contract
through the compiled binary while conventional tests retain setup, fixture observation
and cleanup ownership. All 13 cases retain their expected verdicts after outer cleanup.
See [qualification and limits](../evidence/t3-cli-evaluation.md). This adds no
service/fixture registry and is not published in 1.9.0.

PR #226 merged [native Node/JUnit reporting](../design/t3-node-test-qualification.md)
at develop `0762554` from fresh, finalized results without repeating the browser
matrix. Its deliberately failing probes preserve broken-flow and cleanup-failure
verdicts. This is internal report qualification, not a public exporter. See
[tests and delivery boundaries](../evidence/t3-node-test-qualification.md).

PR #227 merged an [application-owned Node recipe](../design/t3-application-recipe.md)
at develop `b5484df`. It uses the installed CLI against a preconfigured counter
deployment and shares assertion, descriptor and credential-isolation helpers with
existing acceptance. Three live controls qualify a commit, ignored action and failed
primary cleanup in the same composed host; the existing 13-case counts remain distinct.
See the [usage example](../../../examples/node-test/README.md). It does not provision
arbitrary applications. PR #228 then merged the Node 24 qualification baseline at
develop `a437c48` while retaining Node 22 as the published minimum.

The current candidate adds the
[example-local private report-link convention](../design/t3-report-artifacts.md): a
bounded evaluation file plus sibling digest manifest after recipe lifecycle settlement.
It introduces no public CLI/protocol artifact API, HTML renderer, dependency, runner or
CI job. General artifact APIs, any justified HTML adapter and impact selection remain.
T3 is not complete; portable setup and installed harness qualification are not implied.

## Completion / stop

Close R04 QA aspects and establish the product's first marketable workflow. Preserve
failure evidence and independent oracle results. Reject automatic assertion rewriting
or green-by-skipping behavior. Only completed T3 may unlock T7 audit and T8 full-run
qualification; this first foundation does not.
