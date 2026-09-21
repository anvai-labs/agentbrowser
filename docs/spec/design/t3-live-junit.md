# T3: native JUnit for the application-owned live recipe

Status: merged through PR #230 at develop `9b80675`, after private report links (#229).
Later [T3 completion](../evidence/t3-standalone-qualification.md) records the current
delivery status; qualification statements below retain slice scope.
See [local qualification](../evidence/t3-live-junit.md).
Load only for this reporting slice. At its delivery, T3 remained active.

## Gap and decision

The internal native JUnit probes (#226) project three already-finalized results. The
application-owned recipe (#227) executes real setup, CLI actions, oracle checks and
cleanup, but its package qualification uses Node's default reporter. Qualify native
JUnit on those same three existing live invocations, retaining their process owner and
lifetimes. No extra browser case, host start, job, dependency, renderer or public CLI
surface is justified. The standalone recipe continues to support its default reporter;
Node's built-in `--test-reporter=junit` is the application owner's opt-in.

## Shared ownership

Extract the narrow Node/JUnit structure checker and XML byte-summary code from the
existing internal probe wrapper into one dependency-free script helper. Both probe
qualification and live recipe qualification use it. Inputs are fixed trusted test
names, expected pass/fail pattern and a fixed error message; this is not a general XML
parser, third-party report importer or canonical verdict evaluator. Keep the original
probe sidecar/version checks in their owner.

The live wrapper chooses native JUnit before the fixed recipe entrypoint, preserves
bounded output and async child drain, and validates one expected case per invocation.
The canonical evaluation, independently observed application oracle and closed session
remain required. Native exit, case identity, failure type/message, exact summary counts
and the report-digest diagnostic must all agree. A hook/setup failure, arbitrary exit 1,
missing or additional testcase, skip, cancellation, unexpected green or wrong report
digest fails qualification. Cleanup-failure remains failed even after fallback succeeds.

The digest is a link to private caller-observed evaluation bytes, not authentication or
freshness. JUnit can include runner paths/host metadata; capture and validate it privately.
Retain only counts, runtime, purpose and XML size/SHA-256 in package metadata, discarding
raw XML. Do not publish deliberately red controls as the ordinary CI success report.
An application owner may redirect native JUnit to their own restricted artifact store;
that output is private and still needs the process exit plus canonical/oracle checks.

## TDD and validation

1. Add failing controls for the absent shared checker, then move the existing checks.
   Existing three-probe controls must retain exact behavior and counts.
2. Reject wrong case names, absent/extra/malformed failures, errors/skips/cancellations,
   unexpected pass/fail, missing/truncated output, oversized output and mismatched digest
   comments. A digest string in unrelated failure text is not the expected diagnostic.
3. Exercise actual native Node JUnit for one pass and one deliberate failure locally on
   Node 24 and the retained Node 22 floor. Validate only the structure needed for fixed
   fixtures; don't implement a general XML grammar.
4. Run the same existing three live cases through compiled CLI + clean package. Preserve
   the 13-case matrix, separate native projection probes, oracle/receipt identities,
   artifact byte links and finalizers. Keep red controls explicit in summaries.
5. Normal hooks, exact-head adversarial review, existing CI, verified develop merge and
   post-merge CI; no automatic version bump or release.

## Remaining scope

This closes a bounded live-reporting qualification gap, not arbitrary deployment setup
or all T3 acceptance. Document focused local test recipes and measure their usefulness
before introducing an impact selector. HTML/public report APIs still require a concrete
consumer. T5, production evidence, T7 and installed T8 qualification retain their gates.
