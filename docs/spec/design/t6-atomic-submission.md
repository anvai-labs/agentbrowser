# C3: qualified application-owned submission

Base: develop `c968280` (#248). Load forms/T6 and application/T4. C2d exposes
inspection/decision of host-created qualified witnesses; it does not expose creation,
consumption or submission. This design separates a business owner's atomic acceptance
from service consent, dispatch and outcome verification. Published 1.9.1 stays unchanged.

## Invariants and common owners

Reuse ApplicationAuthority for binding, admission, canonical operation fingerprints,
dispatch marking and reconciliation; ApprovalGate/PreparedEvidenceReview for explicit
review and single consumption; existing qualified app/native readers for witnesses;
and T2 receipt sources/verifiers for independent outcomes. No alternate executor,
consent store, service operation ledger, profile database or MCP-only path.

An approved `intent: draft` is never consent to submit. A submission action must bind
explicit submit intent, adapter/resource incarnation, operation, job/destination,
complete payload, actual received file identity and expected app version. Operator
credentials establish operator authority, not proof of human presence.

A DOM comparison followed by clicking cannot atomically bind a hostile page's network
payload. Begin with a cooperative application owner that can compare its full current
state and commit the accepted application synchronously. Report that narrower guarantee.
Unsupported live ATS forms remain draft/manual; this design authorizes no live submission.

## C3a — independent atomic acceptance oracle (merged #249)

Extend `test-support/application-draft.ts`, not a parallel fixture/owner. Add a direct
**test-only** `submit(expectedVersion, command)` method. Do not register a submit
operation on its application adapter and do not enable HTTP `/submit`. Registering a
write today would bypass consent through ordinary `application.execute`, whose shared
pre-dispatch consent policy is still a C3b design gate.

Command is bounded strict own-data JSON with exactly `operationId`, `intent: submit`
and `expected` (the complete detached DraftSnapshot). Use existing protocol snapshots,
canonical serializer, operation-ID syntax and draft version checks. Snapshot all caller
input before touching current mutable state; getters, symbols, hidden/extra keys,
invalid types and budget overflow refuse without private diagnostics. Proxy traps may
execute while inspecting input; final version/payload comparison observes their effects.
No caller callback or await may separate the final comparison from acceptance.

For a new acceptance require a matching current version and complete owner-derived
snapshot, including contract, draft incarnation, job/destination, every field and
attachment metadata/digest. Never trust a supplied complete flag or digest alone.
The upload owner retains a detached bounded copy of actual received bytes; removal
clears it. Acceptance transfers those private bytes to the terminal acceptance record.
Test-only inspection returns detached bytes; public receipts never contain file bytes.

Keep one bounded terminal acceptance per draft incarnation. Its app-generated ID,
original operation ID, accepted snapshot/version and committed version form an
independent receipt. Increment version and acceptance count in the same synchronous
commit. Later update/upload/remove and distinct submissions refuse. A retry with the
same operation ID and exact original command/version returns the same detached receipt
without another acceptance; a changed command conflicts. Check valid replay before
rejecting the now-stale original expected version. This is one business acceptance,
not another generic service operation ledger or durability implementation.

Receipt lookup reads the app-owned record independently of the returned execution
result. The existing adapter receipt callback may expose that record only under current
tenant/resource authority and a live scope; a foreign/aborted scope gets no private data.
No operation in the public adapter can create the acceptance in this slice. Draft
incarnation and complete accepted identity prevent confusing receipts across owners.

## C3b — mandatory consent at the shared dispatch boundary (design gate)

The [concrete C3b design](t6-mandatory-application-consent.md) and its
[qualification](../evidence/t6-mandatory-application-consent.md) implement the internal
enforcement gate. Public creation/execution projection still belongs to C3c.

Before exposing a submit operation, settle a minimal trusted operation policy in
ApplicationAuthority. Every invocation of a review-required operation must enforce it;
no caller-selected guard, `approved` boolean, special CLI wrapper or optional route
bypass is sufficient. Missing policy/source refuses. Keep ordinary operations unchanged.

The intended sequence is existing admission -> capture exact application/page/source
owners -> prepare bounded operation -> collect/compare qualified submit witness ->
consume matching consent once -> recheck authority/binding -> mark dispatch -> invoke
one app-owned atomic comparison/commit. Do not nest authority.run or transfer a consumed
boolean between admissions. Preserve drain and sticky revocation semantics across awaits.
Callback capture, operation discovery metadata, error classification and the exact
internal policy API require written design and adversarial review before implementation.

The app's atomic compare-and-submit remains necessary even after fresh service evidence:
application writes can race outside the browser session. A known app rejection does not
revive consumed consent automatically. The operator can review fresh evidence for a new
attempt; an uncertain dispatched attempt is reconciled before any new write.

## C3c — public usability and independent acceptance (design gate)

Design bounded public review creation/execution only after mandatory enforcement is
qualified. Reuse REST/SDK/CLI owners and discovery schemas; MCP remains optional. Use
one service operation identity and the app-owned acceptance lookup. Lost responses are
unknown until existing reconciliation and independently authorized receipt evidence
resolve them; never resubmit just because a client timed out. Process-loss durability
belongs to T5, and production source qualification remains T4/T6/T8.

## Agent-consumable TDD / delivery tasks

1. C3a owner tests first: one matching acceptance; every identity/field/file mismatch;
   incomplete or forged completeness; stale versions and recreated owners; exact replay
   versus changed command/new operation; detached snapshots and actual file bytes;
   input getter/proxy reentry; terminal edit refusal and lost-return receipt recovery.
   Pin adapter and HTTP submit refusal separately from the acceptance counter.
2. C3b written policy design, then tests for every execution path: absent/unapproved/
   expired/draft-only consent; foreign/rebound/revoked owners; page replacement and
   callback reentry; simultaneous consumers. Each refusal must show zero app dispatch.
3. C3c real Chromium + compiled CLI: one explicitly approved complete submission and
   an independent accepted receipt. Mutate one answer/hidden value/file between phases;
   lose the execution response; reconcile without replaying effects. Preserve browser-
   free application qualification and report UI/API paths independently.
4. Each bounded slice: focused failing-first tests, required hooks, independent review
   of the exact head, one PR candidate to develop, all PR/post-merge CI green. No new CI
   job, unnecessary runner matrix or release for this internal oracle. Preserve other
   worktrees, private profiles and live logged-in sessions.

C3a alone does not complete T4/T6 or enable a user-facing submit workflow. Candidate
screening, source-grounded resume generation and live portal qualification stay gated.
