# T4/P0: trusted evidence composition without exposing the service

Status: P0a/P0b implemented in the current develop candidate, based on the approved
design in #258 (`54daeaa`). See [qualification evidence](../evidence/t4-production-evidence-composition.md).
P0c/P1 remain gated; no production adapter, startup loader or live-site capability is shipped.
Read application/T4 context and this packet; load the job eligibility packet only
when that application needs it. Published 1.9.1 is unchanged.

## Proven gap and decision

C3c exposes review -> inspect -> approve -> execute through public CLI/SDK/REST,
but its paired browser/application witness is composed inside a test. The original
`packages/api/src/application-witness-real-chromium.test.ts` used a prototype spy to
capture the service created privately by `buildServer`, then called
`prepareNativeFormReadInScope`. P0 replaces that unsupported composition seam.

Extend the existing trusted review-provider callback with one frozen, admission-owned
read context, always passed as the required second parameter in the callback type
(existing single-argument implementations still satisfy it). Do not add a second provider registry, service accessor, authority,
executor, transport, general plugin loader, source-discovery API or workflow engine.
The first callback argument remains the existing bounded identity/routing snapshot.
Existing single-argument providers remain compatible. Implemented second argument:

```ts
interface ServiceEvidenceReviewContext {
  readonly nativeForm: PreparedNativeFormRead;
}
// evidenceReviewProvider(request, context) -> existing configured action/source
```

This is an embedding interface, not a wire schema. Requests cannot supply the context,
replace its reader, choose another page/session, install a collector or grant access.
It contains no raw page, engine, service, session authority, cookies or execution port.
Returning a source still requires the existing captured permission and independent
intended-action comparison. A source hint remains a lookup hint, not permission.

## Reuse and lifecycle

`prepareConfiguredEvidenceReview` already captures the native reader for the selected
page before provider invocation. Expose that same captured handle, with a frozen
read-only facade if the current return value is not already frozen. No second native
read or browser callback is needed merely to prepare the context. Keep the same
`PreparedNativeFormRead` type and implementation; do not clone its guard logic.

The callback remains synchronous and may return an asynchronous source collector.
Creating the context performs no native evidence collection. The intended composition
reads inside `source.collect(signal)`, retaining the existing tracked-read/drain owner.
The reader grants only the trusted host's admission-scoped observation; it does not
grant source permission, completeness qualification or disclosure. If trusted provider
code starts a read during selection, it must still be tracked, cancellable and drained;
its result cannot bypass the later source permission and witness checks. Do not add a
second collection-phase state machine merely to expose this existing reader.

Creation, inspection, decision and consumption each resolve a fresh context within
their existing SessionAuthority admission. It is never retained as a cross-admission
reader. Provider return does not expire the handle: its collector runs later in the
same admission. The native handle rejects use after admission closure, cancellation,
page/engine replacement or session incarnation change, including same-ID recreation.
Native reader ownership does not itself pin a document or application binding:
navigation/document drift is rejected by the qualified witness; rebinding is rejected
by application/review composition guards. Preserve that division of owners rather
than copying those guards into the reader. After dispatch uncertainty there is no retry.

Recheck captured application/page/context after provider invocation, source capture,
read completion and throwing callbacks. Preserve C3c's final ordering: host callbacks,
then evidence permission, then callback-free ownership checks. Capture source methods
once through `captureEvidenceReviewSource`; keep sticky permission revocation.
Use the existing lifecycle signal, `trackReadInScope` and cancellation/drain behavior.
If a narrowly guarded facade is necessary, it wraps the existing prepared reader; it
must not implement another observer, timeout manager, admission lock or read registry.

Paired application evidence continues through `ServiceEvidenceSourceBuilder.applicationRead`
and `TrustedEvidenceSourceRegistry`. Outcome receipts continue through
`applicationReceipt` and `applicationReceiptOutcomeOptions`. The latter already derives
source metadata from the named verifier; extend its composition only for a demonstrated
consumer instead of copying its registry/authorization construction. A deployment
combining draft and receipt sources supplies one registry factory, respecting existing
mutual exclusion with a prebuilt registry. Do not replace the UI-only `executeOutcome`
with an application runner: application qualification composes existing T2 externally.

