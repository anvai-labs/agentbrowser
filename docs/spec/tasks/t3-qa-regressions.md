# T3: deterministic regressions and reports

Status: complete on develop; bound reports, navigation reset, offline CLI evaluation, native
JUnit projection, the fixed application-owned recipe, private report links and live
recipe JUnit qualification, standalone-copy and measured-cost closure are delivered
through PR #231. See the [completion evidence](../evidence/t3-standalone-qualification.md).
Published 1.9.0 predates these T3 increments. Repository: agentbrowser. Depends on: T2.
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
3. At least one qualified conventional report plus failure-linked private evidence,
   reusing common renderers. JUnit is delivered; add HTML only for a concrete consumer.
4. Measure an explicit local focused loop against the full gate and fail to full when
   impact is uncertain. Any automatic CI selector or gate change belongs to T9.

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

PR #229 merged the
[example-local private report-link convention](../design/t3-report-artifacts.md) at
develop `7c452b1`: a
bounded evaluation file plus sibling digest manifest after recipe lifecycle settlement.
It introduces no public CLI/protocol artifact API, HTML renderer, dependency, runner or
CI job. PR #230 then merged [live JUnit qualification](../design/t3-live-junit.md) at
develop `9b80675`. It runs the same three recipe invocations under Node's native reporter
with case-bound names and the same process owner. The original three finalized-result
probes remain a separate qualification; neither slice repeats the browser matrix.

PR #231 stages the documented `application-outcome.mjs` and
`report-artifacts.mjs` pair in a private temporary directory and runs those same three
cases from an unrelated working directory. It preserves the 0/1/1 Node exits,
canonical evaluations, independent oracles, session/fixture cleanup and digest-linked
JUnit results. This tests the two-file, builtins-only distribution seam against the
existing preconfigured service. It does not provide general application provisioning,
a plugin loader or a public runner.

The delivered qualification also records one explicitly scoped local sample: live-recipe elapsed
time and maximum config, evaluation, manifest and JUnit bytes. Its CLI/version/discovery,
outcome, evaluation and Node-test counts come from the fixed qualified call paths and
validated result cardinality; they are not operating-system process telemetry and
exclude browser descendants and executable internals. Zero model/MCP calls applies to
this regression matrix, not the full package gate. Node 24.21.0 remains the default
qualification baseline and Node 22 the supported compatibility floor. Final focused
checks pass 62 tests on Node 24.21.0 and 43 on Node 22.23.2; the clean extracted package
passes eight acceptance groups on Node 24.21.0. PR and post-merge CI each pass eight
checks. Exact identities and measurement scope are in the completion evidence.

General artifact APIs, any justified HTML adapter and automatic impact selection remain.
A single sample establishes scope and a baseline; it cannot support percentiles or a
speedup claim. Independent review and verified delivery close the bounded T3 task;
portable service setup and a general installed harness are not implied.

## Focused local loop

Use the narrow checks while changing this slice:

```sh
node --test scripts/application-recipe.test.mjs scripts/application-recipe-lifecycle.test.mjs
node --test --test-name-pattern='application recipe|native JUnit|shared native JUnit' scripts/package-acceptance.test.mjs
node scripts/check-doc-links.mjs
node --test scripts/spec-context.test.mjs
```

The name filter is an explicit local selection, not evidence that unselected tests are
unaffected. Run full package acceptance when the changed ownership or dependency reach
is unknown, and keep normal hooks and required CI authoritative. The closure packet
records one scoped focused/full baseline; it does not justify an automatic selector.
Any future CI filtering must stay always-reporting and is owned by T9. HTML remains
conditional on a concrete consumer that justifies its security and rendering ownership.

## Completion / stop

Close R04 QA aspects and establish the first qualified application-owned regression
workflow seam. Preserve failure evidence and independent oracle results. Reject
automatic assertion rewriting or green-by-skipping behavior. Product-market validation
and willingness to pay remain separate from technical qualification. Only completed T3
unlocks T7 audit context. T4 still gates application-security work; T8 profile/full-run
qualification also requires T1. These gates do not authorize testing external targets.
