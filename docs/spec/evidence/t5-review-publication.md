# T5 A3a1: session and application review publication owners

Status: A3a1 internal owner pins and A3a2 composition implemented and locally qualified;
HTTP adoption remains pending. Delivery gates are recorded below.
Base: develop `8752c6b` ([A4a2 #273](https://github.com/anvai-labs/agentbrowser/pull/273)).
Design: [review publication ownership](../design/t5-review-publication.md).

## Observable behavior and reuse

SessionAuthority's existing Scope retains its actual publication guard only while the
existing bounded publisher runs. The reference clears in finally before ticket release,
including timeout/cancellation with a still-pending callback. No additional timer,
registry, scheduler, grant, executor or operation record is introduced.

`publicationGuardInScope` captures that Scope during execution. The check refuses until
the original publisher becomes active and after it closes. Another session's live
publication cannot activate a draining original, and a later operation cannot revive
an old check. No caller-provided PublicationContext can lend a different lifetime.

`captureReviewPublicationInScope` captures a frozen review binding and an output check.
It reuses the owner validation/projection below reviewBindingInScope, retaining the
original Entry/ticket, stable operator state, incarnation, epoch, review version and
configuration checks. Observed refusal is sticky. Capture and all old read/review/consent
methods still require open execution; the new output check grants none of those powers.

PreparedApplicationOperationReview adds a frozen publication pair: assertCurrent checks
current application permission and owner pins; assertPinned checks final owners without
calling application authorization. Both use one sticky applicationAccess instance over
the same captured ApplicationAccessOwner as the existing read fence. Output performs no
parsing/preparation, effect, receipt callback, evidence collection or consent consumption.
Read and output fences retain distinct lifetimes; denying an attempted read after sealing
does not open it or invalidate an otherwise current output owner.

These are trusted-host checks, not callback confinement or a new send API. Consumers
must check at actual output. Boolean application authorization can latch observed denial,
not an unobserved revoke/regrant. A guard intentionally called in the wrong phase may
remain refused; callers must not use it as an execution-time readiness probe.

## Qualification

22 regression cases were added. Against the previous implementation, 21 failed; the
existing foreign-tenant admission invariant stayed green. All pass with this change.
Four initial refusal tests were tightened to prove the new output check first succeeded,
so a missing method cannot accidentally satisfy their expected-denial assertion.

- 534 control tests pass across 18 files; control type-check/build pass.
- 84 affected API review/consent/application/owner-lifecycle tests pass.
- Tests cover same-run publication, execution/drain/no-publisher refusal, capture refusal
  outside stable operator execution, cross-session and later-operation lifetime isolation,
  timeout, cancellation, pre-aborted output, callback error, and closure before finish.
- Takeover, review invalidation, expiry and same-ID replacement suppress delayed output
  without changing completed records or releasing replacement work.
- Application permission denial/regrant stays refused; authorization callbacks replacing
  or taking over owners cannot pass final pins. Callback-free checks invoke no adapter
  authorization, and output cannot invoke existing read or dispatch methods.

One broad local hook attempt failed the existing stdio coexistence UI test while waiting
for the delegate button to enable. The unchanged isolated real-Chromium file then passed
all four enabled cases (two existing Victor skips). No production or test workaround was
added; the complete mandatory hook remains required before commit.

Normal hooks, independent exact-head review and PR/post-merge CI remain delivery gates;
this file does not predeclare completion. Public wire behavior, SDK/CLI/MCP catalogs,
release 1.9.1 and running services are unchanged. Milestones remain 3/9 complete and
T5 ~10% foundation progress; journal/recovery guarantees remain unimplemented.

## Next gate

A3a2 must compose captured page, evidence permission/source generation, review policy
and secret-disclosure checks into generated/stored review publication. Preserve existing
collection and consent guards, callback ordering, and ApprovalGate ownership. Token views
are capture-time snapshots; current state/expiry and fresh witnesses are enforced at
later decision/consumption. Do not add another token lookup merely to send a snapshot.

Only after that qualification should A3 move real HTTP handlers to inert drafts and one
guarded publisher, with A4b wire/disconnect/late-output parity. The current HTTP probe
still observes in_flight at onSend and completed after the response; internal owner checks
alone do not fix that ordering or prove transport safety.

## A3a2: page/evidence disclosure candidate

Rebased on develop `e123a4d`, preserving SPA-capture changes in #279–#280 and
the extraction budget repair in #281.
The service extracts physical page ownership once and composes it with the existing
SessionAuthority publication lifetime, application binding and evidence permission
generation. Native reads retain their original execution-only admission and tracking.
No page recapture, replacement-by-ID lookup, evidence collection, token lookup,
consent consumption or effect dispatch is performed to publish a captured view.

`PreparedEvidenceReview.capturePublication` and the shared `captureReviewDisclosure`
return detached, deeply frozen views. Their guards expire with the original publisher
and latch observed refusal. Existing protocol approval-view bounds remain authoritative;
publication does not silently impose the smaller verification-input depth budget.
The existing snapshot freezer is reused after protocol parsing.

The service's application review, approval get and approval decide wrappers share
the same preparation paths with future guarded publishers. Ordinary approvals do
not require native-form support. An omitted decision is still refused, never
silently converted into inspection by the optional-decision preparation helper.

Trusted permission owners must advance their generation on every evidence permission
change, including regrant. Application policy replacement must use existing authority
invalidation. Reentrant callbacks remain supported; secret disclosure is checked
after callbacks and final page/application pins are callback-free. Silent same-generation
source changes violate the trusted-owner contract; arbitrary unversioned Boolean
application policy mutation is outside its guarantee. Repeating more callbacks cannot
close that boundary. See the [owner-consistency contract](../design/t5-review-publication.md#trusted-owner-consistency).

Qualification on this candidate:

- 40 added regressions; the original 27 missing-publication cases failed first.
  A later omitted-decision compatibility case also failed before its repair.
- Independent review found a missing final execution-owner pin in ordinary approval
  get/decide preparation. Three failing-first cases reproduced page replacement from
  the terminal secret check. The ordinary path now reuses its callback-free execution
  guard after capture, preserving owner checks for existing wire wrappers too.
- 91 focused control tests and 154 API/service/HTTP tests passed on `124afc3`.
  The subsequent terminal-secret repair passes all 21 ordinary-approval tests.
  Whole-workspace build passes on the rebased candidate.
- Generated/get/approve/deny views publish only in their original run, after operation
  finalization while exclusion is held. Deferred application/source/page/secret changes
  suppress sends. Publication deadlines preserve finalized approval facts and refuse
  retained late sends. Existing compiled CLI approval lifecycle remains qualified.
- A terminal permission callback that revokes/regrants evidence or replaces the physical
  page suppresses output without new reads or effects. Retained guards cannot revive
  under another operation or restored owner. Deep legacy views retain existing limits.

Normal full hooks, independent final review and PR CI remain required. This candidate
does not migrate HTTP send ownership, add a journal or advertise durable recovery.
Next is A3 HTTP adoption and A4b transport/replay parity; T5 stays approximately 10%
and 3/9 finite milestones remain complete.


A3a2 delivered in [PR #282](https://github.com/anvai-labs/agentbrowser/pull/282),
merge `89c20e6`. PR run `35956410505` and post-merge `35956821515` passed 8/8
checks with independent clean review. The source is merged, pending a later release.
