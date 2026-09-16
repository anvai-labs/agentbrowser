# Mode: website quality audit

Status: screenshots and observations exist; specialist audit/report adapters are proposed.
Core applies.

## Job and data

Evaluate selected pages for visual regressions, accessibility findings or performance
budgets. Load an AuditPlan with target scope, viewport/environment, chosen checks and
baseline references. Avoid loading all audit engines or every historical screenshot.

## Shared execution

Reuse navigation, authority, artifact storage and TestRun reporting. Add optional
diagnostic adapters for established tools rather than reimplementing accessibility
rules, image comparison or performance instrumentation. Audit navigation may trigger
page effects; read-only diagnostic intent is not proof of a side-effect-free website.

## Required outcome

Record measurement environment, tool/version, sample count, baseline and evidence.
Distinguish repeatable failure from measurement noise; never silently rebaseline.
Accessibility automation reports detected issues and untested coverage, not complete
compliance certification. Keep raw screenshot/DOM captures scoped and on demand.

## Acceptance and footprint

Seed a known accessibility/visual defect and prove it is detected; run a clean control.
Performance checks repeat under a pinned environment and report variability. Optional
engines must be absent from default form/application-only installs. Reports reuse the
shared evidence IDs and renderer components; no separate audit artifact database.

Primary packet: T7 audit slice, depending on T3's shared run/report contract.
