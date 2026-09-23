# Agent implementation task packets

Status: implementation activated by the user's subsequent foundation-first instruction.
The table separates the published AgentBrowser 1.9.1 checkpoint from subsequent work.
Reading this task list alone does not
authorize implementation or publication; follow the current user-authorized scope.

## Start a task with minimal context

Read shared core, the selected mode, this execution protocol once, and one task packet
with its declared inputs from the manifest. Do not read every mode or historic ADR.
Use `node scripts/spec-context.mjs --mode qa --task t2`; it selects the explicit task
view with a 64 KiB complete-context ceiling. A task whose hard dependency is not marked
complete is rejected. `--list` and `--check` expose selection metadata and validate all
declared files and budgets without contacting a service.

| Task | Current state | Delivered or next gate | Hard task dependencies |
| --- | --- | --- | --- |
| [T0](t0-contract-catalog.md) | Complete | Released discovery/catalog foundation | None |
| [T1](t1-context-profiles.md) | Active | Local loader, fixed profiles and run cursor delivered; installed-harness consumption remains | T0 |
| [T2](t2-shared-execution.md) | Complete | Shared execution/evidence shipped; develop #257 adds synthetic G6 acceptance, with production evidence and durability still gated | T0 |
| [T3](t3-qa-regressions.md) | Complete | First application-owned CLI regression workflow, private JUnit evidence, standalone-copy and measured-cost qualification delivered through #231 and released in 1.9.1 | T2 |
| [T4](t4-application-parity.md) | Active | REST/SDK/CLI shipped; synthetic UI/API parity and C3c public consent qualified; P0 trusted native-read composition merged #259; U0 binding UI merged #261; U1 receipt UX merged #262; production gates remain | T2 |
| [T5](t5-durable-recovery.md) | Active | J0 shared dispatch/drain merged #267; A1 core finalization implemented; publication and durable recovery pending | T2 |
| [T6](t6-widget-strategies.md) | Active | Mapping, uploads, native/app witnesses and C3c synthetic submission qualified on develop; E0a/E0b eligibility merged #260; N0 document read merged #263; E0c private listing review merged #264; private integration/live gates remain | T2 |
| [T7](t7-audit-security.md) | Not started | Optional audit/security adapters and profiles | T3; T4 additionally for application-security parity |
| [T8](t8-harness-qualification.md) | Active source repair | Victor schema repair merged #1168; installed Victor/Codex/Claude qualification remains | T0; profile/full-run slices also require T1/T3 |
| [T9](t9-release-hardening.md) | Recurring | Branch protection and release process exist; every changed slice still needs its own promotion evidence | T0; each release also requires its changed tasks' acceptance |

T7 has additional scope-enforcement and customer-demand gates. T8 transport repair
may start immediately after T0; do not wait for T3 to fix a known correlation hazard.
T9 is both an early hardening task and a recurring release gate. Tasks share code and
acceptance infrastructure; they are not instructions to create ten packages/services.

## Current continuation

The alignment sequence through #222 is merged. Follow the
[verified handback](../evidence/foundation-handback-recheck.md), not stale open-PR or
navigation-reset observations. T3's
[offline CLI evaluation](../evidence/t3-cli-evaluation.md),
[native JUnit probes](../design/t3-node-test-qualification.md) and
[application-owned CLI recipe](../design/t3-application-recipe.md) are merged through
PR #227; PR #228 supplies the Node 24 qualification baseline, PR #229 adds private
example-local report links, and PR #230 qualifies live native JUnit. The current
closure delivered in #231 executes the documented two-file recipe copy from an unrelated
working directory and records a scoped focused/full cost baseline. See the
[completion evidence](../evidence/t3-standalone-qualification.md). Broader provisioning,
HTML without a consumer and automatic CI selection remain separate follow-ups.

The 1.9.1 [release ladder](../evidence/release-1.9.1.md) is complete, including
Homebrew acceptance and main-to-develop back-sync (#235). Q0 committed-widget
verification shipped; the ApplicationAuthority
[callback contract guard](../design/t4-application-callback-contracts.md) (Q0a) merged
through #236 with eight PR and eight post-merge checks green. The bounded T6
[owned-popup/readiness slice](../design/t6-owned-popup-readiness.md) merged through #237 with eight PR and eight post-merge checks green. The next
[mapping foundation](../design/t6-form-mapping.md) reuses autofill for exact-URL stage
preflight and offline private preparation. Subsequent slices through #257 qualify
synthetic UI/API parity and public reviewed submission. Live job-workflow and production
evidence remain open. P0a/P0b trusted native-read composition merged #259; E0a/E0b pure eligibility is
merged #260; U1 operator reconciliation merged #262. N0 document-read repair merged #263 and passed headed capture; the next E0c consumer
collects a caller-selected listing for private review without evaluating eligibility; their detailed designs are linked by T4/T6 and loaded only on demand. Keep research outside
default task context and use the [progress checkpoint](../evidence/foundation-progress-2026-09-20.md)
for estimates: T0, T2 and T3 are complete, or 3 of 9 finite milestones (33%). Including
recurring T9 gives 3 of 10 original rows (30%); neither is an effort-weighted estimate.

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
