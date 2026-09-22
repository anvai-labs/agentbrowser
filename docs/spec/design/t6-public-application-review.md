# C3c: public application review and accepted-receipt qualification

Base: develop `74bda24` after C3b (#254) and error handling (#253). Align the
implementation with independently reviewed #255 before delivery. Load forms/T6 and
application/T4 context only. Published 1.9.1 and installed sessions are unchanged.

Implementation alignment: #255 was merged by the parallel session; subsequent
adversarial containment fixes landed separately as #256 (`5bdb89f`) with green PR
and post-merge CI. The implementation includes that merge without dropping #255.

## Goal and boundaries

An operator can create a complete application review, inspect it, approve it, and
execute its exact planned operation through REST/SDK/CLI. Each phase owns a separate
admission. ApplicationAuthority and ApprovalGate remain the sole execution and
consent owners. MCP is optional. Only the existing synthetic cooperative adapter is
qualified; no default submit registration, live ATS permission or production source
configuration is implied.

C3b already enforces protected dispatch, fresh evidence and atomic token consumption.
Do not add another submit wrapper, admission loop, token store, callback registry,
operation ledger, browser driver or retry engine. Reuse current source callbacks,
bounded snapshots, command wire declarations and receipt verifier contracts.

## Public-safe operation routing

The stored native review already contains an authority-derived inner action with
`type: application-submit`, `intent: submit`, tenant/session incarnation, adapter,
resource, binding generation, operation, operation ID, expected version and input.
Derive a bounded optional `application` selector from its existing own-data fields:

```ts
{ adapter, resource, bindingGeneration, operation, operationId, expectedVersion }
```

No input, witness, token ID, action digest or private content reaches configuration.
Use a single strict extractor for creation and stored-review resolution. Validate
complete reserved action shape and identifiers; malformed reserved application
routing refuses rather than becoming legacy routing. Ordinary evidence actions keep
existing behavior. No stored-envelope, source-owner or fingerprint change is needed.

Extend ServiceEvidenceReviewRequest with this optional selector. Existing providers
remain compatible; application-aware providers independently reconstruct their
qualified intended action using operation identity and app-owned state. Two planned
operations may share one real permission owner. Never fabricate a permission owner
per token or use a token-to-action lookup ledger. Provider selection does not grant
permission: fresh source authorization, owner generation and action equality remain
mandatory.

## Public creation and trusted source hints

Add `POST /v1/sessions/:sessionId/application/reviews` and SDK
`sessions.applicationReview(sessionId, body)`. The strict bounded body is:

```ts
{
  pageId,
  source: { ownerId, contract: { id, version } },
  request: { operation, input, operationId, expectedVersion }
}
```

`source` is an untrusted lookup hint for trusted deployment configuration, never a
permission, witness, collector, executable callback or source registration. It uses
the existing source selector vocabulary; the host must recognize it and authorize
its exact tenant/page/application context. Unknown, foreign or mismatched selectors
fail closed. The returned source must match the hint; returning a different owner or
contract is refusal. Providers remain absent by default. This first usable embedding
contract expects source hints from deployment configuration; automatic source catalog
UX is a later demand-backed extension, not a fabricated capability.

Creation has exactly one operator HUMAN_ACTIVE admission under SessionAuthority.run
without a write operation ID. It requires the session's existing reviewed-approval
policy. Validate and detach the whole request before any provider callback. Capture
the application planned-review guard and native page/context guard before selection;
recheck them after synchronous provider invocation, result capture, evidence
collection and on failure. Reject promises/accessors/unknown provider result fields.
After the final asynchronous collection, perform host callbacks before the final
evidence-permission check, then finish with callback-free captured application,
page and context checks. No host callback may revoke a previously checked owner
immediately before the private view is returned.

Extract the provider capture/validation into one private service composition helper
shared with resolveApproval. Creation supplies authority-derived intended action and
requires exact canonical equality with independently configured provider action
before generate. Reuse prepareBoundEvidenceReview and PreparedEvidenceReview.generate;
no operation prepare/execute callback runs and the future operation ID is not reserved.
Missing provider, ordinary operation, stale binding, mismatched action and revoked
source all refuse with static errors and zero application dispatch.

The creation response uses existing OperatorApprovalViewSchema/parser. JSON contains
private reviewed data; text is status/token identity only. Inspection and decisions
reuse existing session approval and approval-decide endpoints/commands. Decisions
remain explicit and cannot be supplied in the creation body.

Creation is deliberately non-idempotent token allocation, not application execution.
A lost creation response may leave an inaccessible pending token until normal expiry.
A caller can explicitly create a fresh pending review; neither allocation approves
anything or reserves/dispatches the future operation. No automatic retry or token
revival is added. Reject execution-operation headers on the creation route and reject
CLI global --operation-id for review creation; the future ID belongs inside request.
Test two allocations, lost response, pending status and zero execution records/effects.

## Existing execution and CLI projection

Extend ApplicationOperationDescriptorSchema with optional literal
`review: operator-submit`; project only captured immutable declarations. Ordinary
operation descriptors remain byte-equivalent. Add the same bounded optional
approvalToken to ApplicationExecuteRequestSchema that the internal authority already
uses. Existing applicationExecute service validation, SDK parser and ApplicationAuthority
execute remain the only execution path. Ordinary operations still refuse tokens.

Add `application review <sessionId> <reviewJson>` using readCommandJson, supporting
inline JSON, @file and stdin through that common reader. Advertise the canonical
input/output schema at command definition. Add `--approval-token` to existing
application execute; make help explicit that it consumes consent and does not grant
it. Discovery text names the review requirement. CLI default text must not echo
reviewed private data; --json retains the existing explicit private-output contract.

Extend existing SDK/CLI compiled interface gates, route registration metadata,
OpenAPI freshness/parity and command JSON audit. The creation route self-admits and
refuses delegated actors; it does not mint a new delegated application capability.
Reuse the existing self-admitting application path segment and test header behavior.
No MCP dependency or mandatory new tool catalog is introduced.

## Independent acceptance and uncertain outcomes

Extend the real Chromium draft/witness fixture rather than create a second app.
Drive create -> inspect -> approve -> execute using compiled CLI against the actual
HTTP service. Test-only trusted configuration registers the existing protected submit
operation. Verify one complete acceptance including original received file bytes with
an independent app-owned receipt; the execution return is not its own oracle.

Use existing runVerifiedOutcome/TrustedVerifierRegistry/TrustedEvidenceSourceRegistry
and defineVerifier outside SessionAuthority admission. Its execution callback drives
the real application CLI, and its independently authorized receipt source calls the
existing SDK/REST receipt lookup. Report testedSeam: application (CLI/HTTP is the transport). The service executeOutcome
surface is UI-plan-only: do not issue a dummy browser plan or relabel that surface to
claim application qualification. No public receipt-only verifier endpoint is added.

A lost execution response remains execution unknown under current T2 semantics.
Perform a separate freshly authorized receipt read and evaluate it with the same
named verifier to record reconciliation evidence, without changing the original
unknown execution or repeating effects. Reject wrong operation/draft incarnation,
destination, accepted payload/file identity and version. Process-loss recovery remains
T5. A raw receipt lookup alone is not a passing named verification contract.

## Agent implementation packets and TDD

1. Routing/contracts: strict application selector extraction, existing-source
   compatibility, same owner/two operations, metadata detachment; immutable discovery
   declaration and bounded credential schemas. No new public source authority.
2. Shared service creation/resolution: failing-first tests for malformed/foreign hints,
   absent/async/malformed providers, action mismatch, missing review policy, delegated
   callers, session/page/binding replacement, source revoke/regrant, cancellation/drain,
   and callbacks that throw after changing owners. Include lost creation and no future
   execution reservation. Reuse C3b races rather than copy the whole suite.
3. Public REST/SDK/CLI: body and response parsing, header refusal, schema/route parity,
   private output behavior, file/stdin input, ordinary operation compatibility and
   status-only execution replay. Keep all discovery declarations in existing owners.
4. Real-surface qualification: separate public admissions, one accepted full payload,
   answer/hidden value/file drift refusal, two planned IDs under one source owner,
   exact replay without fresh consumption, lost-return independent reconciliation.
   Use the existing native/app collector and owner, with named T2 evidence.
5. Align #255 without modifying its parallel checkout. Focused red/green locally,
   normal hooks, independent exact-head review, one ready PR candidate, green PR and
   post-merge CI, verified merge/tree/ancestry. No extra workflow or runner matrix.

Design review precedes implementation. Packet boundaries may be separate reviewed
commits/PRs if needed, but source routing alone is not public usability and public
transports alone are not accepted-receipt qualification. Report those steps separately.
T4/T6 remain active until production source, eligibility and live workflow gates pass.

Independent design review: SHIP before implementation. Source capture, malformed reserved
routing refusal, admission guards and distinct lost-write reconciliation remain mandatory.
The existing testedSeam enum uses application, not api; no new outcome literal is added.
