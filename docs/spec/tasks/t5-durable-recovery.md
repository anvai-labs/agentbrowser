# T5: optional durable operations and recovery

Status: not started. Repository: agentbrowser. Depends on: T2.
Inputs: core, contracts, execution, state-memory, security.

## Reuse and scope

Extend existing operation identity/status ownership through a small journal port.
Keep ephemeral mode explicit. Start with one optional local SQLite adapter and exclusive
store ownership if dependency/runtime audit supports it; no mandatory broker/database
and no copied authority machine. Reuse shared evidence storage and canonical input.

## Slices

1. Define journal transition/retention/schema/key-lifecycle contract and failure tests.
2. Persist bounded intent, dispatch and terminal metadata; recover under a new generation.
3. Add authorized receipt/report lookup and explicit resume of revalidated undispatched
   work. Qualify cursor snapshot/event recovery through the existing event boundary.

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
