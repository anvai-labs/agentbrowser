# C2b: authorized read sources and named draft validation

Base: develop `c8f896a` (#244). This increment composes prepared application reads
with the existing evidence registry and validates the synthetic draft's full data
contract. It does not yet collect a page witness, bind consent or submit anything.
Load with forms/T6 and application/T4 only. Published 1.9.1 stays unchanged.

## Shared production seam

Add `defineApplicationReadEvidenceSource` beside the receipt-source factory. Trusted
deployment configuration selects the source ID/capability and `{operation,input}`;
capture bounded detached configuration once, before callers can mutate it. The
existing service provider exposes `applicationRead` using its own ApplicationAuthority.
No new registry, ledger, executor, route, CLI command or MCP tool is needed.

Authorization and correlation are mandatory. Policy sees the captured authority
identity (including read operation), source, verifier and correlation ID, never a
raw context or authority capability. The existing registry validates verifier input;
deployment policy must explicitly allow its intended verifier/version/input. A
caller-selected verifier or syntactically valid correlation ID is not qualification.
Capture session selection when authorizing; subsequent reads ignore mutable context.

Reuse prepared reads for admission, binding, incarnation, cancellation, draining,
bounded finite JSON and sanitized adapter errors. Reuse the permission guard for
sticky revocation. Check authority/permission around callbacks, awaits and metadata
inspection. Read values are ready evidence, including null; invalid undefined is
refused by prepared reads. Receipt sources retain their existing pending semantics.
Read evidence and opaque reference arrays are detached before returning them; a
reference callback cannot rewrite the evidence. Neither factory asserts completeness.

## Named contract qualification in test support

Use the existing independent application-draft owner; do not introduce a production
job schema or a duplicate owner. A test-support validator independently checks the
entire bounded snapshot against trusted pinned draft ID/incarnation, job, destination
and intent, plus an expected version supplied by the trusted test collector. Exact
keys are required at every level. Contract ID/version, monotonic
version type, all required/optional/conditional/hidden/repeated fields, committed
native enum values and attachment ID/name/type/size/SHA-256 are explicit. Unknown,
omitted, malformed, incomplete or forged completeness data refuses with static errors.
Derive completeness from fields; never trust `complete:true` or `missing:[]` alone.
Pinning that version is a comparison, not independent proof of freshness. A valid
digest shape likewise relies on the authorized application owner for byte provenance.
Use the shared canonical JSON owner for detachment and aggregate bounds. Private
answers remain private values: their hashes are not anonymization.

Tests collect through the real service provider and TrustedEvidenceSourceRegistry
under one existing admission. A deployment-selected policy pins source, capability,
verifier, correlation and authority identity. The validator then pins business and
draft identity. Another draft with identical answers refuses. Recheck authorization
after validation. Mutating caller context/configuration must not select another draft.
No synthetic test helper becomes a new public runtime capability.

## Remaining page and consent gates

This is data-contract qualification only. The next collector must pin the expected
origin/path and live page/document identity through a trusted app/page association;
matching answers and cooperative DOM status are insufficient. Read app version A,
observe qualified live controls and commit status, then read app version B; require
stable document/incarnation/version, no pending/failed writes, and exact field/file
agreement. Navigation, document replacement, broken handlers, stale uploads and
same-size file replacement must refuse. Capture context privately before awaits.

Then bound the aggregate action-plus-evidence review envelope and compare fresh
evidence before ApprovalGate consumption. C3 separately requires app-owned atomic
compare-and-submit plus independent acceptance; these reads are not an atomic fence
against later dispatch. T5 owns process-loss recovery. Unsupported ATS/custom widgets
remain unqualified; no live application or new release is authorized by this slice.

## Delivery gates

Failing-first focused tests for source composition, malformed envelopes, identity
substitution, immutable configuration/context, revoked authority and callback errors;
retain receipt regressions. Run mandatory hooks and independent adversarial review,
then one ready PR to develop, all required CI green, normal merge and post-merge CI.
Keep milestone estimates unchanged until the complete user-facing gates pass.
