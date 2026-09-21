# T6: owned popup selection and bounded readiness

Bounded implementation slice based on develop `1d7f37b`, after Q0a PR #236.
This qualifies owned option selection, not reusable mapping or the full T6 milestone.
Load with core/forms/T6 and the [job-workflow checkpoint](t6-job-application-checkpoint.md).

Existing owners:
- packages/engine-playwright/src/index.ts: captureFormEvidence and performAction
- packages/api/src/autofill.ts: strategy registry, StrategyScope, scoped resolve, guard,
  serial receipts, deadline, private values, final verification
- packages/api/src/autofill.test.ts and autofill-real-chromium.test.ts
- engine form evidence/action contract fixtures

Problem at baseline `1d7f37b`: both custom strategies searched all observed options,
chose the first exact or prefix match, used fixed sleeps and duplicated the sequence.
Neither currently proves that the option belongs to the intended control.

Design:
1. Extend opt-in form evidence with opaque document-scoped control/listbox/option
   relationships using the existing WeakMap tokens. Resolve ARIA controls/owns to one
   actual listbox and prove one owning combobox. Detect duplicate DOM IDs, ambiguous
   owners and multiple candidate popups; unknown is not proof. Portals may live outside
   the fieldset. Keep the control's existing block identity independently pinned.
2. Capture ownership, visible readiness and focus only for the qualified widget shape.
   Do not make ordinary native controls depend on custom-widget focus state. Avoid
   repeated full-document scans per observed element: prefer an observation-local
   ownership index; recompute target-related ownership at dispatch. Bound published
   metadata and mark incomplete capture unavailable. No page-supplied JS or selector
   becomes an executable strategy.
3. Share one typeahead helper between react-select and chip-multiselect. Click the
   control once, observe focused same-node readiness, type once, then observe one owned
   exact option and click once. Keep separate commitment predicates. No page-global,
   prefix, ordinal or inconsistent case-folded fallback. Define one explicit comparison
   rule (trim surrounding whitespace, otherwise exact) with tests.
4. Reuse maxReobserve, settleMs and the overall deadline through StrategyScope. Observe
   immediately, wait only for pending evidence, and never replay click/type. Only
   absence/pending readiness permits another read; identity drift, ambiguity, focus
   theft, truncation, authority loss and deadline stop the suffix. Do not silently
   multiply unbounded retry budgets across nested helpers; document per-phase attempts.
5. performAction must revalidate the option's current popup AND control ownership/focus,
   not merely option-node identity. A control can change its owning relationship while
   the option node remains attached. Existing target-only attribute comparison is
   sufficient only if the evidence includes and recomputes these relationships.
6. Reuse current failed/uncertain receipts and final commitment checks. Once opening or
   typing happened, inability to prove selection is partial/uncertain; never report an
   untouched transaction or auto-clear/rollback. No new public endpoint or orchestrator.

Failing-first acceptance:
- Two widgets with identical option labels: only owned popup eligible.
- Duplicate exact options and prefix-only option: no selection click.
- Portaled list succeeds; missing/ambiguous owner and duplicate IDs refuse.
- Delayed options succeed within read budget, exactly one click-open/type; timeout stops suffix.
- Focus theft, block/control replacement, popup replacement and option reparenting stop dispatch.
- Change aria-controls after observation with an unchanged option node: refuse click.
- Both single and chip commitment remain independently checked immediately and at end.
- Native fields remain unaffected; unsupported engines fail with explicit evidence limits.
- Existing real Chromium/stdio fixture remains one bulk payload, with app-owned counters
  proving selection/no selection rather than asserting only generated receipts.

Limits: supported ARIA ownership and observed markup only. Hostile page script can race
DOM checks; observation and click are not atomic and not an origin security boundary.
Virtualized/offscreen lists, keyboard-only controls, clear/rollback and arbitrary ATS
versions require separate qualification. Finish this before reusable mapping and live
job workflow expansion. Reuse existing CI jobs; no additional runner matrix by default.


## Compatibility and integration gates

The stronger evidence requirement intentionally refuses unsupported custom markup that
previously reached an arbitrary page-wide option. Existing native inputs/selects retain
their contracts. Readiness may begin without a declared relation or mounted popup; once a ready popup token
is observed it is pinned for the rest of that field. Missing relation targets are
pending, but ambiguous or incomplete ownership is invalid. Missing/invalid engine
popup-state metadata refuses before opening. A current absent ARIA relation may permit
one open/type on the uniquely matched stable focused control, but never an option click
until unique ownership appears. Exhaustion reports uncertainty and stops the suffix. Focus theft never triggers
refocusing or action replay. The scope budget permits one immediate option observation
plus `maxReobserve` extra reads; verification and field discovery retain their existing
separate read budgets within the same overall deadline.

Qualification extends the existing fixture to both the compiled CLI and stdio paths,
with one payload per bulk call and independent application selection counters. It
reuses `runAgentCli` for child-process lifecycle and a minimal environment, not another
bridge or runner. CLI input uses stdin; bearer tokens stay out of argv. Installed/Bun
release qualification remains the later release ladder, not a claim made by source tests.
