# T6: qualified widget strategies without duplicate orchestration

Status: active. Repository: agentbrowser. Depends on: T2.
Inputs: core, forms mode, execution, grounding, contracts.

## Reuse and scope

Extend the trusted existing autofill strategy registry. Reuse scoped resolution,
action policy, budgets, private-value comparisons and receipt assembly. Add widget
commitment semantics only; do not duplicate the bulk loop or introduce a parallel
plan executor. Native behavior remains independently qualified.

## Slices

1. One concrete combobox family/version with committed-selection predicate and focus purity.
2. Chip multiselect only after stable membership/removal evidence is specified.
3. A versioned reusable mapping separate from private profile values, with drift checks.

## TDD and acceptance

Test highlight versus commit, Enter-triggered submit, focus theft, async option loading,
recycled options, repeated fieldsets, node movement, normalization and partial removal.
Uncertain dispatch stops the suffix. A widget without reliable clear/rollback reports
partial effects; it does not simulate a transaction through guessed compensation.

Run one actual Chromium fixture through a single stdio bulk call. Alternative engines
advertise support only after the same evidence contract passes. The live application
target needs authorized sessions/profile data and is separate from deterministic CI.
Record accepted transfer sizes and cooperative versus hard deadline limitations.

## Completion / stop

Close R09 for named strategies only. Keep unsupported cases explicit. Do not add a
generic keyboard guesser, unrestricted regex or site-specific engine fork to pass a demo.

## Current implementation state

AgentBrowser 1.8.19 extends the existing autofill strategy registry with explicit
`react-select` and `chip-multiselect` strategies. Both reuse the same scoped field
resolution, action executor, receipt assembly and verification loop; they do not add a
second bulk orchestrator. This is a bounded T6 slice, not completion of T6: reusable
mapping, removal/rollback semantics, broader async/recycled-option coverage and
cross-engine actual-surface qualification remain open.

The [Q0 commitment repair](../evidence/t6-widget-commitment.md) shipped in 1.9.1 through PR #232.
It restores four dormant tests, shares each strategy's commitment predicate between
immediate/final verification, captures bounded known-markup chip membership, and
reuses scoped resolution to reacquire refs between custom strategy actions. A real
Chromium/stdio fixture retains one five-field bulk payload and adds query-only and
incomplete-membership negative controls. This is synthetic markup qualification,
not broad library/version or live-site acceptance. T6 remains active.


The [owned-popup/readiness slice](../design/t6-owned-popup-readiness.md)
merged through PR #237 with eight PR and eight post-merge checks green. It extends
engine evidence and one shared typeahead helper for both custom strategies.
It removes page-wide/prefix selection, requires a unique exact option in the owned
listbox, and retries observations without replaying writes. Engine dispatch rechecks
ownership and focus; native field semantics and commitment predicates stay shared.
See the [qualification evidence](../evidence/t6-owned-popup-readiness.md); no arbitrary ATS coverage,
rollback or reusable mapping claim follows.

The [mapping foundation](../design/t6-form-mapping.md), merged in PR #238, adds a pure protocol join,
offline CLI preparation and exact-URL/all-field preflight inside the same executor.
See [evidence](../evidence/t6-form-mapping.md). This is one fully present stage;
conditional stages, business/job identity and live workflow qualification remain open.

The [verified upload and draft slice](../design/t6-verified-upload-draft.md), merged in PR #239,
reuses the upload action and a shared bounded file reader, then qualifies a synthetic
CLI draft with an independent browser-file digest and final submit denied. It does
not close complete-payload consent or live application acceptance.

The [reviewed-payload consent sequence](../design/t6-reviewed-payload-consent.md)
starts with C0 token ownership and atomic service consumption. It reuses the existing
bounded canonical serializer and ApprovalGate; C1a operator action approval is delivered in #242; C2 live payload
consent and C3 qualified submission remain pending.
See the [C0 evidence](../evidence/t6-approval-consumption.md). Legacy token echo is
action confirmation, not proof of independent review or complete-form consent.

C0 merged in #240. The [C1 review-binding foundation](../design/t6-review-authority-binding.md)
extends the existing control/authority owners before adding operator-approval surfaces.
It addresses same-epoch review invalidation and configuration cleanup; no approval
CLI/API or live-submit capability follows from this internal context projection.

The authority foundation merged in #241. The [C1a implementation](../design/t6-operator-approval.md)
adds explicit operator action approval through the existing REST/SDK/CLI owners,
including token inspection, approve/deny and ordinary action consumption. This is
operator-only action consent, not full-payload consent or live-submit qualification.

C1a merged in #242. The [C2a draft oracle](../design/t6-draft-oracle.md) qualifies
a test-only versioned application contract and independent UI/API parity, including
server-received attachment bytes. [Evidence](../evidence/t6-draft-oracle.md) separates
this candidate from C2b service-collected witness binding and C3 accepted submission.

C2a merged in #243. The [C2b scoped-read foundation](../design/t6-scoped-application-read.md)
reuses captured application/admission ownership to collect bounded read data without
nested execution. Source qualification, page correlation and consent binding remain
separate gates; [evidence](../evidence/t6-scoped-application-read.md) records this limit.
