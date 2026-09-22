# Foundation and use-case checkpoint — 2026-09-20

Rechecked published 1.9.1 at `310e01d43982824caac2c63ed8d98355e17efdce`
and develop `836cc65f8c6264971df5f2335bc7789aaf9b283e` (PR #259; alignment
rechecked 2026-09-22). C3c incorporates the merged #256 error-containment repair.
The [release ladder](release-1.9.1.md) includes Bun CLI/MCP artifacts,
Node 24 service qualification, Homebrew and develop back-sync. Existing browser
sessions were preserved; an upgraded installed binary does not prove every running
service was restarted. No new release is required for the next develop slice.

## Acceptance progress

Percentages below are coarse engineering estimates of each task's acceptance scope,
not measured code coverage, effort, elapsed time or market readiness. Status and
remaining gates take precedence. T9 recurs and is excluded from the finite count.

| Task | Status | Estimate | Remaining acceptance |
| --- | --- | ---: | --- |
| T0 contracts/discovery | Complete, released | 100% | Maintenance with each changed surface |
| T1 context/profiles | Active | ~80% | Installed harness consumption/qualification with T8 |
| T2 shared execution/verification | Complete, released | 100% | Production evidence belongs to T4; restart durability to T5 |
| T3 QA regression | Complete, released | 100% | Broader provisioning and demand-backed report adapters are follow-ups |
| T4 application operations/parity | Active | ~40% | Production UI/API oracle, binding UX and evidence; synthetic parity qualified; callback repair merged #236 |
| T5 durable recovery | Not started | 0% | Design, journal/recovery and process-loss qualification |
| T6 forms/operations | Active | ~40% | Production sources, candidate/job eligibility and live qualification; C3c public synthetic workflow merged #257 |
| T7 audit/security/bounty | Design/gated | 0% | Audit adapter; additional scope and parity gates for security modes |
| T8 installed harnesses | Not qualified | 0% | Actual installed Victor/Codex/Claude acceptance; registration is insufficient |
| T9 release hardening | Recurring | 100% of 1.9.1 checkpoint | Repeat per later release |

Exact milestone count: **3 of 9 finite tasks complete (33%)**. Counting all original
ten rows gives 30%, including recurring T9. No defensible effort-weighted overall
percentage is available. Partial estimates are intentionally not averaged.
Local `../codingagent` was clean at `68502d82d` when inspected. This updates the
inspection baseline, not the installed-harness qualification claim or its release.

## Incremental continuation and code owners

