# T5 A4a: authorized status publication before HTTP adoption

Status: A4a1/A4a2 internal primitives implemented; A3/A4b proposed.
Base: develop `61ad5c1` (A4a1, PR #272).
Parent: [finalization/publication](t5-finalization-publication.md).
Load this module explicitly for status publication; unrelated modes do not need it.

## Sequence refinement

A3 cannot adopt the result publisher while duplicate/status responses fall back to an
unguarded send. Implement A4a internal status primitives before A3 HTTP migration,
then A4b full replay/error parity. Keep independently useful owners bounded:

1. A4a1: explicit session operation-status lookup with bounded publication.
2. A4a2: captured-owner replay integration and fresh application-access composition.
3. A3: inert HTTP drafts and guarded sending across the actual route inventory.
4. A4b: complete wire replay/error parity and real HTTP acceptance.

No HTTP caller may opt in until both result and replay paths are qualified. Existing
GET status inspection and duplicate execution remain unchanged during these packets.

## A4a1 contract and owners

Add trusted-host `SessionAuthority.publishOperation(sessionId, principal, operationId,
publication)`. Only the existing core record owner supplies the result; the caller
cannot supply a payload, operation callback or original ticket. Validate the ID through
`CONTROL_OPERATION_ID`. Return the published frozen flat `OperationRecord`, or undefined
without calling the publisher if no record exists. This does not allocate a new record.

Reuse `SessionAuthority.admit` for tenant/current-agent identity validation, without
`SessionControl.begin`. A same-tenant operator may inspect records while an agent owns
execution; operator execution still requires takeover. An agent needs its current grant,
mode/binding generation and control epoch, and the record must belong to that epoch.
Operator inspection of an older record is allowed under its current session authority.
Capture caller principal/options before consulting mutable owners; do not reread them
while awaiting publication.

Capture the actual Entry object, current control epoch and review version along with
the record. Check authority before and after lookup, even when the record is absent. Revalidate principal, entry identity, epoch/review, non-configuring and
non-stopped state before output and after asynchronous work. Refusal is sticky. Do not
refresh a snapshot from a replacement entry with the same text session/operation ID.
Status changes on the original record do not mutate the frozen snapshot: `in_flight`
means in flight at capture, not a promise of its status when later bytes arrive.

The new context has only `signal` and `assertCurrent`; it has no fabricated terminal
status. Extract A2a's bounded publication lifetime into the existing internal
`publication.ts`, parameterized by its owner check. Keep the same validator, deadline,
AbortSignal handling and bounded-wait helper. Finalized-result publication adds its
existing terminal status to this base context. No copied timer, lease, scheduler or
execution state is introduced.

Run snapshot publishers outside the caller's AsyncLocalStorage execution scope using
the existing scope owner. Even an explicit lookup invoked from inside admitted work
must not lend that work's authority to its output callback. Do not fabricate an empty
Scope or acquire a ticket. A trusted publisher still has its own raw capabilities; this
is lifetime enforcement, not callback confinement.

Timeout is the existing required 1–60,000 ms bound, starting when status publication
begins. Cancellation never changes, completes, releases or retries the original
operation. The publisher must check its output guard at actual send; already sent bytes
cannot be revoked. A slow or failed publisher may coexist with unrelated execution.
Missing records are not published, and no snapshot is persisted.

## A4a2 and transport gates

A4a1 is explicit lookup, not permission to publish an earlier duplicate result by
looking it up again. A4a2 must preserve the owner captured by the original run across
its replay branch. Existing `begin` continues to own fingerprint/actor/epoch conflicts;
no second deduplication table or fake ticket. Fresh application access must compose at
its existing owner without rerunning effects, consuming consent, or borrowing A2b's
execution-only capture. Do not cast replay data into `ApplicationResult`.

A4a2 adds a separate optional `OperationPublication` to `SessionAuthority.run`
(seventh argument) and `ApplicationAuthority.execute` (fifth). Result publication
continues to accept only its original result type and terminal context. Snapshot and
validate both option sets before admission or application callbacks, even when a fresh
operation will not use the replay publisher. No-options behavior stays unchanged.

At the existing core replay branch, use the admitted Entry, captured principal and
core-provided flat replay record. Capture the status lifetime before `begin`; use the
same private owner fence and scope-exited publisher as explicit lookup. Never perform
a fresh operation lookup, begin another ticket, finalize or finish the original one.
The original execution/drain/publication remains independent of duplicate output.

Application replay captures the request's existing Binding, adapter and ApplicationScope
synchronously before the asynchronous output handoff. It reuses `applicationAccess`
and the same guarded-publisher wrapper as result publication, with a fixed owner in
place of execution-only capture. Fresh authorization runs before handoff, at guarded
output and after settlement. Observed denial is sticky; a boolean policy cannot detect
an unobserved revoke/regrant. No consent, preparation, effect or receipt callback runs
again. A trusted publisher must guard actual output; raw capabilities are not confined.

Replay qualification additionally covers invalid options on fresh writes, duplicates
during execution/drain/result publication, core conflicts, same-ID replacement during
the scheduling gap, nested asynchronous scope isolation, authorization callbacks that
replace/take over ownership, delayed permission denial, and timeout/cancel/late output
without releasing original or replacement tickets. Output failure preserves operation
facts, including completed and outcome_unknown. No public transport adopts this yet.

A3 includes self-admitted application review and control resume-review as well as
ordinary handlers. Inventory by `registeredRoutes` and declared metadata. Preserve
operator status inspection during delegated control. A4b proves actual HTTP disconnect,
late-send, status/body/header/HEAD and replay parity before adoption is complete.
Journal ACK/quarantine work remains gated after this sequence.

## Failing-first acceptance

- Inspect frozen in-flight metadata while an agent write remains busy; no new admission,
  record, effects or mutation of the original ticket. Completion does not mutate snapshot.
- Operator inspection during delegated control succeeds while operator execution refuses;
  wrong tenant, stale grant and agent access to a prior-epoch record refuse.
- Mutation of caller principal/options after capture cannot alter validation or publisher.
- Replace/remove/expire owner or change review/epoch while output waits: no stale send,
  no lookup of replacement record and no release of replacement's active ticket.
- Timeout, cancellation, late callback/rejection and retained guard use fail closed while
  the original operation remains independently live or finalized.
- Nested lookup publisher cannot inherit an enclosing execution/read scope; caller scope
  is restored for legitimate work after lookup completes.
- Invalid options/ID refuse before publisher; unknown ID calls no publisher or executor.
- Existing A2a/A2b output lifetime and application permission suites stay green after
  shared-helper extraction. No public endpoint, manifest, release or service changes.

Implementation and validation: [A4a1 evidence](../evidence/t5-operation-status-publication.md)
and [A4a2 evidence](../evidence/t5-replay-publication.md).
