# T5: optional durable operations and recovery

Status: active J0/A1/A2a session foundation; durable recovery unimplemented.
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

A1 finalization and A2a session publication are implemented
([A1](../evidence/t5-finalization.md), [A2a](../evidence/t5-session-publication.md)).
Next implement [J1-A publication](../design/t5-finalization-publication.md)
packets A2b application permission fencing, A3 HTTP and A4 replay, then the [J1-B/C journal contract](../design/t5-journal-contract.md)
and application-only integration. Remaining packets are proposed and loaded on demand.
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
