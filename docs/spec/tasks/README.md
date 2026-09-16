# Agent implementation task packets

Status: implementation activated by the user's subsequent foundation-first instruction.
T0 is delivered; T1 and T2 have active incremental slices; later tasks remain not
started. Reading this task list alone does not
authorize implementation or publication; follow the current user-authorized scope.

## Start a task with minimal context

Read shared core, the selected mode, this execution protocol once, and one task packet
with its declared inputs from the manifest. Do not read every mode or historic ADR.
Use `node scripts/spec-context.mjs --mode qa --task t2`; it selects the explicit task
view with a 64 KiB complete-context ceiling. A task whose hard dependency is not marked
complete is rejected. `--list` and `--check` expose selection metadata and validate all
declared files and budgets without contacting a service.

| Task | Outcome | Hard task dependencies |
| --- | --- | --- |
| [T0](t0-contract-catalog.md) | Accurate discovery and canonical contract projection | None |
| [T1](t1-context-profiles.md) | Selective context/tool loading with measured isolation | T0 |
| [T2](t2-shared-execution.md) | Shared result, verification and execution helper contracts | T0 |
| [T3](t3-qa-regressions.md) | Deterministic user-facing regression and reports | T2 |
| [T4](t4-application-parity.md) | Public typed application operations and independent parity | T2 |
| [T5](t5-durable-recovery.md) | Optional single-owner durable recovery | T2 |
| [T6](t6-widget-strategies.md) | Qualified custom-widget strategy increments | T2 |
| [T7](t7-audit-security.md) | Optional audit/security adapters and profiles | T3; T4 additionally for application-security parity |
| [T8](t8-harness-qualification.md) | Qualified harness transport, schema and footprint behavior | T0; profile/full-run slices also require T1/T3 |
| [T9](t9-release-hardening.md) | Safe, economical per-repository promotion and release | T0; each release also requires its changed tasks' acceptance |

T7 has additional scope-enforcement and customer-demand gates. T8 transport repair
may start immediately after T0; do not wait for T3 to fix a known correlation hazard.
T9 is both an early hardening task and a recurring release gate. Tasks share code and
acceptance infrastructure; they are not instructions to create ten packages/services.

## Common execution protocol

1. **Reconcile:** inspect working tree, branches, remote base/head, open PRs, current
   package versions and task evidence. Preserve unrelated changes. If concurrent work
   overlaps, coordinate ownership or create an isolated worktree; never force-reset it.
2. **Read narrowly:** load core/mode/task inputs, then inspect the named owners and
   relevant tests with `rg`. Re-evaluate baseline findings against current source.
3. **Plan reuse:** list existing helpers extended, new adapters/data needed, temporary
   duplication removed and optional dependency impact. Reject a new package unless an
   installation/ownership boundary justifies it. Refine the packet into small PR slices.
4. **TDD:** demonstrate the selected falsifying tests fail; implement through existing
   owners; run focused suites and required actual-surface qualification. Record exact
   commands, failures, passes and skips. Tests must verify independent outcomes.
5. **Review:** challenge authority, identity, retry, privacy, resource lifetime, mode
   isolation and compatibility. Obtain independent adversarial review when authorized
   and available. Resolve findings; do not self-label unperformed review as clean.
6. **Local gate:** run impacted contracts/integration/browser/package checks once on
   the final candidate. Broaden only for dependency changes or unresolved concerns.
7. **Deliver within authorization:** commit scoped files, push a ready candidate and
   open a reviewable PR; drive required CI to green without weakening gates. Reconcile
   base changes, review final head, and merge through current repository rules when
   authorized. Promotion to main and release require the corresponding user scope.
8. **Record and continue:** update the task record with evidence and remaining limits.
   Continue the next dependency-ready authorized slice. If a prerequisite is blocked,
   report the exact evidence and proceed with independent work when possible.

Do not automatically transmit private fixtures, open external issue reports or submit
bug-bounty reports. Runtime tests use deterministic local fixtures unless targets and
data are explicitly authorized. Registration of an MCP server is not qualification.

## Required completion record

Store one concise record per completed slice, without raw secrets or full transcripts:

```json
{
  "task": "t2",
  "slice": "result-contract",
  "status": "not_started",
  "repo": "agentbrowser",
  "baseSha": null,
  "headSha": null,
  "reusedOwners": [],
  "newDependencies": [],
  "tests": [],
  "reviewFindings": [],
  "pr": null,
  "ciRun": null,
  "developMerge": null,
  "mainMerge": null,
  "release": null,
  "qualifiedCapabilities": [],
  "remainingLimits": []
}
```

Null means unperformed/unknown, not success. Progress states are not_started, active,
blocked and complete. A task is complete only when its declared acceptance and
authorized delivery are satisfied; if release is outside scope, state that explicitly
and do not mark released. Each repository keeps its own evidence and release identity.

## Reuse and proliferation checklist

Every implementation PR answers: Which single existing owner changes? Which shared
helper is reused? Why is any new helper not already present? Is a descriptor enough?
Does an adapter have a real independent protocol/strategy boundary? Can the old path
be removed? Did the change increase installed dependencies or default loaded schemas?
Are tests sharing fixture setup while retaining an independent outcome oracle?

There is no target number of files or abstractions. Optimize invariant ownership,
understandability, measured footprint and maintenance effort together. More generic
code is not automatically more reusable; duplicated authority or retry semantics are
unacceptable even when they save a few imports.
