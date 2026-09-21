# Foundation and use-case checkpoint — 2026-09-20

Rechecked published 1.9.1 at `310e01d43982824caac2c63ed8d98355e17efdce`
and develop `8d92da894c9680c3199e541b33d4b74949fe30b9` (PR #237).
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
| T6 forms/operations | Active | ~40% | Mapping integration and full job workflow qualification; popup ownership/readiness merged #237 |
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

PR #236 and #237 each passed eight PR and eight post-merge checks with independent
review. The [mapping foundation](../design/t6-form-mapping.md) now adds local
preparation plus server preflight in the existing executor; its
[evidence](t6-form-mapping.md) records the candidate's tests and remaining limits.
Do not treat preparation as application completion or increase the overall milestone
count: T6 remains active, and the coarse partial estimates above remain conservative.
