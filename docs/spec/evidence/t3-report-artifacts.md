# T3 private report artifact qualification

Status: implemented candidate based on develop `a437c48` (Node 24 baseline, PR #228).
Design: [private report links](../design/t3-report-artifacts.md).
Usage: [application-owned Node recipe](../../../examples/node-test/README.md).

## Scope

The example's canonical evaluation stays at the existing private report path. A sibling
manifest binds its exact bytes through SHA-256, size, media type and relative filename;
native Node diagnostics contain only the report digest. The separately observed oracle
match stays explicit. The existing CLI evaluator and independent application assertions
retain truth ownership. This example-local convention adds no public API, command,
protocol schema, dependency, browser case or CI job.

The common helper is consumed by the recipe and its package qualification. Its bounded
private reader also replaces the recipe configuration reader and the acceptance
wrapper's duplicate report reader. No report parser or verdict algorithm is duplicated.

## Failing-first checks and review findings

Three initial artifact tests failed because the helper did not exist. They exercise
exact report bytes, an independent oracle mismatch, metadata/byte corruption, existing
output preservation, private permissions, file/size bounds and symlink refusal.
Additional controls cross the real report-created abort boundary, reject object inputs
that serialize to a primitive or undefined, and preserve failed canonical reports.

Adversarial review found two issues before publication: a failed unlink could skip
remaining output cleanup or fixture closure and expose a private path; unusual JSON
serialization could publish a manifest for an unreadable report. Shared all-settled
cleanup, a nested fixture finalizer and validation of the serialized root close those
paths. A deterministic directory collision verifies fixture closure after artifact
cleanup failure. Error tests require path-free messages without a leaked cause.

Locally, the combined package/helper/context selection passes 58 tests on Node 24.21.0.
The 17 recipe/lifecycle tests also pass on Node 22.23.2. Workspace build, spec-context
budgets and relative documentation links pass. The source re-review is clean.

## Delivery gate and limits

Before merge, run normal hooks and the clean extracted-server acceptance with compiled
clients. Its existing three fresh recipe cases must retain Node exits 0/1/1, exact
canonical results, independent oracle checks, closed sessions and matching digest
links. The 13-case matrix and deliberately red native JUnit controls stay distinct.
Record final commit/tree, package identity, exact-head review and PR/post-merge CI in
the PR delivery record; a local candidate is not a release.

The pair is private caller-observed diagnostics. Its hash detects mismatched bytes,
not replacement of both files, freshness, authorization, source identity or oracle
truth. The parent directory is trusted and exclusively owned. Incomplete outputs after
hard termination require external cleanup; no T5 recovery claim is made. HTML and
remote artifact publication remain deferred. Impact selection and broader deployment
qualification remain open; T3, T7 and T8 completion are not implied. Main and published
1.9.0 are unchanged.
