# C3b: mandatory application submission consent

Base: develop `9c82a49` (#251). This is the internal enforcement increment after
[C3a](t6-atomic-submission.md). It does not register a production submit operation,
add public review creation, or qualify a live ATS. C3c owns public discovery/CLI
usability and independent end-to-end acceptance. Published 1.9.1 is unchanged.

## Trust and ownership

ApplicationAuthority remains the only application executor. An immutable operation
registration may declare `review: 'operator-submit'`; only write operations may do
so. The caller cannot choose or disable this requirement. Unknown declarations and
protected reads fail at registration. `defineApplicationOperation` and authority
registration both capture the declaration alongside their existing callbacks.

An optional constructor option `consentPolicy` supplies trusted host composition.
Absent policy refuses protected execution. The service always supplies its internal
composition; an absent evidence provider/source still refuses. Ordinary operations
retain their behavior, and browser-free hosts need no browser or approval package.
A trusted host can implement policy; this is not a sandbox against malicious host
code or a proof that an operator credential corresponds to a present human.

## Internal contracts

Extend internal `ApplicationRequest` with optional `approvalToken`. It is a bounded
nonempty string of at most 128 characters. It is a credential, not business input.
Ordinary operations refuse this field rather than silently ignoring it. Public
protocol/REST/SDK/CLI schemas remain unchanged until C3c; an unknown wire field is
not a new supported interface. Successful service-policy qualification uses test-only
typed access to its private ApplicationAuthority, not a new production execute
wrapper. Public applicationExecute/REST cannot submit protected operations in C3b.

Use one private normalizer for execution and intended-operation review. Read the
complete request through own data descriptors, refuse accessors/symbols/hidden or
unknown keys, detach JSON input with existing snapshot limits and canonical JSON,
and preserve optional undefined fields as absent. Normalize before binding lookup;
never read the caller's request again while building scope or fingerprint. Invalid
input refuses with static INVALID_REQUEST, without preparation, dispatch or private
error text. Existing input budget and operation ID/version constraints remain.

The authority derives this bounded, deeply frozen intended action:

```ts
{
  type: 'application-submit', intent: 'submit',
  tenant, sessionId, sessionIncarnation,
  adapter, resource, bindingGeneration,
  operation, operationId, expectedVersion, input
}
```

The complete business snapshot (including app incarnation, destination, job, answers
and received-file identity) belongs in the qualified operation input and source
witness. The authority never infers it from arbitrary web page content. Missing
qualified evidence refuses in the host policy. Use the existing serializer/limits;
the extra envelope overhead may cause a protected request to exceed its review
budget and refuse. Do not expand limits or expose private errors.

```ts
interface PreparedApplicationOperationReview {
  readonly sessionId: string;
  readonly action: Readonly<Record<string, unknown>>;
  assertCurrent(): void;
}
interface PreparedApplicationConsent {
  consume(): Promise<boolean>;
  assertCurrent(): void;
}
type ApplicationConsentPolicy = (
  review: PreparedApplicationOperationReview,
  approvalToken: string
) => PreparedApplicationConsent;
```

The policy factory is strictly synchronous. Capture its two methods once from an
exact own-data result; reject promises, accessors, extra fields and malformed
returns. `consume` accepts only literal true as success. `assertCurrent` is a strict
synchronous void guard; async/false/throwing guards deny without private diagnostics.
The handle is local to the admission and never returned as an execution permit.

## Review before execution

`prepareOperationReviewInScope(sessionId, plannedRequest)` requires an existing
stable HUMAN_ACTIVE operator admission. The planned request supplies the future
operation ID/version/input and no approval token. It normalizes and captures the
registered protected operation and exact binding using the same helpers as execute,
then returns its action and a sticky admission/binding guard. It creates no operation
record and invokes neither operation.prepare nor execute.

The API service adds only an internal composition method,
`prepareApplicationSubmissionReviewInScope(sessionId, pageId, plannedRequest, source)`.
It combines that guard with the existing native-page/review-context guard and
PreparedEvidenceReview.generate. Review and decision occur in separate read
admissions before the later execution admission. No prepared handle survives its
admission; only the existing approval token persists.

## Execution sequence and shared composition

1. Normalize once; capture registered operation/binding; construct the existing
   canonical operation fingerprint. Include the approval-token identity for a
   protected write, so a changed token under the same operation ID conflicts.
   Exclude the token from the intended action to avoid circular approval identity.
2. Enter the existing authority.run exactly once. Require the admitted operator's
   HUMAN_ACTIVE review binding for protected execution, pin the exact application
   binding, and build the same intended action. Ordinary reads/writes keep the
   established path and fingerprint vocabulary.
3. Perform existing synchronous operation preparation with a deeply frozen protected
   input snapshot. Ordinary preparation remains mutable. Trusted parsers can still
   construct transformed output; semantic fidelity requires adapter qualification. Recheck the original app
   owner after every host callback, including throwing callbacks. Invoke the
   captured policy factory inside the same admission; missing policy/token refuses.
4. The service resolves the token through the C2d resolver. Add an optional expected
   intended action to that shared resolver and require exact canonical equality
   with the independently configured action before consumption. A token matching
   some other valid provider action must never authorize this execution. Legacy
   action tokens and draft-intent tokens refuse protected submission.
5. Reuse PreparedEvidenceReview.consume: freshly collect bounded witness, compare
   the complete token/context/source/action fingerprint and atomically consume once.
   Preserve permission-generation checks, sticky revocation, secret-disclosure
   refusal, cancellation and read-drain behavior. No token/witness store is added.
6. After awaiting consumption, recheck app authority/authorization, then the pinned
   consent/page/source owners. Add `assertCurrent(signal)` to PreparedEvidenceReview
   using its existing sticky guard, and compose it with the original application
   guard. Recheck permission generation after all source/host callbacks, then use
   the resolver's captured callback-free page/context pin so a permission callback
   cannot replace the page unnoticed. Perform callback-free admission/binding checks after the final evidence guard.
   Mark dispatch and immediately invoke
   the captured executor, without another await or callback between those two steps.

Use the existing private service evidence-review preparation helper for both native
review and application review; add an optional internal owner guard to that common
composition rather than copying its context/page/secret/drain logic. C2d's provider
invocation and result validation remain in one resolver, reused by public get/decide
and the internal submission policy. The expected execution action is not sent to
the provider; provider context remains the existing bounded public-safe selector.

A guard is necessary after consumption because intervening awaited continuations or
callbacks can revoke permission, replace a page or change a binding. A consumed
boolean alone is not authority. The cooperative app's atomic compare-and-submit is
still necessary: its state may change independently after the service's last read.

## Replay, errors and unsupported states

Predispatch refusal is a failed, undispatched existing operation record where
admission has already started. It does not restore a consumed token. A fresh
attempt/token uses a new operation ID. Exact replay returns existing status only,
without collecting evidence or resubmitting; changing token/input/version/identity
conflicts. Current principal authentication still precedes status replay.

Known app rejection remains rejected/failed with consumed consent. A thrown or lost
post-dispatch response remains outcome_unknown and requires existing operation
status plus independently authorized app receipt reconciliation. No hidden retry,
consent revival or durable recovery is added; persistence remains T5.

Only an admitted operator with stable HUMAN_ACTIVE review context is supported.
Delegation/takeover/rebinding/re-registration invalidates relevant context. No
agent fallback, token-derived context, or implicit transfer from draft approval.
Public submission creation and live portal use remain unavailable in this slice.

## Failing-first acceptance tasks

- Registration and request boundary: missing/invalid/async policy, protected read,
  mutated declaration/callback, getters/hidden/symbol keys, request mutation during
  callbacks, proxy-triggered rebinding before capture, ordinary operations unchanged.
- Separate generation/decision/execution admissions; no preparation, effect or
  operation record during review generation; escaped handles refuse.
- Pending/denied/expired/used/missing/legacy/draft consent; wrong operation, ID,
  version, input, tenant, incarnation, app binding or page; each refuses before
  dispatch. Provider action matching token but differing from actual execution must
  be explicitly falsified.
- Source revoke/regrant, binding replacement, page replacement, cancellation and
  callback/async races before and after consumption; zero dispatch on refusal and
  existing admission retained while reads drain.
- Competing consumers and exact replay: one app acceptance, no repeated evidence
  collection/effect on status replay, changed token conflicts. Failed attempts do
  not silently become new executions.
- Service integration uses C3a's complete synthetic owner and private accepted-byte
  counter/receipt oracle. Register submit only in the test adapter with mandatory
  protection; derive owner operationId from ApplicationScope. Known CAS rejection
  and lost-return reconciliation remain distinguishable from accepted outcomes.
- Existing public get/decide, application and ordinary operation suites stay green.
  No public submit projection, new package, CI job, parallel ledger or executor.

Design review precedes implementation. Then run focused red/green tests, normal
hooks, independent exact-head review, one ready PR candidate and green PR/post-merge
checks. Preserve the parallel checkout, logged-in browser sessions and release.

Independent design review against `9c82a49`: SHIP, before implementation. The
review required the internal transport boundary and final callback ordering above.
