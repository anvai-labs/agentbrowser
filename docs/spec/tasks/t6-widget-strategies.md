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

The [Q0 commitment repair](../evidence/t6-widget-commitment.md) is the current candidate.
It restores four dormant tests, shares each strategy's commitment predicate between
immediate/final verification, captures bounded known-markup chip membership, and
reuses scoped resolution to reacquire refs between custom strategy actions. A real
Chromium/stdio fixture retains one five-field bulk payload and adds query-only and
incomplete-membership negative controls. This is synthetic markup qualification,
not broad library/version or live-site acceptance. T6 remains active.
