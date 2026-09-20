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

Main/develop PR promotion, required checks, admin enforcement and force-push/deletion
blocks are in use. The published baseline is **1.9.0** at exact main/tag commit
`02f263f3764b41f923553c69c11dff69c819fae5`. Promotion PR 210, all eight main
checks and all twelve release jobs passed; published asset, checksum, npm and
package acceptance completed. Main was synchronized back to develop by PR 211
at `4dbd48921346057431468e8d1185c936283f5881`, with all eight post-merge checks,
and Homebrew PR 57 completed with all three post-merge checks. Exact links and
qualification limits are recorded in the [release tracker](../../release-milestones.md).

T3's first bounded report foundation then merged through PR 212 to develop as
`4dd96e9749f363ce8b78cdacccacfd4b87bf9b0b`; its eight PR and eight post-merge
checks passed. This starts T3 rather than completing it and creates no new release.
The 1.9.0 candidate's tag ancestry and delivery are verified; a reusable ancestry
gate, least-privilege publication review and measured runner-use improvements remain
open. T9 stays active because every candidate needs fresh review, exact-head CI,
promotion and publication evidence.

## Next checkpoint

Continue reviewed, green slices into develop; the foundation documentation and guard
fixes do not require a separate release. Reassess a release after T3's offline CLI
integration passes the compiled 13-case matrix. This is a checkpoint, not a promise
that all T3 reporting or portable deployment work is complete. Installed 1.9.0 remains
the released baseline until a separately qualified candidate completes the existing
main/tag/artifact/tap ladder. Do not bump versions or tag each develop commit.

## Runtime checkpoint

The Node 24 baseline candidate pins local development, existing CI and release jobs,
and the container build stage to Node 24.21.0. The immutable Playwright 1.62.1 runtime
image supplies Node 24 and the existing Docker smoke now rejects a different runtime
major. This changes no job graph or release version. Exact source and image inspection
are recorded in the [Node 24 baseline evidence](../evidence/node24-baseline.md).

Node 22 remains the published minimum and type-library floor. Before merging, run a
bounded Node 22 compatibility check plus the existing Node 24 build, compiled-client,
extracted-server and Docker acceptance paths. Exact-head CI and post-merge evidence
remain required; this baseline alone does not qualify or trigger a release.
