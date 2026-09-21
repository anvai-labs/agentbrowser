# C2a: independent application draft oracle

Base: develop `d5cef8c` (#242). This slice qualifies one synthetic application
contract for T6 and the independent UI/API parity seam in T4. It adds test support,
not a production profile store or a public submission endpoint. C2b must still bind
service-collected payload evidence to review; C3 must qualify dispatch and acceptance.

## Contract and owner

One test-only owner holds a draft incarnation, monotonically increasing version,
fixed contract identity, business/job identity, destination and draft-only intent.
Separate draft instances support UI and application-interface runs. Both interfaces
call the same owner; assertions inspect its detached state independently of service
receipts. Use existing ApplicationAuthority operations/admission and canonical JSON
bounds. Do not create a second executor, registry or operation ledger.

The named contract includes full name, current and previous company (repeated UI
labels with distinct identities), committed work preference, conditional relocation
answer for hybrid work, optional referral, required terms acknowledgement and a
fixed hidden source field. Unknown keys and invalid types refuse. Empty required
answers prevent completeness. The qualified controls are native inputs/select/checkbox.
Custom widgets and manual-required controls are excluded from this named contract
and require separate qualification. Completeness is computed by the owner,
never accepted from a caller's `complete`, digest or version assertion.

An attachment includes application-assigned identity, name, media type, size and
SHA-256 computed from bytes actually received by the fixture. Synthetic PDF uploads
are bounded to 32 KiB on both paths, fitting the existing 64 KiB JSON envelope
after base64 expansion; this is not PDF validity or malware verification. No browser
reported hash establishes evidence. UI uploads send raw bytes; the bounded JSON
application operation may carry canonical base64 decoded before calling the same
byte owner. Private bytes and values never enter refusal diagnostics.

## Atomicity and delayed writes

Every mutation compares expectedVersion against the current owner version and
commits the resulting state plus a new version synchronously. Reads return one
detached snapshot. Snapshot identity includes contract version and draft incarnation.
Stale writes leave state unchanged. Removal increments the version even when no
attachment is currently present, fencing an upload still in flight. Oversized,
interrupted or malformed uploads cannot partially commit state or increment version.

The UI records pending/failed field and upload requests. Server completeness alone
cannot establish that visible edits have committed. UI parity requires zero pending
requests, no failed commits, matching committed version and values. Deliberately
break a UI handler: UI parity must fail while equivalent application mutations still
qualify. Do not infer arbitrary page/network equivalence from this cooperative fixture.

## Surfaces and access

Use existing application bind/discover/execute/read surfaces with injected trusted
adapter configuration. The adapter authorizes tenant/resource and exposes draft
mutations and a read operation; it exposes no submit operation. Existing operation
identity/replay applies to application writes. The fixture's raw upload transport
collects bounded bytes before calling the owner. Submission routes refuse; the owner has no submitted state or submit mutation.
Count attempted submission requests to prove the refusal path ran. No live portal sessions are used.

## Failing-first delivery

1. Unit tests: detached snapshots, conditional completeness, unknown/forged fields,
   stale versions, same-size attachment changes, delayed upload versus removal,
   bounded/malformed bytes and immutable identity.
2. Application projection: authenticated reads/writes, foreign binding refusal,
   version conflict, operation replay and no submit operation. Reuse existing
   authority tests for revocation; add cases when this fixture introduces new awaits.
3. Real Chromium plus compiled CLI: fill/upload through UI, equivalent isolated
   draft through application CLI, compare owner state and separately report path
   outcomes. Include a broken-UI negative control and pending/failure detection.
4. Focused local tests, required hooks, independent exact-head adversarial review,
   one PR candidate, all PR and post-merge CI green. No new CI job or release.

This does not complete T4/T6, qualify durable recovery, or authorize a live application.
