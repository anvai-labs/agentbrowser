# Agent implementation task packets

Status: implementation activated by the user's subsequent foundation-first instruction.
The table records the published AgentBrowser 1.13.0 checkpoint and remaining work.
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
| [T2](t2-shared-execution.md) | Complete | Shared execution/evidence shipped; 1.10.0 includes #257 synthetic G6 acceptance, with production evidence and durability still gated | T0 |
| [T3](t3-qa-regressions.md) | Complete | First application-owned CLI regression workflow, private JUnit evidence, standalone-copy and measured-cost qualification delivered through #231 and released in 1.9.1 | T2 |
| [T4](t4-application-parity.md) | Active | REST/SDK/CLI shipped; synthetic UI/API parity and C3c public consent qualified; P0 trusted native-read composition merged #259; U0 binding UI merged #261; U1 receipt UX merged #262; production gates remain | T2 |
| [T5](t5-durable-recovery.md) | Active | J0/A1/A2/A4a/A3a1 shipped in 1.10.0; A3a2 review disclosure, HTTP/replay publication (#284), and B1/B2 journal contract (#285) shipped in 1.11.0; journal settlement/authority/terminal and control views plus the SQLite owner/anchor primitive shipped in 1.12.0; runtime selection, concrete store enablement and recovery remain gated — no public durability | T2 |
| [T6](t6-widget-strategies.md) | Active | Mapping, uploads, native/app witnesses and C3c synthetic submission shipped in 1.10.0; E0a/E0b eligibility merged #260; N0 document read merged #263; first E0c listing-capture slice merged #264; normalization/private integration/live gates remain | T2 |
| [T7](t7-audit-security.md) | Not started | Optional audit/security adapters and profiles | T3; T4 additionally for application-security parity |
| [T8](t8-harness-qualification.md) | Active source repair | Victor schema repair merged #1168; installed Victor/Codex/Claude qualification remains | T0; profile/full-run slices also require T1/T3 |
| [T9](t9-release-hardening.md) | Recurring | Branch protection and release process exist; every changed slice still needs its own promotion evidence | T0; each release also requires its changed tasks' acceptance |

T7 has additional scope-enforcement and customer-demand gates. T8 transport repair
may start immediately after T0; do not wait for T3 to fix a known correlation hazard.
T9 is both an early hardening task and a recurring release gate. Tasks share code and
acceptance infrastructure; they are not instructions to create ten packages/services.

## Current continuation

AgentBrowser 1.13.0 is published and installed (2026-09-27); main and develop are
in sync at `2554c99`. Delivery records with exact identities exist for 1.11.0,
1.12.0 and 1.13.0 (../evidence/release-1.11.0.md, ../evidence/release-1.12.0.md,
../evidence/release-1.13.0.md). The consumer continuation through #296 shipped in
1.12.0 (navigation reasons, operator CDP attachment, sampled leases, bounded
terminal facts, observed engine disconnection); the
`AGENTBROWSER_CHROMIUM_ARGS` escape hatch and repo-wide lint enforcement shipped
in 1.13.0. None of these establish durable recovery; the merged journal work
remains storage-neutral, with runtime selection, concrete store enablement and
recovery gated.

Next dependency-ready slices by task:

- T5 — J2b.3 process-loss rows QUALIFIED (before_commit / after_commit /
  after_anchor barriers + caller-timeout rule) and the adversarial/bounded
  matrix QUALIFIED (acquisition races, wrong-fingerprint-key, corrupt/
  truncated database reopen refusal, dispose under outstanding I/O, bounded
  DB/WAL/anchor sizes, child self-exit) over the landed manager/child/adapter
  stack, arbitrated by the now-blocking CI journal-gates job, with the
  packaging gate (extracted-package child resolution, packaged per PR) and
  the deeper adversarial rows (stale DB/anchor copies, malformed/missing/
  partial anchors, hardlink/symlink/permission aliases, external-writer BUSY
  seal, admission ceilings, oversize refusal, key-material sentinel) in the
  same job — see the
  [owner/anchor primitive](../evidence/t5-journal-sqlite-owner.md)); the
  protocol-fault rows (late/duplicate/malformed replies, with the manager's
  host-crash frame guard) are qualified too. Every row testable in CI is
  gated; remaining: release-time read-only-filesystem and disk-full lanes
  and clock-movement rows in the fake-timer record conformance.
- T4 — production-evidence gates: trusted native-read composition, receipts and
  parity against production surfaces; synthetic parity and public consent are
  already qualified.
- T6 — normalization, private integration and live gates after the merged
  document-read and listing-capture slices.
- T8 — installed Victor/Codex/Claude qualification; the source-level schema
  repair is merged.
- T1 — installed-harness consumption of profiles and the run cursor.
- T7 — not started. Unblocking order: T4 production gates, then T7 slice 2
  scope enforcement (it blocks dependent active testing), then scanner
  regression and report slices on demand.

Use-case gates: the automated-testing use case (vision priority 1) needs T4
production evidence, T6 live gates and T8 installed qualification. The bounty
use case (vision priority 5) additionally needs T7 scope enforcement, stays
manual-submission by policy, and permits live targets only with explicit
authorization.

Keep research outside
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
