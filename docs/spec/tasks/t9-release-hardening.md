# T9: repository, CI and release hardening

Status: not started as a follow-up task. Repository: agentbrowser; coordinate separate
Victor delivery where changed. Depends on: T0 and each release candidate's acceptance.
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
