# T6 C0: approval ownership and atomic consumption

Base: develop `f12ac89fc17e86ff06222059fcf37acc60af4fb7` (PR #239).
Scope: C0 of the [reviewed-payload design](../design/t6-reviewed-payload-consent.md).
This is local candidate evidence; PR and post-merge results remain delivery gates.
Published 1.9.1 and logged-in services are unchanged.

## Reproduction and repair

The old gate returned its stored token objects, accepted expired tokens in the legacy
burn, and fingerprinted caller objects after checking live token state. Generation
could resume after cleanup with a changed session or after shutdown. Service admission
used a separate validation/burn pair. Concurrent ordinary burns already had a used
check; this change does not claim that every old concurrent call double-dispatched.

C0 returns snapshots and adds atomic bound consumption after bounded input capture.
It rejects expiry at the exact boundary, terminal-state reuse and post-shutdown minting.
The service consumes directly; refusal retains a fresh `APPROVAL_REQUIRED` challenge.
The existing canonical serializer moves to core with a control re-export, removing
the approval owner's duplicate recursive sorter without adding dependencies or an
execution layer. Its existing application-authority behavior remains qualified.

## Failing-first and compatibility evidence

- Initial C0 test file: 15 failures, covering mutable views, expiry, reentrant inputs,
  generation races and the absent atomic-consume method. Those 15 then passed with
  37 existing approval and six resource-budget tests (58 focused cases).
- Service refusal probe: one failure/two passing controls before the service swap.
  The old path dispatched even when the injected authoritative consume refused;
  ordinary click/fill confirmation controls already passed.
- After the swap: all three service cases plus two live-URL cases passed, with zero
  dispatch on refused consumption and one dispatch for ordinary confirmation.
- Shared owner reuse: 14 canonical-JSON and 93 application-authority cases passed.
  Additional shutdown-reentry and canonical key-order cases pin the shared boundary.

The mandatory repository hooks and independent exact-head review must pass before
delivery. Existing real Chromium consent and compiled CLI draft regressions remain
part of the full suite. No new GitHub job or release cycle is needed for C0.

## Limits and next tasks

C0 retains caller confirmation. An executing caller can still echo a pending token;
there is no separate operator grant or complete-payload witness. C1–C3 in the design
remain open. Do not submit live applications based on this repair.

Direct core callers now need bounded finite JSON; undefined/accessor/function inputs
are refused rather than coerced. Proxy traps can execute during inspection, so the
owner checks live state afterward; this is not arbitrary-code isolation. Wall-clock
expiry and in-memory lifetime remain existing limits; T5 owns durable recovery.
