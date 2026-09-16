# T3: deterministic regressions and reports

Status: not started. Repository: agentbrowser. Depends on: T2.
Inputs: core, qa mode, contracts, grounding, quality-ci.

## Reuse and scope

Use shared run/result contracts, testkit fixtures, browser/application ports and
artifact storage. Evaluate a thin integration/export to existing Playwright tests
before creating user-facing scheduling or assertion syntax. Registered predicates
and ordered steps are sufficient for the first slice; no new workflow language.

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

## Completion / stop

Close R04 QA aspects and establish the product's first marketable workflow. Preserve
failure evidence and independent oracle results. Reject automatic assertion rewriting
or green-by-skipping behavior. Unlock T7 audit and T8 full-run qualification.
