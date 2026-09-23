# Foundation repairs after coverage expansion

Base: develop `803f078` (PR #250), retaining C3a from #249. This bounded maintenance
slice closes concrete source defects found by the expanded tests before the
[mandatory submission-consent slice](../design/t6-atomic-submission.md#c3b-mandatory-consent-at-the-shared-dispatch-boundary-design-gate).
No new executor, runtime dependency, transport, workflow or CI job is needed.

## Contracts and existing owners

| Owner | Defect | Required behavior |
| --- | --- | --- |
| Protocol `validateWireActionBatch` | Non-object inputs throw instead of returning validation issues | Reject null, scalars and arrays before inspecting envelope keys; retain per-step validation |
| API `runAutofill` | Shadowed result variables discard action IDs | Successful field receipts use the final action result; a setup action ID must not stand in for a missing final ID |
| CLI download commands | Commander stores inherited `--out` on the parent | Both supported option positions save exact collected bytes through existing `saveArtifactBytes` |
| MCP message handler | JSON null throws before error handling; other scalars vanish | Invalid message roots return static JSON-RPC invalid-request errors; malformed JSON and valid notifications retain their contracts |
| Core `SessionCoordinator` | Context lifecycle changes leave metadata stale | A shared transition helper updates context and metadata together for activity, close and termination |

An autofill action ID is correlation evidence, not proof of business acceptance.
Widget verification still requires observed committed state, and submission consent
remains unavailable until C3b/C3c are qualified. The batch validator is a structural
JSON boundary, not a sandbox for arbitrary in-process objects with executable traps.

## Qualification and delivery

Failing-first checks reproduced eight invalid batch-envelope cases and two missing
receipt-ID cases. After the fixes, protocol wire-action tests passed 71/71 and autofill
unit/edge tests passed 79/79, including the no-final-ID case. The CLI, MCP and core
regressions first failed 3, 6 and 7 cases respectively. After the fixes, CLI suites
passed 159/159, MCP suites 95/95 and coordinator tests 55/55. These cover inherited
file output and missing artifact bytes, invalid MCP roots without dispatch and
recovery on the next ping, and lifecycle metadata consistency through close failures
and expiry. Scoped type checks, spec-context validation and documentation links pass.

Required delivery: existing hooks, independent review of the complete candidate,
one normal PR to develop, green PR and post-merge checks, and explicit merge-state
verification. Record immutable commit/CI evidence in the PR after delivery; do not
infer a release or installed-service restart from a develop merge. Main remains 1.9.1.
