# C3a atomic synthetic application acceptance

Base: develop `c968280` (#248). See the [C3 design](../design/t6-atomic-submission.md).
This is an application-owner test oracle. It adds no public submit operation, service
consent policy, CLI command or runtime dependency. HTTP `/submit` still refuses and
the adapter still exposes only read/update/upload/remove.

## Implementation and falsifiers

Extend the existing draft owner rather than creating a second fixture. A direct
`submit(expectedVersion, command)` requires explicit submit intent and equality with
the complete current app-owned snapshot. Input is strictly detached through the
existing protocol snapshot and bounded canonical serializer before inspecting mutable
state. Comparison and acceptance contain no await or caller callback.

The owner keeps one terminal acceptance: app-generated submission ID, original
operation ID, tenant/resource, accepted draft incarnation/version and complete payload,
plus committed version. Exact original command/version replay returns the same receipt;
changed replay or a distinct operation cannot create a second acceptance. Later draft
edits refuse. The existing adapter receipt callback reads the owner record independently
of the submission return and refuses foreign/aborted scopes.

Uploads now retain their bounded detached bytes privately. Removal clears them;
acceptance transfers them into the terminal record. Test-only byte inspection returns
a copy and never changes stored bytes. Public acceptance receipts contain metadata and
digest, not raw bytes. This proves which received file was accepted, rather than trusting
a caller/browser digest or a service execution result.

Failing-first: the initial acceptance regression failed because `owner.submit` did not
exist. After implementation, 87 focused tests passed across submission-owner (47),
existing draft-owner (28), real Chromium draft parity (2), and actual witness/REST/SDK/
compiled CLI qualification (10). Falsifiers include every named field/file identity,
incomplete/forged state, stale/recreated owners, same-size replacement, bounded invalid
input, getters/symbols/hidden fields, synchronous proxy reentry, distinct concurrent
operations, exact/conflicting retry, loss of the returned result, detached receipts,
terminal edit refusal and unchanged HTTP/application submission denial.

## Boundaries and delivery

Direct test-owner methods hold owner authority, like existing update/upload/remove;
they do not claim service operator consent. Production callers cannot access this
excluded test-support module. The app-owned receipt is independently stored, but a
production source/receipt validator and service dispatch/consent composition remain
unqualified. No hostile-page, live ATS, process-restart or durable acceptance claim.

C3b must make consent mandatory on every path to any declared submit operation before
one is registered. C3c then qualifies public usability and independent outcomes through
real CLI/browser transport. Do not infer permission to submit from the oracle or from
an approved draft-intent review.

Required hooks, exact-head independent review and all PR/post-merge checks gate delivery;
immutable head/tree/run evidence belongs in the PR. Keep published 1.9.1 and live sessions
unchanged. T4/T6 remain active; finite milestone completion stays 3/9.
