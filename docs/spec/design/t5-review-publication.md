# T5 A3a: review publication ownership

Status: A3a1 session/application owner pins implemented; A3a2 page/evidence composition
and A3 HTTP adoption remain gated.
Base: develop `8752c6b` (A4a2, PR #273).
Parent: [finalization/publication](t5-finalization-publication.md).
Load explicitly for review disclosure; unrelated modes need no additional context.

## Problem and sequence

Review generation and stored approval inspection retain application intent, page,
source permission, review authority and secret-disclosure checks. Their current guards
require an open execution scope. Carrying those guards unchanged into publication
would refuse every send; checking only session lifetime would drop required owners.

1. A3a1: capture session and application review output checks while admitted, then
   qualify their use only during that same operation's actual publication phase.
2. A3a2: compose native-page, evidence permission and secret-disclosure owners for
   generated and stored review views. Keep collection and consent execution-only.
3. A3: inert HTTP drafts plus one guarded publisher across the actual route inventory.
4. A4b: real HTTP disconnect, late-output, error/header/HEAD and replay parity.

A3a1 alone does not authorize HTTP migration or complete review disclosure. Existing
HTTP behavior, release 1.9.1, running services and durable recovery claims are unchanged.

## A3a1 lifetime: captured scope, no caller-provided context

The existing SessionAuthority Scope retains a reference to its active publication guard
only while its existing publishWithin callback is active. Install it inside that callback
and clear it in the outer finally before ticket release, including timeout/cancellation.
The bounded helper still owns the only deadline, abort listener and sticky output guard.
No separate registry, executor, grant, timer or publication state machine is introduced.

`publicationGuardInScope(sessionId)` captures the current admitted Scope and returns a
check of that Scope's own active publication lifetime. Capture requires open execution.
Use refuses during execution or drain, before publication starts, after output closes,
and cannot be activated by a different operation/session's publisher. Never accept a caller-provided
PublicationContext: a different live context could otherwise extend the wrong lifetime.
No read or dispatch authority is conveyed, and no original ticket can be released.

`captureReviewPublicationInScope(sessionId)` returns a frozen binding and assertCurrent
check. Capture uses existing stable operator review admission. Reuse the review-owner
validation/projection beneath reviewBindingInScope, plus the actual publication lifetime.
Pin original Entry/ticket, human control, tenant/incarnation, epoch, review version and
non-configuring state. Observed review-owner refusal is sticky. Existing reviewBinding,
outputGuard and prepared read/consent checks continue to require open execution.

## A3a1 application composition

PreparedApplicationOperationReview gains a frozen `publication` pair with assertCurrent
and assertPinned. Capture the same ApplicationAccessOwner used by its existing read
fence; do not look up a replacement binding after sealing. Compose applicationAccess
with the captured review publication check. This provides one sticky access fence per
prepared review, never a factory that can reset a denied owner.

assertCurrent checks the original publication/review lifetime, application binding,
current application authorization, and owner pins again after the host callback.
assertPinned performs the existing final owner comparisons without invoking application
authorization. This preserves ordering for later evidence/source composition. The old
assertCurrent/assertPinned remain execution-only; failed read checks cannot manufacture
publication authority. Output performs no preparation, receipt, evidence collection,
consent consumption, token mutation or effect dispatch. Callback errors stay bounded.

Trusted hosts must invoke these checks at actual output together with their existing
publisher contract. Raw callback capabilities are not confined. Boolean authorization
can latch observed denial but cannot detect an unobserved revoke/regrant.

## A3a1 failing-first acceptance

- Capture requires the matching live operator execution; agent, foreign tenant,
  resume-review state and configuring owners refuse.
- Publication checks work after execution seals only within the original publisher;
  old read/dispatch/consent checks still refuse. No additional ticket or effect.
- During original drain, another session's publisher cannot use the captured review.
  After original publication finishes, another operation cannot revive it.
- Same-ID replacement, takeover, review invalidation, expiry and cancellation suppress
  delayed output without changing finalized facts or releasing replacement work.
- Timeout/late callback and retained guard use refuse even before lingering callback
  settlement. Existing bounded-wait behavior remains unchanged.
- Application binding/permission changes refuse; denial remains sticky across regrant.
  Authorization callbacks replacing or taking over the owner cannot pass final pins.
- Callback-free application pins invoke no authorization callback; execution and
  publication fences retain distinct lifetimes over one captured owner.
- Existing session/result/replay publication, application consent and review suites
  stay green. No public endpoint, SDK, CLI or MCP change.

## A3a2 owner map and acceptance gates

Service native-form ownership compares the captured coordinator session, page object,
engine page, incarnation and signal. Extract those comparisons from read permission;
keep admission/read tracking in the current read fence. Never recapture a page by text ID
or call its engine merely to disclose a view.

Reviewed evidence already captures source identity/contract and prepareEvidencePermission's
generation. Reuse that owner and the immutable configured provider; do not invent a source
registry. Separate execution operations (generate/get/decide/consume/collect) from the
output check of the captured view. Reuse current authorization ordering and final pins,
including disclosure safety against newly registered secrets. Callback substitution,
page replacement and permission-generation changes must suppress delayed output.

OperatorApprovalView is a capture-time snapshot, not proof its status remains actionable
when delivered. ApprovalGate already copies views and atomically validates status/expiry
at decide/consume. No second token lookup, version store or witness collection is needed
just to send a captured view. Fresh witness verification remains at consumption.

Qualify applicationReview, getApproval and decideApproval together with existing service
fixtures before HTTP adoption. Control prepare-resume must keep execution cleanup separate
from delivery failure and never take over a replacement session by textual ID. Actual
HTTP tests must observe finalized operation status before bytes while exclusion remains
held through publication. A later asynchronous onSend hook cannot bypass the final guard;
output abort must prevent a late send, not merely substitute a stale 409 body.

Implementation and validation: [A3a1 evidence](../evidence/t5-review-publication.md).

## Release 1.10.0 prerequisite repair

Stored application approval get/decide now recheck the current application authority
before invoking the evidence provider, pin the complete stored action and perform
final application owner checks. Consent consumption reuses its existing prepared
review handle. This narrowly fixes the observed execution-phase access gap; it does
not complete A3a2 page/evidence/disclosure publication or HTTP adoption. See the
[release qualification](../evidence/release-1.10.0.md).
