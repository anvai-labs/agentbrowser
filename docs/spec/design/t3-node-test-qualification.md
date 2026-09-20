# T3: native Node/JUnit report qualification

Status: merged by PR #226 at develop `0762554`.
See [local qualification](../evidence/t3-node-test-qualification.md).
Load only for this report slice; [T3](../tasks/t3-qa-regressions.md) remains active.

## Decision and scope

Qualify Node 22's native JUnit reporter using fresh, finalized results from the
existing packaged CLI/UI matrix. Preserve the fixture coordinator as the single
owner of setup, assertions, independent application-oracle checks and cleanup.
Execute the browser matrix once, then run a small isolated Node test probe subprocess
that projects three fixed results. It owns no service or browser descendants.

Moving the live coordinator into this subprocess was rejected for this slice: the
existing subprocess helper kills its direct child on timeout, not an entire browser
process tree. Adding another lifetime boundary needs separate cancellation design.
No new runner framework or process-tree supervisor is justified just to emit JUnit.

This qualifies repository-internal report projection only. PR #227 later delivered a
fixed application-owned live recipe, and PR #229 linked its private reports to digest
diagnostics. The [current live-JUnit candidate](t3-live-junit.md) applies Node's native
reporter to those same three live processes while retaining their existing owner. The
projection probes in this document remain separate and still run only after the browser
matrix settles. Neither qualification proves portable external deployment or the whole
integration step in the [CLI evaluation design](t3-cli-evaluation.md). The fixture child
still imports private packaged modules to configure adapters and verifiers. Public
`test run`, plugins, scheduling, HTML rendering and npm publication remain deferred.

## Truth and reporting

The existing coordinator executes all 13 cases through the compiled CLI, checks the
independent oracle, settles resources and evaluates original bundles through `test
evaluate`. Only after it resolves may the report adapter receive the fresh results.
The adapter has no public saved-report input. It is part of that trusted evaluation
flow, not an importer that certifies an arbitrary serialized verdict as fresh evidence.

Send only three fixed names and their boolean pass projections to the Node subprocess:

| Fixture case | Native runner result | Purpose |
| --- | --- | --- |
| `pass` | Pass | A real successful UI action and independent receipt. |
| `ignored` | Fail | UI interaction without the required backend commit. |
| `cleanup-failure` | Fail | A successful assertion cannot override failed cleanup. |

These are deliberate **failure-propagation probes**, not the ordinary qualification
suite's success report. The Node tests assert that each customer case passed; both
negative controls therefore fail normally. Node exits 1 and JUnit records two failures.
Only the outer qualification check recognizes that exact intentional control pattern.
Never upload this red control artifact as if it were the release's ordinary test suite.

The outer check must reject missing/extra cases, wrong failure identities, skips,
cancellations, missing output, hook failures and unexpected exits. A nonzero exit alone
is not evidence that controls worked. The canonical evaluator remains the only owner
of case truth; this check verifies faithful reporting and failure propagation.

Fixture/process finalizer failure prevents report projection. Failure in a later
package-level finalizer prevents the entire package acceptance report from publication.
Fallback cleanup never rewrites the failed case. Its receipt evidence remains in the
canonical private report; the JUnit input contains no requests, receipts or diagnostics.

## Reuse and boundaries

- `cli-outcome-acceptance.mjs` retains all browser actions, oracle checks, environment
  observation, counter assertions, bundle evaluation and cleanup ownership.
- `package-acceptance.mjs` retains deployment auditing and its enclosing finalizers.
- A fixed Node test file asserts the three pass projections; a thin wrapper supplies
  private configuration, invokes Node and checks native report control identities.
- `release-smoke.mjs` retains bounded subprocess lifetime, input/output and exit checks.
- Tests extend the existing package-acceptance test owner and CI job. No new dependency,
  protocol/schema, CLI/MCP operation, reporter implementation or browser job is needed.

Use private temporary directories, exclusive 0600 files and cleanup on every exit.
The report subprocess receives runtime essentials and the explicit configuration path,
not operator credentials or inherited Node injection settings. Test names and failure
messages are fixed and contain no private values. Native JUnit can contain runner paths
and host metadata. Validate it privately, then retain only its byte size and digest
in package acceptance metadata; discard the raw XML. Do not embed it as base64 or
upload these deliberately red controls as the ordinary CI report.

Native JUnit structure is Node-owned and may change. Qualification checks only the
fixed case/failure structure it needs under the recorded runtime. This is not a general
XML parser or an importer for untrusted third-party reports. See
[Node 22 reporting documentation](https://nodejs.org/download/release/v22.23.2/docs/api/test.html#test-reporters).

## Failing-first acceptance

1. Add failing tests for the absent adapter, then implement using existing helpers.
2. Exercise actual Node/JUnit output with deterministic probes: success, broken flow,
   cleanup failure, invalid projection and infrastructure failure. Exact failure
   identities, not just counts, must match. Unexpected green is also a failure.
3. Prove private sentinel data is not passed to or echoed by the reporter, subprocess
   credentials are isolated, and temporary files disappear on all exits.
4. Qualify all 13 existing verdicts through compiled binaries and prove projection
   starts only after lifecycle settlement. No extra browser matrix is added.
5. Run local checks, normal hooks and adversarial review before one ready PR. Merge
   only after existing CI is green; verify merge state and post-merge CI.

## Remaining T3 work

The fixed application-owned recipe and example-local failure links are now delivered.
The live-JUnit candidate qualifies that recipe's three existing cases; it does not turn
this older finalized-result projection into a general runner. Portable deployment setup,
a public execution surface, any justified HTML adapter and measured local impact
selection retain separate design/acceptance gates. This slice does not finish T3 or
unlock T7 or T3-dependent T8 qualification gates. Continue on develop; release promotion
remains a separate checkpoint decision. Published 1.9.0 lacks the offline evaluator.
