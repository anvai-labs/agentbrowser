# C2c internal evidence review qualification

Base: develop `5712475` (#246). See the
[design](../design/t6-evidence-review-binding.md). This composes the existing
ApprovalGate with a bounded, domain-separated action-plus-source-plus-witness
envelope. No new token store, lifecycle, public route, runtime dependency or executor.
The service reuses its native reader's admission/page fence and existing read drain.

## Regression evidence

The shared-helper suite first failed on the absent module. The API suite first
reported ten missing-method failures; its later browser-action isolation case also
pins that reserved evidence tokens cannot authorize an ordinary action. Fourteen
service cases cover separate admissions, policy, escaped handles, drift, generation,
private disclosure, action snapshotting, foreign source/page, takeover and read drain.

The existing real Chromium fixture is reused rather than copied. Three additional
cases drive complete-witness generate/inspect/approve/consume across separate
operator admissions; reject prior consent after both app and UI commit a new answer;
reject uncommitted same-size file replacement; and refuse private review after source
revocation or regrant. All eight browser cases and fourteen service cases pass, along
with four existing operator action-binding regressions (26 focused tests total).
Every fixture submission counter remains zero. Review operations assert no dispatch.

Shared helper tests separately pin the complete aggregate budget, intended action,
source permission generation, callback capture, cancellation, denial, expiry and
atomic single consumption. The existing permission guard is factored to expose its
captured generation without duplicating its validation algorithm. Snapshot/freezing
uses the existing authorization helper and canonical serializer.

Independent review exposed three additional gaps: distinct source owners sharing a
contract/generation, revocation during throwing callbacks, and service canonicalization
discarding hidden/symbol action properties. Additional failing-first regressions bind
an owner incarnation, observe/latch revocation on failure paths and strictly snapshot
service action input before canonicalization. Cancellation remains separate from
sticky permission loss.

A further failing disclosure regression rechecks source authorization after the
permission-generation callback: that callback can revoke an independently guarded
underlying source. This follows the existing application evidence reader's guard order.

## Remaining gates and limits

The source callback is trusted deployment composition. The synthetic collector,
not JSON shape or a digest supplied by a caller, qualifies app/native agreement.
Inspection and decisions require current permission but refer to the stored review;
consumption recollects and compares. An abandoned/revoked generation can leave an
inaccessible token until existing expiry/cleanup; it cannot dispatch or restore consent.
Gate success alone is not an execution permit or an atomic application commit.

Existing public inspection/decision refuses reserved records until source selection
and disclosure policy are designed and qualified there. This does not add a CLI/MCP
command or claim a usable live-portal consent flow. C3 atomic app-owned dispatch and
independent acceptance remain pending; T5 owns process-loss recovery. Published
1.9.1 is unchanged and finite milestone completion remains 3/9.

Normal hooks, exact-head independent review and green PR/post-merge CI gate delivery.
Record immutable head/tree/run evidence in the PR after verification.
