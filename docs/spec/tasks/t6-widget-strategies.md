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

The next [verified upload and draft slice](../design/t6-verified-upload-draft.md)
reuses the upload action and a shared bounded file reader, then qualifies a synthetic
CLI draft with an independent browser-file digest and final submit denied. It does
not close complete-payload consent or live application acceptance.
