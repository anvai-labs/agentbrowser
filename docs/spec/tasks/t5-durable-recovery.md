# T5: optional durable operations and recovery

Status: HTTP/replay publication merged; B1/B2 journal contract merged #285;
C1a settlement merged #297; C1b authority composition merged #298;
C2/C3 application guards and terminal/replay merged #299;
runtime enablement gated and durable recovery unimplemented.
Repository: agentbrowser. Depends on: T2.
Inputs: core, contracts, execution, state-memory, security.

## Reuse and scope

Extend existing operation identity/status ownership through a small journal port.
Keep ephemeral mode explicit. Start with one optional local SQLite adapter and exclusive
store ownership if dependency/runtime audit supports it; no mandatory broker/database
and no copied authority machine. Reuse shared evidence storage and canonical input.

## Slices

0. [J0 shared dispatch/drain](../design/t5-operation-journal.md): consolidate the three
   existing business-write boundaries under SessionAuthority. Retain pending writes
   through drain and refuse to report abandoned unresolved work as completed.
   This prerequisite adds no store, wire capability or durable acknowledgment.
1. Define journal transition/retention/schema/key-lifecycle contract and failure tests.
2. Persist bounded intent, dispatch and terminal metadata; recover under a new generation.
3. Add authorized receipt/report lookup and explicit resume of revalidated undispatched
   work. Qualify cursor snapshot/event recovery through the existing event boundary.

The [journal design](../design/t5-operation-journal.md) assigns owners, crash states,
response-acknowledgment changes, retention/key policy and J1–J4 delivery gates. Read
it explicitly for T5 implementation; it is not added to unrelated mode context.

A1 finalization and A2a/A2b publication primitives are implemented
([A1](../evidence/t5-finalization.md), [A2a](../evidence/t5-session-publication.md),
[A2b](../evidence/t5-application-publication.md)).
[A4a1 status lookup](../evidence/t5-operation-status-publication.md) and
[A4a2 replay/application composition](../evidence/t5-replay-publication.md) are implemented.
[A3a review owner pins and page/evidence disclosure](../evidence/t5-review-publication.md)
are implemented as internal composition; A3a2 shipped in 1.11.0.
The bounded [A3b application HTTP adoption](../design/t5-http-publication.md) merged
as PR #283 ([evidence](../evidence/t5-http-publication.md)). The
[A3c/A4b browser/review HTTP adoption](../design/t5-browser-review-publication.md)
merged as PR #284 and covers the remaining bounded session routes ([evidence](../evidence/t5-browser-review-publication.md)).
Its exact-head review and PR/post-merge CI are green. The current
[J1-B1/B2 journal contract](../design/t5-journal-contract.md), merged as PR #285, adds storage-neutral
validation and adapter conformance ([evidence](../evidence/t5-journal-contract.md)).
[C1a per-call settlement](../evidence/t5-journal-settlement.md) extends that facade without
connecting a runtime store. [C1b authority composition](../design/t5-journal-authority.md)
tracks intent/marker settlement through the existing ticket and dispatch helpers.
[C2 application-owned pins and C3 terminal/replay](../design/t5-journal-application-terminal.md)
merged as #299. [C4a shared control views](../design/t5-journal-control-views.md)
now bound status/lifecycle disclosure by ACK. C4b runtime/transport selection stays gated;
J2–J4 remain proposed and loaded on demand.
Browser durability waits for its existing target/policy/approval owners to support
post-storage-wait revalidation. Do not advertise recovery from J0 or this design.

## TDD and acceptance

Crash before intent, after intent, after dispatch marker, after business commit and
before terminal persistence. Verify no replay, old grant rejection and conservative
unknown outcomes. Test disk full, corrupted/mismatched schema, second store owner,
expired tombstones, key rotation, stale cursors and slow subscribers.

Records cannot be evicted while their IDs remain acceptable for deduplication. Recovery
does not revive a browser or grant. Journal metadata excludes raw credentials/form
values. Application-only ephemeral startup still works without the durable adapter.
Cancellation drains; hard engine termination is a separate capability requiring evidence.

## Completion / stop

Close R08 and durable portions of R10. Advertise recovery only for qualified operations
and stores. Do not promise exactly-once external effects or resume unverified browser
steps. Block durable publication if storage/key retention makes replay ambiguity unsafe.
