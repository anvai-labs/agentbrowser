# T9: repository, CI and release hardening

Status: active recurring gate. Repository: agentbrowser; coordinate separate Victor
delivery where changed. Depends on: T0 and each release candidate's acceptance.
Inputs: core, quality-ci, delivery, review.

## Reuse and scope

Read live main/develop protections, active workflows, required checks, latest release
and open PRs before changing anything. Reuse existing version synchronization,
artifact packaging/acceptance, smoke tests, trusted publishing and CI jobs. Do not
add another release orchestrator or duplicate builds merely to satisfy a new checklist.

## Slices

1. Qualify release tag ancestry on protected main and source/artifact identity before
   publication. Review tag update permissions, workflow token scope and dependency pinning.
2. Make discovery/schema/spec checks local and reusable inside existing jobs. Any required
   check migration must keep PR reporting reliable and preserve all needed coverage.
3. Drive each authorized candidate through review, CI, develop, main and release with
   per-repository evidence. Recheck final heads after concurrent changes.

## TDD and acceptance

An off-main tag, mismatched version, missing runtime tool, unqualified artifact or
failed prerequisite cannot publish. Skipped/canceled required tests cannot turn an
aggregate gate green. A docs-only path cannot strand required checks. Existing admin,
force-push and deletion protections remain effective; no bypass for a failing build.

Exercise validation locally using fixtures/mocks and existing smoke controls before
one final CI cycle. Do not create a real invalid release to test the guard. Record
runner minutes before/after optimization and preserve release artifact smoke evidence.

## Completion / stop

Close R14/R15 for implemented gates. Publication is a separate authorized action;
provide a concrete candidate and evidence before requesting any missing approval.
Never claim main promotion or release from a local version bump. Preserve concurrent
branches and use the reviewed final commit identity for each merge.

## Current implementation state

Main is protected with required checks, admin enforcement and force-push/deletion
blocks. Develop is currently unprotected, so each develop merge additionally requires
an explicit operational review and all eight required checks on the exact candidate;
do not infer equivalent branch enforcement. The previous **1.9.0** checkpoint used exact
main/tag commit `02f263f3764b41f923553c69c11dff69c819fae5`. Promotion PR 210, all eight main
checks and all twelve release jobs passed; published asset, checksum, npm and
package acceptance completed. Main was synchronized back to develop by PR 211
at `4dbd48921346057431468e8d1185c936283f5881`, with all eight post-merge checks,
and Homebrew PR 57 completed with all three post-merge checks. Exact links and
qualification limits are recorded in the [release tracker](../../release-milestones.md).

T3 is complete on develop through PR 231 at merge `cc4d72e0deecde9896896f1f20ebcbca5f3f80ad`;
its final PR and post-merge runs each passed all eight checks. The bounded T6 widget
commitment repair then merged through PR 232 at `d510a56d5d69e0cc9afe17dc56d27a0a11987cff`;
its PR run `35539291664` and post-merge run `35539537406` each passed all eight jobs.
Both are now included in **1.9.1**, along with CLI cookie-file handoff from PR 233.
Promotion PR 234 and all eight main checks passed at
`310e01d43982824caac2c63ed8d98355e17efdce`; the tag matches this commit and all twelve
release jobs passed. Published artifacts and the local Homebrew upgrade passed
acceptance. See the [1.9.1 delivery evidence](../evidence/release-1.9.1.md).
The 1.9.1 candidate's tag ancestry and delivery are verified; a reusable ancestry
gate, least-privilege publication review and measured runner-use improvements remain
open. T9 stays active because every candidate needs fresh review, exact-head CI,
promotion and publication evidence.

## Delivered checkpoint and remaining work

The owner selected **1.9.1** on 2026-09-20 as a checkpoint of integrated T3 regression
qualification, foundation alignment, Node 24 baseline and Q0 widget commitment fixes,
and explicitly added [CLI cookie-file handoff](../design/cli-cookie-file-handoff.md).
The cookie slice passed failing-first parser/CLI tests and real compiled-CLI import,
authenticated fixture, private export and re-import checks through the packaged and
installed service. It reuses existing jobs and acceptance hosts with no new runtime
dependency or CI job.

The broader [job-application workflow](../design/t6-job-application-checkpoint.md),
Q0a custom-adapter callback hardening, popup ownership/readiness, production verifier
configuration, durable recovery and installed third-party harness qualification remain
deferred. Do not represent these as completed or supported by cookie import.

The published and locally installed baseline is **1.9.1**. Existing running services
were preserved rather than restarted during qualification. Every later candidate still
requires its own design gates, review, exact-head/post-merge CI, protected-main promotion,
artifact verification and tap delivery.

## Runtime checkpoint

The merged Node 24 baseline pins local development, existing CI and release jobs,
and the container build stage to Node 24.21.0. The immutable Playwright 1.62.1 runtime
image supplies Node 24 and the existing Docker smoke now rejects a different runtime
major. This changes no job graph or release version. Exact source and image inspection
are recorded in the [Node 24 baseline evidence](../evidence/node24-baseline.md).

Node 22 remains the published minimum and type-library floor. Before merging, run a
bounded Node 22 compatibility check plus the existing Node 24 build, compiled-client,
extracted-server and Docker acceptance paths. Exact-head CI and post-merge evidence
remain required; this baseline alone does not qualify or trigger a release.