## Trusted deployment record

One application owner supplies the following bounded, versioned configuration. This
is a design inventory, not a new generic JSON plugin format or runtime schema.

| Item | Owner and enforcement |
| --- | --- |
| Adapter and operations | Trusted host code; captured declarations, existing ApplicationAuthority |
| Account/resource/job identity | App-owned stable identity and version; session binding must match |
| Review source hint | Host-provisioned opaque owner/contract; provider checks exact equality |
| Permission owner | Current app authorization plus owner incarnation/generation; revoke/regrant cannot revive an old handle |
| Draft witness | Named app-owned validator plus scoped native evidence; complete fields and received attachment identity |
| Accepted receipt | Independent read with operation, tenant/resource, job, payload/file and accepted-version correlation |
| Verifier contract | Named versioned predicate with required evidence, budgets and truthful grounding layer |
| Operational budget | Existing bounded readers, request limits, deadlines/drain and retention limits |

Absent, stale, foreign, mismatched or asynchronously misconfigured components fail
closed. Do not serialize credentials, collectors or raw private payloads in descriptors.
Configuration owns a private credential source; the CLI receives only its existing
service authentication and host-provisioned source hint. Page content cannot revise
policy. No per-token fabricated source owner or token-to-action lookup cache.

The stock `packages/api/src/bin.ts` currently registers engines, telemetry and timeout
configuration, not application adapters or evidence providers. First qualify an explicit
application-owned embedding that calls existing `startServer`/`buildServer`. The CLI
can use that service over its normal authenticated origin; MCP remains optional.
Stock Homebrew startup does not acquire these capabilities by reading this spec.
A stock executable loader needs a separate demand-backed design covering trusted file
ownership, code provenance, credentials, failure behavior and lifecycle. No dynamic
module path or executable code from agent requests, environment shortcuts or remote URLs.

## Agent packets and failing-first acceptance

| Packet | Scope / reused owner | Required evidence and stop |
| --- | --- | --- |
| P0a | Second provider argument using the existing admission-scoped reader | Existing provider compatibility; frozen matching identity; no eager native collection; early host reads still drain; foreign/caller IDs cannot retarget it; no raw service exported |
| P0b | Rewire existing Chromium qualification through trusted `buildServer` options | Remove prototype service capture for witness composition; public CLI create/inspect/approve/execute, named independent receipt; no fixture-only registration in stock startup |
| P0c | Application-owned deployment example using existing receipt composition | Start through public embedding with explicit host configuration; absent/mismatched configuration refuses; no test-support imports in production example |
| P1 | One real application's witness/receipt contract, only with authorized documented interfaces | Account/job/payload/receipt qualification, installed CLI/service and private evidence; otherwise remain draft/manual |

P0a falsifiers include retained handle used in a later admission, suspended read plus
takeover/close, recreated session/page, application rebinding during native capture,
source revocation on final callbacks, and throwing callbacks after owner replacement.
Reads must drain before writer admission; malformed evidence cannot become approval.
Reuse existing tests/fixtures and factor shared setup only when both paths need it.
Never prove independence by comparing two projections of the same execution return.

P0b should replace the spy for production witness composition rather than append a
second giant fixture. Internal-owner unit tests may still inspect their own object;
public qualification cannot depend on private service access. Assert zero dispatch
for denied reads and changed visible/hidden/file evidence, exact replay without new
consumption, and separate reconciliation preserving an unknown original execution.

P0c cannot ship a fake production adapter built from the synthetic draft fixture.
If no real application owner/interface is selected, document that gate and deliver
P0a/P0b only. No private portal API, site-specific browser fork or guessed submit hook.
An arbitrary DOM check followed by click cannot guarantee atomic payload equivalence.

For each ready packet: adversarial design review, failing-first focused regressions,
normal hooks, one candidate PR to develop, exact-head review and existing green CI.
No new CI job or runtime dependency is planned. Do not increment full T4/T6 completion
or release 1.9.1. P0 is production-composable plumbing, not production ATS qualification.
