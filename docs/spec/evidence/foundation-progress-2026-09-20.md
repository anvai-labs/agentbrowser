# Foundation and use-case checkpoint — 2026-09-20

Rechecked published 1.9.1 at `310e01d43982824caac2c63ed8d98355e17efdce`
and develop `c8f896a5f4bd42ce780c0395d497f301226b050d` (PR #244).
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
| T4 application operations/parity | Active | ~40% | Independent UI/API oracle, binding UX, production evidence; callback repair merged #236 |
| T5 durable recovery | Not started | 0% | Design, journal/recovery and process-loss qualification |
| T6 forms/operations | Active | ~40% | Full-payload consent, candidate identity/eligibility and live qualification; operator action approval #242, draft oracle #243 and scoped-read foundation #244 merged; source composition and named data validation in progress |
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
