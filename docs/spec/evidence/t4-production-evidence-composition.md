# P0 trusted review-provider composition

Scope: P0a/P0b from the [approved design](../design/t4-production-evidence-composition.md)
in #258, based on develop `54daeaa`. Merged #259 at `836cc65`; published 1.9.1 and installed sessions are unchanged.

## Shared owner and contract

`evidenceReviewProvider(request, context)` now receives a frozen context containing
only the existing `PreparedNativeFormRead` captured before provider resolution.
It performs no eager native capture and adds no authority, registry, executor,
transport, runtime dependency or CI job. Existing single-argument providers still
compile and run. The API package's existing service re-export exposes the context type.

The handle remains usable by the returned source collector in the same admission.
Every review phase gets a fresh handle. Escaped handles fail even inside a new
admission; the native reader retains its page/session/incarnation guards, signal
propagation and tracked drain. Document equivalence and application binding remain
owned by the witness and composition guards. Permission is still checked by the
existing source owner, including after host callbacks.

## Regression evidence

New context and drain regressions failed before implementation (four failures,
including the updated provider-argument assertion). The minimal service change then
passed the focused review/native-reader suites (86 tests), followed by all 43
consent tests with four additional capture-time falsifiers. API build/type-check pass. Further adversarial regressions
cover a refused rebinding attempt (`SESSION_BUSY`), page removal and permission
revocation during native capture, plus a throwing capture after page removal, with
no token allocation or application dispatch. The binding case proves configuration
is excluded during the active admission; it does not mutate a binding. The escaped
handle is tested first in a later admission so an earlier refusal cannot mask that
boundary by latching revocation. Collection and early provider-selection reads both
block a new writer until drain, including cancellation and takeover.

The existing real Chromium qualification is rewired through trusted `buildServer`
options and the provider context, using public session/application/review surfaces.
Public CLI create/inspect/approve/execute retains independent receipt verification,
exact replay, visible/hidden/file drift refusal and unknown-return reconciliation.
All 15 real Chromium tests passed. The five public submit/unknown/drift cases use
public setup and ledger reads; the fixture retains private access only for its separate
internal-owner tests. No service prototype capture is needed for the public workflow.
All 82 context selections, 696 relative documentation links and 11 loader tests pass.
Synthetic adapters remain
test-only and are not registered by stock startup.

## Remaining gates

P0c needs an actual application owner/interface; no fake production adapter is
created from the synthetic fixture. P1 needs authorized live witness and receipt
qualification. E0 eligibility is implemented in a separate application-owned candidate.
T4/T6 stay active at their conservative estimates; finite milestones remain 3/9.


Delivery: reviewed head `f411a59`, tree `57b9c54`, merge `836cc65` with identical tree.
Exact-head independent SHIP review; both normal hooks passed 3,336 tests with 24 skips.
PR run `35717475065` and post-merge run `35718143796` each passed all eight checks
without reruns. No release or running-session change was made by this checkpoint.
