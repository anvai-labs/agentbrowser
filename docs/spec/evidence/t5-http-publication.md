# T5 A3b application HTTP publication evidence

Base: develop `89c20e6941bcadf99a09db1a79c1ba9f6877383f` (#282).
Status: merged PR #283 (`58e3605`); independent exact-head review clean.
Normal hooks: 3,891 passed, 24 existing skips; PR run `35997301373` and
post-merge run `35997976774` each passed eight checks without reruns.
Reviewed candidate `1a5a94f` and merge retain identical tree `7329d281dd903e36933e6503bc2de3a7dbd249d6`.
Design: [bounded HTTP publication](../design/t5-http-publication.md).

Three real-loopback tests failed before implementation: the session was no longer busy
while output waited, and permission revocation still allowed fresh/replay HTTP bytes.
The implementation reuses authority publication/deadlines, one HTTP transport helper,
Node stream completion and the existing application counter fixture. No new package,
protocol schema, operation record store or executor is added.

The qualification matrix covers completed-but-busy execution, in-flight status and
replay, one business effect, final-hook permission/control revocation, serialization
failure, client abort, the actual 10-second deadline, late-hook refusal, exact replay
shape, null receipt, HEAD/header/error parity and the four-route registration inventory.
Initially, all 115 focused tests across the new 12-case real-HTTP matrix, existing application,
draft transport, route contracts and server suites passed. API type checking, all 82
context selections and documentation link checks passed. The final matrix adds two missing-guard
controls and a failing-first omitted-publication regression: a response callback
that returns without sending now terminates instead of hanging.

Full A3 browser/review adoption and A4b whole-inventory acceptance remain pending.

During review, the initial async final-hook/reply-thenable approach was replaced by
synchronous final guarding and Node's existing `finished()` observer installed before
send. This closes the microtask gap before bytes and distinguishes premature close.
Existing injected receipt tests allow the authority continuation after response finish;
actual HTTP tests independently pin exclusion and conservative terminal facts.

No durable recovery or installed-harness qualification is implied. Published 1.10.1
and the existing live service are unchanged. T5 remains approximately 10%; exactly
3/9 finite milestones are complete.

The first full commit gate exposed seven more injected setup races in outcome and
provider fixtures: a page creation immediately followed an application seed response.
Both fixtures now use Node's existing immediate promise after the seed to allow final
release. No assertion or production exclusion was weakened; the four relevant suites
passed all 53 tests after the repair, including the full 15-case transport matrix.

The next full gate hit an unchanged Chromium draft-parity test's one-second readiness
poll under heavy host load. Its unmodified isolated suite passed 2/2. Subsequent local
hook runs cap Vitest worker concurrency (two forks/threads, minimum one), retaining
all tests, assertions, deadlines and required hooks; no CI configuration is changed.
