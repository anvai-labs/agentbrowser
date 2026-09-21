# T3 live recipe JUnit qualification

Status: merged through PR #230 at develop `9b80675`, based on private report links #229.
This is the historical slice record; see [T3 completion](t3-standalone-qualification.md)
for current qualification, delivery and remaining scope.
Design: [live native JUnit](../design/t3-live-junit.md).
Usage: [application-owned example](../../../examples/node-test/README.md#native-junit-output).

## What changes

The same three application-owned live recipe invocations now use Node's native JUnit
reporter during package qualification. Their case-bound names, exact pass/fail counts,
failure type/message and report-digest diagnostic must agree with the expected control.
The canonical CLI evaluation, independent application oracle and verified session
cleanup remain required. No additional browser case, service host, CI job, dependency,
product command or public schema is introduced.

One shared internal checker replaces the original fixed-probe validation code and is
used by both the original three-result projection and the live recipe. The original
projection sidecar/runtime checks remain in their existing owner. The standalone
example still supports the default Node reporter; JUnit is the owner's native Node
option, not an AgentBrowser reporting engine.

## Local checks

The initial shared-checker test failed before the helper existed. Negative controls
reject renamed/additional cases, hook failure types, wrong failure messages, missing
closing tags, skip/cancel/todo counters, missing/duplicate/wrong digest comments,
digest text hidden in a failure body, and oversized output. Actual Node reporter tests
cover the three fixed names and independently check XML byte hashes. Existing
cancellation tests now exercise the JUnit invocation and require no evaluation or
manifest after the Node/CLI processes drain.

Adversarial review identified an assertion that could echo unexpected stderr. The live
report boundary now catches failures into a fixed message with no cause; a regression
requires private stderr and paths absent from the error/stack. Documentation uses a
fresh private `mktemp` file and captures the process status without a pipeline.

The combined package/helper/context selection passes 61 tests on Node 24.21.0. The
package/recipe/lifecycle selection passes 42 on Node 22.23.2. Workspace build,
documentation links and all 82 context selections pass. The final commit, review,
compiled-client/extracted-package result and PR/post-merge CI belong in the PR delivery
record once completed; no release result is inferred from local tests.

## Limits and next step

This is strict qualification of known locally generated Node output, not a general XML
parser or an importer certifying saved reports. Raw XML may include runner paths and
is discarded after validation; package metadata retains only counts, runtime and
size/SHA-256. The two deliberately red controls remain failed customer tests, never
uploaded as an ordinary green suite. A digest does not prove authenticity or freshness.

Focused local commands are documented in the T3 task. Measure several functional
slices before adding a selector; no runner savings have been established. General
HTML/report APIs require a real consumer, and portable application provisioning,
production evidence and installed harness qualification remain separate. T3 stays
active; main, published 1.9.0 and downstream completion gates are unchanged.
