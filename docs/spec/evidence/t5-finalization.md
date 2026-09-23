# T5 A1: finalization before ticket release

Status: A1 implementation checkpoint; publication and durability remain unimplemented.
Base: develop `fe8b36d` (J1 design PR #268). Design:
[finalization/publication](../design/t5-finalization-publication.md).

## Reused owners and behavior

`SessionControl.finalize(ticket, status)` owns the existing operation-record update.
It freezes the terminal result while keeping the captured ticket busy. Only successful
fresh admission resets the per-ticket finalized flag. Replay, refused admission,
stale/foreign tickets and repeated completion cannot reset it. Dispatch refuses after
finalization, including anonymous tickets. `check` still validates current ownership;
it is not permission to start another effect after finalization.

`finish` remains the compatibility composition: finalize once, then release that
captured ticket. Finalization can record conservative outcomes for revoked/stopped
owners during drain without reviving them. Repeated finalization or a later finish
with a different status cannot overwrite the first terminal result. Existing operation
lookup/replay returns the existing record; there is no parallel lifecycle store.

`SessionAuthority` closes the execution scope and drains J0 work as before, then
explicitly finalizes and finishes the same captured owner. These calls are synchronous
and adjacent in A1. They do not yet add a publication phase or change HTTP ordering.
No engine, transport, public schema, dependency or release version changed.

## Failing-first evidence

- Core `session-control.test.ts`: seven new cases failed before implementation;
  nine baseline cases passed. After implementation all 16 passed.
- Control `session-authority.test.ts`: two new cases failed before implementation;
  31 baseline cases passed. After implementation all 33 passed.
- The authority test observes terminal status while busy at the release boundary,
  attempts forbidden execution from the sealed scope and injects a conflicting late
  status. Both awaited and abandoned-write paths preserve their classified outcomes.
  This proves finalization/immutability, not real transport failure handling.
- An isolated FakeEngine probe against the actual built HTTP wrapper expected terminal
  status at `onSend` and exited 1: status was `in_flight`/busy at send and completed/idle
  after the response. This is a reproduced A3 gap, deliberately not claimed fixed or
  converted into a skipped passing test. The future HTTP migration must make it green.

The committed tests cover terminal replay while busy, immutable statuses, late dispatch
refusal, stopped/revoked drain, anonymous tickets and stale/foreign/copied ticket isolation.
Existing J0 tests also verify replacement-owner isolation and outstanding-work drain.

## Validation and review

All 338 core tests, 418 control tests and 18 affected API/coexistence tests passed.
The API selection includes actual loopback HTTP cancellation/drain. The strengthened
scope-closure test also checks read authority refusal, so the new dispatch seal cannot
mask an accidentally open execution scope. Specification validation covered 82 selections,
11 loader tests and 761 relative links; both explicit design modules remain below 12 KiB.

Independent compiled-core probes confirmed replay/conflicting admission preserves the
seal, mutation of a returned replay cannot alter retained facts, stop after finalization
preserves the outcome, anonymous admission resets correctly, and stale completion cannot
release a newer ticket. Exact-head review and normal hooks/CI remain delivery gates;
this evidence does not predeclare them successful.

## Remaining gates

A2 adds shared output-only publication authority; A3 migrates actual HTTP handlers and
qualifies bounded transport lifetime; A4 closes duplicate/publication parity. All need
failing-first tests and exact-head review. No durable journal can be enabled from A1.
J1-B/C, optional-store qualification, historical authorization and process-loss tests
remain open. T5 stays ~10%, with 3/9 finite milestones complete. This is a develop
foundation increment, not a release or installed-harness qualification.
