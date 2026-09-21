# T6: reviewed payload consent, from shared owners to qualified submission

Status: C0 merged #240; C1 review-binding foundation merged #241. C1a operator
action approval merged #242; C2–C3 remain incomplete. The [C2a draft oracle](t6-draft-oracle.md)
merged #243 as test-only qualification, before service-collected witness binding.
The [C2b read foundation](t6-scoped-application-read.md) supplies scoped authorized data;
the [read-source composition](t6-application-read-evidence.md) adds required source
authorization and test-only named data validation. The
[native witness](t6-native-form-witness.md), merged #246, qualifies cooperative
draft/page correlation. The [C2c internal review binding](t6-evidence-review-binding.md)
merged #247, connecting that evidence to the reviewed lifecycle without dispatch.
[C2d public inspection/decision](t6-public-evidence-review.md) is the current
qualification slice; public creation and qualified submission remain pending.
Base: develop `f12ac89` after [checked upload/draft](t6-verified-upload-draft.md),
PR #239. Load with forms/T6 only. Published 1.9.1 remains unchanged.

## First principles and current limits

A successful fill or attachment is not a submitted application. A digest supplied
by the executing agent is not proof of live form contents or independent review.
Legacy `ApprovalGate` tokens are confirmation challenges: the same caller can
echo a pending token for the identical action. Legacy confirmation has no separate
approved state or operator grant. The service binds session/page/revision, live URL, target identity
and action parameters, but a submit click contains no full answers/PDF/job witness.

Checked upload supplies the exact bytes it hashes; the page can transmit those
bytes on attachment or replace/remove the file before submit. Browser revision and
URL are not business identity. Do not claim arbitrary ATS payload equivalence from
a DOM snapshot or human approval from a token echo.

Preserve the existing service/CLI execution path. Reuse SessionAuthority for actor,
tenant, epoch and session lifetime; ApprovalGate for token lifecycle; bounded
canonical data for fingerprints; the existing engine evidence seam for qualified
live observations; and T2 verifiers for independent outcomes. No second consent
engine, workflow executor, operation ledger, profile database or MCP-only path.

## C0 — token ownership and atomic consumption (this slice)

Before adding reviewed consent, make the existing owner reliable:

- Return detached token snapshots from generation, lookup and session listing.
  Callers must not alter stored expiry, fingerprint, session or used state.
- Add `consumeApprovalToken(tokenId, request) -> Promise<boolean>`. Canonicalize
  and detach the complete bounded request first, then look up the token and check
  pending state, session, action fingerprint and `now < expiresAt`, immediately
  marking it used in the same synchronous section. No await or caller callback
  belongs between the final checks and state change. The service uses this method
  directly. A refusal retains the existing fresh `APPROVAL_REQUIRED` response.
- Keep validation as a read-only compatibility probe; it never reserves permission.
  Keep legacy `useApprovalToken` for trusted internal callers, but require a live
  pending token. It is not the service's authorization path.
- Reuse the existing canonical serializer by moving its owner from control to core,
  keeping control's import path as a re-export. No duplicate traversal algorithm or
  core-to-control dependency. Retain its 64 KiB serialized UTF-8, 4,096-node and
  depth-16 limits, strict finite JSON and descriptor reads. Approval request errors
  are sanitized; direct callers must supply JSON data, not getters/undefined/functions.
- Snapshot request data before a cleanup await; recheck closure and capacity before
  insertion. Shutdown cannot be undone by a suspended generation. Expired/used tokens
  do not become pending again even if the clock moves backwards.

Accessor rejection does not isolate arbitrary JavaScript Proxy traps: traps can run
while inspecting descriptors/prototypes. Complete that work before consulting token
state; a reentrant consume or shutdown must invalidate the outer operation. Byte/depth
bounds are not a hard CPU-time sandbox. Lifecycle timestamps retain the existing clock;
this slice is not a distributed clock or durable recovery redesign.

C0 preserves action-confirmation semantics. It adds no operator-approval endpoint,
payload evidence capability, permission or live-submit claim. Token fingerprints are
process-local; no migration or persistent token compatibility is promised.

## C1 — explicit operator action approval

Start with the [authority-bound review foundation](t6-review-authority-binding.md).
Epoch alone does not detect repeated human takeover or all configuration changes.
The first operator-approval surface will stay in HUMAN_ACTIVE; delegation changes
epoch and requires a separate qualified handoff design. No approval survives a
handoff merely because the caller still possesses its token.

