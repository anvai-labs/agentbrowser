# T3 native Node/JUnit qualification

Status: implemented and locally tested; final delivery identities belong to the PR. Base: develop `ba31a09` (PR #225).
Design: [native report qualification](../design/t3-node-test-qualification.md).

## What this slice proves

The existing 13-case packaged CLI/UI coordinator remains the execution and lifecycle
owner. After it settles, three fresh canonical result projections enter native Node
tests. The `pass` case passes; `ignored` and `cleanup-failure` deliberately fail.
The outer acceptance check validates their exact identities and native failure output.
This is an intentional reporter fault control, not an ordinary green CI suite.
Package metadata retains only native XML size/digest; raw XML stays private and is discarded.

No private request, receipt, credential or diagnostic enters the report subprocess.
The full canonical cleanup-failure report retains its evidence separately. There is
no saved-report importer, new pass predicate, second browser matrix, dependency or CI job.

## Qualification record

Failing-first: Node 22 ran the three initial focused tests before the adapter existed.
All three failed with `ERR_MODULE_NOT_FOUND`; the command exited 1. This records the
missing implementation, not an expected-negative fixture passing as a customer test.

Node v22.23.2 focused acceptance tests pass: 22/22, including four new reporter
controls. Existing package-server/release-smoke tests pass 32/32; selective context
loader tests pass 10/10. The actual native Node/JUnit subprocess is exercised locally.

Controls reject missing output, renamed or extra cases, skips/cancellations, changed
counts and swapped failure identities with unchanged totals. Private configuration is
0600 inside a 0700 directory; missing sidecar and injected subprocess failures remove
transport files and return generic errors without sentinel values or cause chains.
The report subprocess receives only fixed names and booleans; raw native XML is never
included in returned metadata. Existing environment-isolation and lifecycle-failure
tests remain in the same owner suite.

The final commit-stamped extracted-package run, exact-head adversarial verdict and
PR/post-merge CI identities are recorded in the PR delivery record. They are not
inferred from these helper tests or from the unchanged package version. This avoids
another documentation-only commit and CI cycle merely to stamp its own commit hash.

## Limits and next step

This is internal report projection in the same trusted evaluation flow. It does not
qualify framework-owned live execution or portable deployment. A reusable conventional
runner recipe against an application-owned configured service remains next, followed
by artifact-link conventions, any justified HTML adapter and local impact selection.
T3 stays active; T7 and T3-dependent T8 qualification gates stay closed. Published v1.9.0 does not include
`test evaluate`; no release or main promotion is part of this qualification.
