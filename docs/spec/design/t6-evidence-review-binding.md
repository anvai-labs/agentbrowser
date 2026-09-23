# C2c: scoped review of a complete native draft witness

Base: develop `5712475` (#246). Load forms/T6 and application/T4 only. Connect the
qualified cooperative native draft collector to the existing ApprovalGate lifecycle.
This internal qualification adds no dispatch, public endpoint or new consent owner.

## Existing owners and immutable envelope

ApprovalGate fingerprints `request.action`, not arbitrary request siblings. Put the
complete witness inside a reserved `agentbrowser.native-form-review.v1` action with
pageId and parameters `{action, source, witness}`. The source includes its contract
ID/version, a stable permission-owner incarnation ID and captured permission generation.
The owner ID is trusted deployment configuration, unique for that permission owner's
lifetime and changed when the source/permission owner is replaced; contract names and
generation numbers alone cannot distinguish two owners. The intended action remains bounded
JSON supplied by trusted composition; the fixture uses draft intent, never submit.
The existing gate owns challenge/approve/deny/expire/single consumption and private
operator projection. No parallel token map, fingerprint algorithm or lifecycle.

Reuse the canonical JSON helper to detach the entire request and review context
under one budget, including action, source metadata and complete witness. Capture
configuration and callbacks before awaits; mutation or callback replacement cannot
repoint an admitted operation. Check disclosure on the whole action, including keys.
Static errors contain no private field values, filenames, callback text or causes.

## Service and evidence authority

`prepareEvidenceReviewInScope(sessionId,pageId,{action,source})` is internal trusted
composition. Require an operator-reviewed session and current stable operator admission.
Reuse the native prepared reader's exact session/page/admission ownership fence without
performing an extra browser read. Pin the existing review context and recheck it for
every operation. Capture a fresh prepared source for each admission; never store its
callbacks inside a token or carry admission-bound readers across requests.

The trusted source provides its owner ID, a contract, an existing EvidencePermission and synchronous
authorization assertion, and a collector. Factor the existing permission guard to
return its captured generation as well as its sticky assertion; do not copy its
validation algorithm. The permission owner must monotonically increment generation
on every policy change, including revoke/regrant. A new admission with identical
answers but a different generation cannot inspect, approve or consume an old token.
The service and source guards run before/after callbacks, snapshots and awaits,
including failure paths. Observed owner/source revocation is sticky for a prepared
handle; per-call cancellation alone does not poison a later call in the same admission.
Track the entire asynchronous collector through the existing read-drain owner, not
only the nested app/native reads. Pre-cancellation refuses before collection.

## Lifecycle and bounded claim

Generate collects a fresh qualified witness, checks the complete private envelope
and creates a pending reviewed token. Inspect and decide require current source
permission, matching source/action/page binding and safe disclosure before returning
stored private evidence or deciding. Approval refers to that stored snapshot;
consumption must recollect and compare the fresh complete envelope through the
existing atomic gate. Missing/failed evidence never falls back to action-only consent.
Exactly one matching approved consumption succeeds. If authority is lost after a
burn, do not restore consent or dispatch an effect.

Existing public approval inspection and decisions refuse reserved internal records.
Ordinary actions cannot match this reserved fingerprint. Public integration needs its
own source selection/disclosure design; merely knowing a token is not authorization.
Successful internal consumption is a lifecycle result, not a submit permission.
The collector is trusted deployment code; the named fixture supplies independent
app/native validation. This does not establish arbitrary ATS or hostile-page safety.

## Failing-first qualification and continuation

Test complete-envelope drift, config mutation across awaits, source generation changes
across admissions, authorization loss during inspection/decision/collection, private
diagnostics, aggregate bounds, secret values and keys, expiry, denial, concurrency and
wrong page/session/source/action. Pin the public exclusion and unchanged action-only
approval behavior. Drive separate-admission generate/inspect/approve/consume against
the real synthetic Chromium fixture with zero submission attempts and no extra action
dispatch. A post-review change accepted independently by both app and UI must still
refuse the previous approval; broken UI agreement must refuse collection altogether.

Deliver through normal hooks, exact-head independent review, PR and post-merge CI.
Keep published 1.9.1 unchanged. Public evidence-review integration and C3 app-owned
atomic compare-and-submit/independent acceptance remain follow-ups; T5 owns durability.
No finite milestone becomes complete solely because this internal slice passes.