1. **T4 Q0a callback contracts (merged #236)**: extend ApplicationAuthority, synchronousResult and
   the protocol discovery validator. Falsify malformed authorization, mutable scope,
   reentrant session replacement and preparation-before-dispatch failures. See the
   [bounded design](../design/t4-application-callback-contracts.md). Deliver one reviewed
   PR to develop; keep 1.9.1 immutable. This does not close full T4.
2. **T6 owned-popup/readiness (merged #237)**: extend the existing strategy registry and engine
   fixtures. Qualify popup ownership, repeated labels/options, async readiness and
   focus purity. Reuse the existing autofill closed loop and receipts. Q0 commitment
   verification already shipped in 1.9.1; do not implement it again.
3. **T6 reusable mapping and job dogfood**: version mapping data, keep private values
   outside shared context, and consume existing CLI/REST autofill and verifier seams.
   Qualify an entire local application fixture before authorized live applications;
   require field receipts and independent completion evidence. Search and application
   approval policy remain distinct from form instrumentation.
4. **T4 independent UI/API parity**: both paths reach the same app-owned state oracle;
   break only the UI and require only its test to fail. Reuse the application port,
   receipt identity and T2 verifier composition. Qualify binding UX and production
   evidence separately; do not equate a browser action with an app commit.
5. **T8 harness qualification** can run alongside dependency-ready slices. Use existing
   CLI help/schema discovery and harness transport/projector; measure bounded context,
   cancellation, operation identity and cursor consumption. Repair proven gaps in the
   owning repo through its own PR/release gates.
6. **T5 durability and T7 audit/security** follow their packets and demand gates.
   Recovery must reuse operation identity and qualify restart ambiguity. Audit reuses
   T3 reports; active security modes additionally need T4 and qualified scope controls.
   Do not add an executor, scanner suite or persistent store merely to fill a mode.

Each slice starts with its mode/task context only, failing-first tests and an owner
reuse check. Reconcile the latest develop before branching; run focused tests locally,
then existing mandatory gates on one ready PR candidate. Merge only after green CI
and independent review, verify the actual merge and post-merge checks, and carry exact
evidence into the next checkpoint. Release later when a usable slice is qualified.

## Current bounded increment

PR #236, #237 and #238 each passed eight PR and eight post-merge checks with independent
review. Mapping #238 merged at `098d5ba`, with candidate
`8d1eb6442fe267aad5dd6df75c5e71f93f7c0021`, PR run `35558005447` and post-merge
run `35558255402`. The [mapping evidence](t6-form-mapping.md) remains scoped to
preparation and server preflight in the existing executor.

The [checked-upload/draft slice](../design/t6-verified-upload-draft.md), merged as PR #239, adds
one shared file-integrity helper and a synthetic compiled-CLI draft fixture; see
[local evidence](t6-verified-upload-draft.md). It corrects the earlier assumption
that action approval binds a complete application payload. Final submission stays
denied in this qualification. Do not count a draft as an accepted application or
increase the completed milestone count: T6 remains active and estimates stay conservative.

PR #239 candidate `c03cfaf29555368fc1d2667e482d51492bc54ce6` passed independent
review; PR run `35562728724` and post-merge run `35562976042` each passed all eight
jobs without reruns. Merge `f12ac89` retained the reviewed tree. Main is still the
published 1.9.1 commit above.

The next [consent sequence](../design/t6-reviewed-payload-consent.md) starts by
hardening ApprovalGate ownership and atomic consumption (C0), reusing the existing
bounded serializer. [Evidence](t6-approval-consumption.md) separates this implemented
foundation from future operator approval, complete payload witnesses and submission.

C0 merged as PR #240 at `4b9b155`, preserving reviewed head `744630c`'s
tree. PR run `35565250458` and post-merge run `35565613386` each passed all eight
jobs without reruns; independent review returned SHIP. The next
[C1 foundation](../design/t6-review-authority-binding.md) adds a control-review
version and authority-owned review binding, with captured-owner configuration cleanup.
It merged as #241 at `a57b143`, with PR run `35567615627` and post-merge
run `35567910796` each passing all eight jobs. That foundation alone adds no approval
surface. The [C1a implementation](../design/t6-operator-approval.md) now implements explicit
operator action decisions through REST/SDK/CLI, sharing the token owner, authority
and operation ledger. Complete payload consent and qualified submission remain pending;
milestone count and conservative estimates are unchanged.

C1a merged in #242 at `d5cef8c`, preserving reviewed head `8118754` and tree
`69818b4`. PR run `35570814721` and post-merge run `35571215331` passed all eight
jobs; independent review returned SHIP. The next [C2a draft oracle](../design/t6-draft-oracle.md)
qualifies a named application-owned draft and received attachment bytes through the
existing UI and application interfaces; see [evidence](t6-draft-oracle.md). This is
a test-only candidate, not full-payload consent. C2b witness binding and C3 submission
remain pending, and the milestone count/estimates remain unchanged.

C2a merged in #243 at `7f2e533`, retaining reviewed tree `27c3c96`. PR run
`35573168247` and post-merge run `35573557138` each passed all eight jobs; exact-head
independent review returned SHIP. The [C2b read foundation](../design/t6-scoped-application-read.md)
adds authorized in-admission application reads before witness binding; see
[evidence](t6-scoped-application-read.md). This does not complete full-payload consent
or T4/T6; milestone counts and conservative estimates stay unchanged.

C2b prepared reads merged in #244 at `c8f896a`, retaining reviewed tree `3aa6b0a`.
PR run `35602853928` and post-merge run `35603408458` each passed all eight jobs.
The next [read-source increment](../design/t6-application-read-evidence.md) reuses
the evidence registry and service-owned authority, with a strict test-only named
draft data validator. [Evidence](t6-application-read-evidence.md) keeps this distinct
from page correlation, live payload witnesses and consent. No milestone is newly
complete and published 1.9.1 is unchanged.

Read-source composition merged as #245 at `422fb62`, preserving reviewed head
`0587a06` and tree `59e6f78`. PR run `35622958447` and post-merge run `35623609531`
each passed all eight jobs; independent review returned SHIP. The
[native form witness design](../design/t6-native-form-witness.md) extends the existing
engine read seam and service admission, then correlates a synthetic draft with actual
native controls and file bytes. Its [qualification evidence](t6-native-form-witness.md)
does not claim full-payload consent, atomic submission or live portal readiness.

Native form evidence merged as #246 at `5712475`, preserving reviewed head
`5a18308` and tree `377060e`. PR run `35633182816` and post-merge run `35635284786`
each passed all eight jobs without reruns; independent review returned SHIP. Local
hooks passed 2,618 tests with 24 existing skips. The next
[internal evidence review](../design/t6-evidence-review-binding.md) reuses the existing
ApprovalGate and scoped evidence owners. Its [qualification](t6-evidence-review-binding.md)
keeps public disclosure policy and atomic submission as explicit follow-ups.


Internal evidence review merged as #247 at `9a87b49`, preserving reviewed head
`4bf116b` and tree `14d3582`. PR run `35640744315` and post-merge run `35641304408`
each passed all eight jobs without reruns; independent review returned SHIP. Normal
hooks passed 2,664 tests with 24 existing skips. The next
[public inspection/decision slice](../design/t6-public-evidence-review.md) shares
existing routes, SDK and CLI with a trusted deployment source resolver; see
[qualification](t6-public-evidence-review.md). C3 atomic submission, production
sources and live qualification remain open. Milestone count remains 3/9; T4/T6
estimates stay conservative and published 1.9.1 is unchanged.


Configured public review merged as #248 at `c968280`, preserving reviewed head
`d550ccb` and tree `197ea9e`. PR run `35650334955` and post-merge run `35650850545`
each passed all eight jobs without reruns; independent review returned SHIP. Both
mandatory hooks passed 2,678 tests with 24 existing skips. The next
[C3a oracle](../design/t6-atomic-submission.md) establishes atomic synthetic acceptance
before any submission operation can be exposed. Its [evidence](t6-atomic-submission.md)
keeps mandatory service consent, public usability, production receipts and live
qualification as explicit follow-ups. Estimates and published 1.9.1 remain unchanged.

C3a merged as #249 at `0e86033`, retaining reviewed head `d949646` and tree
`7b30fdf`. PR run `35656689816` and post-merge run `35657268277` passed all eight
jobs; independent review returned SHIP. Both mandatory hooks passed 2,725 tests with
24 existing skips. This qualifies the test owner's atomic acceptance only: no submit
operation is publicly registered.

Coverage expansion #250 merged at `803f078`; PR run `35673258833` and post-merge run
`35674276640` passed all eight jobs. An ancestry check confirms #249 is retained;
the diff from #249 contains tests and a development coverage dependency only. The PR
reports line coverage of 91.67% versus 84.72% on its base. This is test coverage, not
product completion, and was not remeasured during this alignment.

The [coverage findings repair](foundation-coverage-findings.md) addresses five concrete
validation, receipt, CLI and lifecycle defects before C3b. It adds no milestone or
submission permission. Next: design and independently review mandatory consent inside
ApplicationAuthority's existing dispatch path, then implement it with failing-first
tests. C3c public usability/independent acceptance follows that gate. Published 1.9.1,
the 3/9 completed milestone count and conservative estimates remain unchanged.


Foundation repairs #251 merged at `9c82a49`, retaining reviewed head `00acd05`
and tree `c1fc62a`. PR run `35679483754` and post-merge `35679835320` passed all eight
jobs without reruns; independent review returned SHIP. Both mandatory hooks passed
3,206 tests with 24 existing skips.

The [C3b internal consent gate](../design/t6-mandatory-application-consent.md) now
has [focused qualification](t6-mandatory-application-consent.md): authority-derived
intended operations, mandatory protected dispatch, fresh evidence consumption and
one synthetic native/app acceptance through the existing executor. At that checkpoint,
public application schemas rejected the internal approval credential. C3c public review
creation, transport projection, CLI usability and named T2 acceptance qualification
follow below; production sources and live ATS use remain gated. Do not count this
internal increment as a finished T4/T6 milestone or a released feature.

C3b merged as #254 at `9eb43b5`; PR run `35686322253` and post-merge
`35687160556` passed all eight jobs, with exact-head SHIP review. Error-containment
#253 merged at `74bda24`; PR run `35688434370` and post-merge `35688774753`
also passed all eight jobs. Parallel #255 merged at `2bdd535`; a later adversarial
review reproduced serialization/logging/navigation leaks, fixed in #256 at `5bdb89f`.
Reviewed head `fc5f601` and merge retain tree `293351e`; PR run `35695807804` and
post-merge `35696315271` each passed all eight jobs without reruns. Normal hooks and
exact-head independent SHIP review passed.

The [C3c design](../design/t6-public-application-review.md) is implemented and
[qualified](t6-public-application-review.md): public review creation and
consent forwarding, separate operator admissions, named independent accepted-receipt
verification, uncertain-return reconciliation and public visible/hidden/file drift
refusal. It reuses shared authority, evidence and CLI infrastructure. PR #257 merged
as `d53829e`, retaining reviewed head `e31df5b` and tree `9c80b4a`. PR run
`35700286133` and post-merge `35700787754` each passed all eight jobs without reruns.
Both normal hooks passed 3,329 tests with 24 existing skips; exact-head review was SHIP.
T4/T6 estimates remain
conservative: production source configuration, eligibility and live portal coverage
are separate work, and no whole milestone is newly complete.

## Next design checkpoint

[P0 trusted evidence composition](../design/t4-production-evidence-composition.md)
closes the unsupported private-service access used by the synthetic witness fixture.
It reuses the captured admission-owned native reader in the existing trusted provider
callback. P0a/P0b merged #259 at `836cc65`; see the
[bounded qualification](t4-production-evidence-composition.md). Production registration
(P0c) and a real application qualifier (P1) remain separate gates.

[E0 job eligibility](../design/t6-job-eligibility.md) refines the existing job checkpoint
into application-owned normalized facts and a pure eligible/hold/reject predicate.
Its data/schema stays out of the default browser protocol and context. E0a/E0b are
implemented in the current candidate ([evidence](t6-job-eligibility.md)); private integration and live headed qualification need
their named inputs and current evidence. E0c/E1 remain gated; neither the E0 predicate nor the P0 embedding seam increases
whole-milestone completion or claims live application readiness.

Independent design review returned SHIP after clarifying native-reader lifetime versus
witness/app guards, private identifier/digest handling, and unconfigured policy versus
malformed input. All 82 existing context selections and 692 relative documentation links
passed. Default forms/application views still load only core plus their mode (8,880 and
8,215 serialized UTF-8 bytes respectively); detailed designs remain opt-in. These are
context-byte measurements, not token/RSS savings or implemented runtime limits.