The [C1a implementation](t6-operator-approval.md) adds the distinct reviewed lifecycle
and REST/SDK/CLI projections for operator-only execution. Policy-required actions
use it when selected at session creation; legacy confirmation remains separate.
Delegated consumption and configured policy auto-approval are not implemented.

Define a reviewed-consent mode with a separate challenge → approved → consumed
transition. A delegated execution grant can request a challenge and inspect a bounded
summary, but cannot approve itself. Approval requires current operator authority or
an explicitly configured, scoped policy grant. Reuse SessionAuthority admission; do
not infer authority from mode labels, UI badges, the payload or token possession.

Bind approval to tenant/session incarnation, authority epoch, page/document identity,
qualified action/destination, expiry and the reviewed evidence reference. Invalidate
on revocation, handoff, navigation, expiry and material drift. Compatibility with legacy
confirmation must be explicit and opt-in; do not silently label legacy tokens approved.
Choose REST/SDK/CLI projections only after reviewing the operator and delegated route
contracts. CLI remains first-class; MCP can remain absent for this slice.

## C2 — immutable review envelope and live witness (design)

For one named synthetic application contract, define a bounded envelope containing:
business/job identity and source evidence, all required answers, attachment digest,
qualified control identities/strategies, unsupported/manual fields, destination and
intended side effect. Keep private values in existing scoped private evidence; hashes
of low-entropy answers are not anonymization. Reuse canonical data and evidence access
helpers. Do not create a parallel profile store or expose answers in errors/logs.

An agent's supplied digest is insufficient. The service must obtain complete current
evidence from a qualified engine/app-owned source, compare privately, and bind that
witness to review. Missing, ambiguous, truncated, stale or unsupported evidence refuses.
Specify hidden fields, repeated labels, file replacement, custom committed selections
and manual-required controls explicitly. A successful earlier autofill receipt alone
does not prove the current payload.

The [C2d public review design](t6-public-evidence-review.md) connects host-created
qualified records to existing REST/SDK/CLI inspection and decisions through trusted
current source resolution. It adds no public create/consume/submit operation and
keeps the default service fail-closed.

## C3 — dispatch and independent outcome (design)

Revalidate the approved envelope immediately before dispatch under the existing session
authority and consume consent atomically. Use one operation ID and existing uncertainty
reconciliation; response loss is never permission to click submit again. A server-side
app-owned atomic compare-and-submit operation can guarantee a stronger boundary than
an arbitrary browser page. Keep those claims separate.

DOM checking followed by clicking cannot make a hostile page's emitted network payload
atomic with the check. Start with one qualified application/adapter and state its threat
model. Unsupported live ATS forms remain draft/manual. Require an independent receipt
tied to the job/application, not only UI success, before claiming submission acceptance.
Process-loss durability remains T5; do not add persistence within consent work.

## Agent-consumable validation and delivery sequence

1. C0 failing-first: mutate every returned token view; consume expired/used tokens;
   race two consumes; reenter during input inspection; mutate input while generation
   awaits cleanup; shut down during generation; exceed data bounds or supply getters.
   Exactly one matching live consume succeeds and invalid attempts dispatch no action.
   Pin normal service-generated requests and legacy confirmation behavior.
2. C1: delegated self-approval, foreign tenant/session/page/epoch, unapproved/expired/
   reused tokens all refuse. Operator approval is explicit and auditable without private
   payload leakage. Test revocation between review and execution.
3. C2: alter each answer, same-size attachment bytes, job ID, destination and required
   hidden/manual field independently. Reject incomplete evidence and low-confidence
   strategy commitments. Review a bounded immutable snapshot, not a mutable callback.
4. C3: compiled CLI plus an independent app submission counter. One approved qualified
   payload can submit once; every unapproved/drifted case submits zero times. Exercise
   simultaneous consumers, navigation, loss of response and uncertainty reconciliation.
5. For each bounded slice: focused tests, current mandatory hooks, exact-head adversarial
   review, one ready PR candidate to develop, all PR/post-merge CI green. Update capability
   and progress docs to code reality. Release at a usable qualified checkpoint, not after
   every internal helper. Preserve published 1.9.1 and existing logged-in sessions.

Candidate screening, source-grounded private resume generation and live portal
qualification remain separate T6 gates. This design authorizes no live submission.
