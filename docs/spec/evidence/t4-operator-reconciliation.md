# U1 operator reconciliation

Candidate based on develop `5421d07` (#261); see the
[design](../design/t4-operator-reconciliation.md). One panel observation helper is
extracted from the existing refresh flow and reused by lookup pre/post checks.
The existing api/handle generation guards and protocol operation-ID pattern remain
shared. No backend endpoint, authority owner, execution/retry path, dependency,
CI job or default harness payload is added.

## Failing-first and browser evidence

The first reconciliation test failed on the missing Operation ID input before
implementation. The existing U0 real-Chromium fixture is extended rather than
forked. Ten added cases cover completed/unknown ledger status plus present receipt,
missing/null/denied distinctions, ID format and length boundaries, text-safe receipt
rendering, stale successes/errors across ID and credential changes, preservation of
newer pending actions, active-ID keyboard selection and busy status reads, external
unbind during lookup, revoked discovery, and mutation-input exclusion.

The fixture instruments its existing draft update operation to retain the independently
observable effect and a test-owner receipt before optionally throwing away the result.
That exercises actual server outcome_unknown and receipt lookup; it is not a production
receipt contract. Read-only browser tests count zero non-GET requests. The operator
document runs in real Chromium while its service browser port is FakeEngine. Injected
403/display controls are explicitly test projections. Existing real-page coexistence
and application HTTP/race tests continue to qualify their own underlying boundaries.

The final panel suite passes all 18 cases (8 U0 plus 10 U1). Before the final
late-error addition, the combined operator/coexistence/application/race selection
passed 35 cases with 2 conditional Victor skips. TypeScript, Biome, all 82 spec
context selections, 11 loader tests and 724 relative documentation links pass.
Normal hooks and exact-head CI complete the delivery gate.

## Limits

Control/discovery bracketing is a best-effort observation, not an atomic binding lease.
A same-identity rebind or permission change between reads is not proven absent.
Ledger and receipt results are explicitly separate; no automatic verifier upgrades
an unknown outcome or claims correlation with an operation's original binding.
Results disappear on observed context changes; reads do not undo or replay writes.
Production application/evidence qualification (P0c/P1), T6 private/live integration
(E0c/E1) and durable recovery (T5) remain open. Release 1.9.1 is unchanged.
