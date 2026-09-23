# T5 A4a1: explicit operation-status publication

Status: internal session lookup implemented; replay follows in A4a2; HTTP adoption pending.
Base: develop `df1d0a9` ([A2b #271](https://github.com/anvai-labs/agentbrowser/pull/271)).
Design: [status-publication sequence](../design/t5-status-publication.md).

## Observable behavior and reuse

`SessionAuthority.publishOperation` reads an existing operation ID and supplies a frozen,
flat `OperationRecord` to a bounded trusted-host publisher. Missing IDs return undefined
without invoking that publisher. There is no arbitrary payload, effect callback, new
record, execution admission, borrowed ticket or finish call. The original operation can
remain busy, complete or drain independently. Its frozen snapshot may therefore still
say in_flight after the original completes; it describes capture time.

Identity validation reuses `SessionAuthority.admit` without `SessionControl.begin`.
Same-tenant operators retain status inspection during delegated control and drain while
operator execution still refuses without takeover. Agents require current grant identity,
mode, binding generation and record epoch. Caller options/principal are snapshotted
before mutable authority state is consulted. No copied grant/tenant validation is added.

The guard captures the original Entry, current epoch and review version. It validates
before and after lookup, including absence, and again before output/after publisher
settlement. Stopped/configuring owners refuse. Owner replacement, expiry, review changes
and lost principal authority invalidate output; no later lookup of the replacement's
record can substitute for the captured one. Failure never changes the operation record
or releases another owner's ticket.

The publisher runs outside inherited execution AsyncLocalStorage using `scope.exit`.
An explicit lookup made from admitted work cannot lend that work's authority to the
publisher, including its asynchronous continuations; the caller retains its own scope
when lookup returns. This does not confine a trusted callback's raw capabilities.

A2a's bounded output lifetime moves into `publishWithin` in the existing internal
`publication.ts`. Both status and finalized-result publication reuse the same deadline,
sticky guard, AbortSignal and bounded-wait algorithm. The validator remains single-owned.
The base context contains only signal/assertCurrent; finalized-result publication adds
its existing terminal status. No in_flight snapshot masquerades as a terminal execution.

Timeout remains 1–60,000 ms, no default, starting at publication. Cancellation controls
output, never the original effect/drain. Publishers must check the guard at actual send;
the wrapper cannot revoke bytes or confine a host callback ignoring its guard.

## Validation and limits

The initial 18 new tests all failed against A2b, then passed. Five additional boundary
cases bring the status suite to 23 tests. Validation completed before delivery:

- 488 control tests passed, including existing session/application publication contracts.
- 70 affected API application/coexistence tests passed; control type-check/build passed.
- Independent compiled probes confirmed thenable/microtask scope isolation, caller scope
  restoration, independent concurrent cancellation, operator/agent inspection policy and
  refusal after review invalidation without finishing original work.

The suite also covers frozen in-flight snapshots through completion, wrong tenant,
stale/changed grants, prior-epoch agent refusal, operation lookup expiry including absence,
stopped/configuring absence, replacement with an active ticket, callback failure, options
mutation, timeout/cancellation, scheduling-gap replacement, pre-aborted output and retained
guard refusal. No production HTTP route or SDK/CLI/MCP surface opts in.

Normal hooks, exact-head review and PR/post-merge CI remain delivery gates, not claims
predeclared here. T5 remains ~10% foundation progress; 3/9 finite milestones are complete.
Published 1.9.1 and running services are unchanged. No journal or recovery guarantee ships.

## Next gate

[A4a2](t5-replay-publication.md) retains the original run's replay owner and composes fresh application access.
Do not republish an old replay by performing this fresh lookup after an await: a new
session with the same textual IDs would then be a different owner. Existing `begin`
remains the fingerprint/actor/epoch conflict owner; no second deduplication table.
Only then can A3 integrate HTTP drafts/publication and A4b qualify replay/error parity.
The existing HTTP finalization-ordering probe remains red until that integration.
