# Agent implementation task packets

Status: implementation activated by the user's subsequent foundation-first instruction.
The table records the delivered state as of 2026-10-16, reconciled item by item against the
packets' acceptance lists (published baseline 1.21.0, promoted to main via #544). "Complete"
means the manifest dependency gate is satisfied; open follow-ons are named in the row.
Reading this task list alone does not authorize implementation or publication;
follow the current user-authorized scope.

## Start a task with minimal context

Read shared core, the selected mode, this execution protocol once, and one task packet
with its declared inputs from the manifest. Do not read every mode or historic ADR.
Use `node scripts/spec-context.mjs --mode qa --task t2`; it selects the explicit task
view with a 64 KiB complete-context ceiling. A task whose hard dependency is not marked
complete is rejected. `--list` and `--check` expose selection metadata and validate all
declared files and budgets without contacting a service.

| Task | Current state | Delivered or next gate | Hard task dependencies |
| --- | --- | --- | --- |
| [T0](t0-contract-catalog.md) | Complete | Released discovery/catalog foundation. Delivered since: the 100-step plan cap (#478) and output schemas for six more MCP tools with the structured-error envelope (#482); the last six tools' schemas (#489); MCP `notifications/cancelled` honoured end to end (#485) | None |
| [T1](t1-context-profiles.md) | Active | Local loader, fixed profiles and run cursor delivered; Codex-path and Claude-path cursor consumption/retirement qualified (2026-10-03/04); same-tenant/different-principal admission pinned (#476). The mode-footprint refresh delivered 2026-10-15, after T0 M2 (#497). Victor gated on aiserver1's gateway (owner reconciliation 2026-10-15) | T0 |
| [T2](t2-shared-execution.md) | Complete | Shared execution/evidence shipped; production evidence still gated | T0 |
| [T3](t3-qa-regressions.md) | Complete | Delivered through #231, released in 1.9.1. The installable `test evaluate` CI entrypoint delivered (#500) | T2 |
| [T4](t4-application-parity.md) | Active | REST/SDK/CLI shipped; synthetic UI/API parity, C3c public consent, trusted native-read composition (#259), binding UI (#261), receipt UX (#262) qualified; production gates remain (requires authorized live targets) | T2 |
| [T5](t5-durable-recovery.md) | Active | FULL CI-gated adversarial matrix (32 distinct rows): process-loss, anchor, quota, privacy, read-only-FS, disk-full — all CI-blocking. Operator reconciliation procedure DELIVERED. C4b DELIVERED 2026-10-15 (J-a, J-b, J-d, J-e, J-f). J3 delivered 2026-10-15: findByOperation (J3a), the read-only lookup and status routes (J3b), operator-only close/settle (J3c part 1); J4 delivered for application writes (classification table, cursor-after-restart refusal, recoveryQualified). J3c part 2 (continue/supersedes/reconcile) and J3d history namespaces delivered 2026-10-15; B-dur browser classification delivered 2026-10-15 (#518–#522: durable act/plan/autofill, SDK/CLI/MCP parity, real-store crash and recovery rows per owner). Remaining: per-host deployment (operator); optional constrained-mount depth (unscheduled). R08's autofill-receipt part is narrowed, not closed, by design (D6) | T2 |
| [T6](t6-widget-strategies.md) | Active | Mapping, uploads, native/app witnesses, C3c synthetic submission, E0a/E0b eligibility, N0 document read, first E0c listing-capture slice delivered; W1 #491, W2 #502, W3a #511, W3b #507 delivered; remaining: business/job identity and gates owned by the consuming workflow (E0c/E1 private policy, live workflow qualification) | T2 |
| [T7](t7-audit-security.md) | **Complete** | ALL slices delivered (the appsec/bounty parity condition on T4 stays open): 2a scope enforcement (primitive + surface, 12 real-Chromium gates plus 14 policy unit tests), 1a visual audit adapter, 1b accessibility adapter (axe-core, page-scripts-never-executed), 3 ZAP scanner-regression adapter + real-ZAP recorded run (2.17.0), 4 SARIF 2.1.0 report adapter, shared finding-baseline store — 36/36 gates; audit suite 53 tests after the 2026-10-15 labelling and role-access work | T3; T4 additionally for application-security parity |
| [T8](t8-harness-qualification.md) | Active | Codex-path qualification COMPLETE (tool-call, slice-2 dimensions, cursor choreography, resilience, real-ZAP run — 2026-10-02/03); Claude-path cursor choreography COMPLETE (2026-10-04); Victor gated on aiserver1's gateway, not TLS (owner reconciliation 2026-10-15). MCP cancellation (#485, bridge side; no CLI can script a provider-path cancel) and the Q1 re-qualification on both CLIs (#497) delivered; open: the inline-screenshot decision | T0; profile/full-run slices also require T1/T3 |
| [T9](t9-release-hardening.md) | Recurring | 1.21.0 released 2026-10-16 (run 38974842067); the tag-ancestry gate (#475) passed on it; least-privilege permissions and SHA-pinned actions delivered (#481); the CI runner-minutes baseline is recorded (#504); runner-use improvements open. Every release needs fresh promotion evidence. R14 closed 2026-10-16 (tag ruleset + `npm` environment protection) | T0; each release also requires its changed tasks' acceptance |
| [T10](t10-engagements.md) | Active | Approved 2026-10-16: engagements (scope without holes → status and metadata-only ledger → program scope and findings) and saved plan runs, released per milestone 1.21.0–1.25.0 (M2 split across 1.22.0 and 1.23.0) | T7; T5 for automation runs |

## Current continuation (2026-10-16)

Published baseline **1.21.0** (2026-10-16: T10 M1, an engagement scope without holes);
records in ../evidence/release-1.16.0.md through release-1.21.0.md. Every agent-actionable item of the
2026-10-15 reconciliation is delivered; what remains is below. The next arc is
[T10](t10-engagements.md): engagements and saved plan runs, released per milestone.

## Earlier continuation (2026-10-07)

Baseline **1.15.2** (TD-BROWSER-13 observation secret redaction; ../evidence/release-1.15.2.md).
That session merged #356–#372: T7 scope enforcement and audit adapters, T5 adversarial lanes and
the C4b precondition audit, T1/T8 Codex- and Claude-path cursor qualification, the N2
prerequisite, and a docs consistency sweep.

## Next items (2026-10-15): owner- or infrastructure-gated

- **aiserver1:** the gateway's upstream and systemd units (inferflux, sandhi-proxy); this gates
  every Victor row (T1, T8).
- **Live targets:** named authorized targets for T4's production gates and T6 E0c/E1 (driven by
  the consuming workflow).
- **Operator:** per-host journal deployment (`AGENTBROWSER_JOURNAL_*`, operations guide).
- **Owner decisions:** the credential broker (TD-BROWSER-13 §5, SentinelPass), axe in a browser
  context, MCP registry publication, the HTML report, brew service env durability, N2
  enforcement, Safari widgets, the required `build`/`deploy` docs contexts, and
  T8's inline-screenshot question.
- **Open, unscheduled:** constrained-mount journal depth, measured runner-use improvements (T9).
- **Decided 2026-10-16:** the bounty use case → [T10](t10-engagements.md) (fixtures until a live
  target is authorized); T6 async/recycled-option coverage is released with T10 M4.
- **Outside this repo:** the Sandesha closeout.
- **Releases:** each publication needs fresh promotion evidence.

Use-case gates: automated testing (vision priority 1) needs T4 production evidence, T6 live gates
and T8 installed qualification; the bounty use case (priority 5) stays manual-submission by
policy and permits live targets only with explicit authorization.

## Foundation-first refinements

F1 all-hop egress enforcement: DELIVERED 2026-09-30.
F2 clock-movement conformance rows: DELIVERED 2026-09-30.
F3 durable-journal runtime enablement: **user authorized**; C4b DELIVERED 2026-10-15 (J-a, J-b,
J-d). Per-host deployment of the durable store is an operator action.
N1 bounded network-error observation: DELIVERED (slice 1 in 1.15.0; G4
events replay in 1.15.0).
N2 OS-enforced egress pairing: prerequisite documented
([t7-os-egress-pairing](../design/t7-os-egress-pairing.md)); enforcement NOT SHIPPED.
Rationale and sequencing: [foundation-refinements.md](foundation-refinements.md).
