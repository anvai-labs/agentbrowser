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

## Current release checkpoint

The published baseline is **1.27.1** (2026-10-20, main `a0d02ea`, run 39419989960, 14/14 green;
[release-1.27.1](../evidence/release-1.27.1.md)). Earlier records sit beside it (1.22.0:
owner-released, field handoff). Both `main` and `develop` are
protected with the same 11 strict required contexts and require a pull request (zero approving
reviews); `main` also enforces protection for admins, and neither allows force pushes or deletion. The eleven strict checks and immutable release assets
remain required. Label acceptance phases and measure their timing before changing
budgets. Durable recovery is opt-in and classification-only (never replay); installed
external-harness qualification and production use-case completion are not implied.

## Current implementation state

Main and develop are protected (see the checkpoint above). Historically develop
was unprotected, and each develop merge required an explicit operational review. The previous **1.9.0** checkpoint used exact
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
The 1.9.1 candidate's tag ancestry and delivery are verified. The reusable ancestry
gate now exists (2026-10-15): `scripts/check-tag-ancestry.mjs` runs in the release
`tag-guard` job, which every other release job depends on, and refuses a tag whose commit
is not reachable from `main`. Because GitHub runs the workflow *of the tagged commit*, the
gate does not bind a tag on an older or modified commit. **R14 closed 2026-10-16:**

| Gate | Setting |
| --- | --- |
| Release ancestry | `tag-guard` refuses a commit not reachable from `main` (#475) |
| Tag ruleset `release tags` (25241502) | `refs/tags/v*`: creation, deletion, update, non-fast-forward restricted; admin role bypasses |
| `npm` environment | owner is a required reviewer (self-review allowed; admins can bypass); deploys only from `v*` tags |
| Provenance | `actions/attest-build-provenance` signs every release asset; npm keeps `--provenance` |
| Immutability | the Release is drafted, filled, then published. Repository immutable releases are on since 1.20.0 (switched on after the promotion, before the tag) |
| First exercised | 1.20.0: the `v*` deployment policy and owner approval, attestations on all 16 assets, an immutable release |

**Least privilege and pinning (2026-10-15, S1c).** Every workflow now defaults to
`contents: read` at the top level (`ci.yml` previously inherited the repository default);
in `release.yml` only the `release` job, which creates the GitHub Release and uploads its
assets, holds `contents: write`, and `npm-publish` keeps only `id-token: write` for
provenance. `winget` pushes with its own app token, not `GITHUB_TOKEN`. All 67 action
references across the four workflows are pinned to the full commit SHA of their release
(annotated tags dereferenced to the commit) with a `# vX.Y.Z` comment, which Dependabot's
`github-actions` ecosystem keeps current. `scripts/release-workflow.test.mjs` (in
`test:release`) discovers every workflow file and refuses an unpinned or non-line-form action
reference, a top-level permissions block other than exactly `contents: read`, and any job-level
permissions block that is not exactly on its allowlist (`release.yml` `release`: contents write;
`npm-publish`: id-token write + contents read; `docs.yml` `deploy`: pages + id-token write).
It reads YAML with anchored regexes, so it also refuses forms it cannot read reliably (a commented `jobs:` or job key, non-two-space job keys, or any `permissions:` line it did not attribute). It checks SHA format offline; that a SHA is its tag's commit rests on review and Dependabot.

**Skipped/canceled required checks (S1b, documented invariant, checked 2026-10-15).** GitHub
reports a job skipped by its `if:` as *Success* to a required status check, and skips (does
not fail) a job whose `needs:` dependency failed or was canceled. The required contexts on
`develop`/`main` (Type Check, Lint, Test, Build, Docker, Benchmarks, Obscura (experimental), Bun compile +
smoke, Journal SQLite gates, `build`, `deploy`) are safe under both rules:
- the only `needs:` edges among the CI jobs are `Build` → Type Check + Lint and `Journal SQLite
  gates` → Type Check; when they skip, the failed upstream is itself required and still blocks
  (the docs workflow's `deploy` → `build` edge is covered below);
- `deploy` (docs site) is required but skipped on every pull request by design, so it never
  blocks a PR; it is a publication step, not a test, and its `build` sibling runs on every PR;
- every workflow that produces a required context runs unfiltered on pull requests
  (`paths-ignore`/`paths` apply to pushes only), so a docs-only PR cannot strand one; the
  path-filtered macOS journal leg (`journal-darwin.yml`) is deliberately not required;
- in `release.yml` every job `needs:` `tag-guard` and none uses `always()`/`!cancelled()`/
  `failure()` (pinned by `check-tag-ancestry.test.mjs`), so a failed or canceled
  prerequisite skips the publish jobs instead of running them.

No aggregate "all green" job exists whose own skip could be read as success, so none is
added. The discovery/schema/spec context check is already local and reused:
`pnpm release:artifacts` (`scripts/check-release-artifacts.mjs`) runs `spec-context.test.mjs`
and `checkSpecContext()` inside the existing CI and Windows jobs.

Runner minutes are now measured: [baseline](../evidence/t9-runner-minutes.md) from `scripts/runner-minutes.mjs`, 2026-10-15. Measured runner-use improvements remain open. T9 stays active because every candidate needs fresh review, exact-head CI,
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

At the time of this section the published and locally installed baseline was
**1.9.1** (historical — the current baseline is stated in the checkpoint above).
Existing running services were preserved rather than restarted during qualification. Every later candidate still
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
