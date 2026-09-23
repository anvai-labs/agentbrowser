# C2b read sources and named data validation

Base: develop `c8f896a` (#244). See the
[bounded design](../design/t6-application-read-evidence.md). This increment composes
authorized application data with existing evidence owners. It does not collect a
live page witness, bind full-payload consent or submit an application.

## Failing-first qualification

The read-source suite began with 20 failing tests for the missing composition helper.
Additional failing regressions covered revocation during failed reference processing
and direct-reader reference schema bypass. Final control coverage includes 32 new
source cases plus the existing prepared-read, receipt-evidence and authority suites.
The service builder began with two failures, then passed all 12 provider tests,
including a real service binding under one admission and refusal of another verifier.

The named data suite first failed on its missing validator; all 41 final cases pass.
It uses the existing C2a business owner, independently validates the bounded exact
envelope and derives completeness. It tests hidden/repeated/conditional fields,
unknown/omitted keys, false completeness claims, metadata and descriptor tricks.
The service-owned source integration pins deployment policy, ignores later context
mutation, refuses another incarnation with identical answers, reads changed equal-size
attachment bytes and refuses the old expected version. Permission revocation and
scope closure deny further reads; collection records no dispatch.

No new runtime dependency, public endpoint, CLI/MCP command, authority, ledger or
workflow executor. ApplicationAuthority owns reads; TrustedEvidenceSourceRegistry
owns authorization/correlation; existing permission, snapshot and reference-schema
helpers are reused. The synthetic validator remains test support and is not exported
as generic ATS qualification. Receipt pending semantics remain unchanged.

## Remaining acceptance

Trusted draft-to-page/document correlation and stable app/UI evidence collection
come next. A configured read proves neither live DOM identity nor UI commit agreement.
Version equality is not a freshness oracle and digest shape is not byte attestation.
Then add the bounded aggregate review envelope and fresh comparison before consent
consumption. C3 still owns atomic qualified dispatch and independent acceptance;
T5 owns restart recovery. Milestones T4/T6 remain active with unchanged estimates.

Normal hooks, independent exact-head review, one ready PR, required PR checks, normal
merge and post-merge CI gate delivery. Exact head/tree/run evidence belongs in the PR
and handoff once verified. Published 1.9.1 and existing services remain unchanged.
