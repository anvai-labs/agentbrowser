# Release milestones and acceptance gates

Status: release sequencing proposal, updated 2026-09-07. The owner selected
including snapshot resilience in the next release **after independent review
and CI**. This record does not mark snapshot work complete or authorize a tag,
publication, managed-service restart, or containment deployment.

## Baseline and release boundaries

Published baseline: `v1.8.4` on GitHub, npm and Homebrew. `develop` at
`e38189c` contains T2b0–T2b2 ([PR 92](https://github.com/anvai-labs/agentbrowser/pull/92),
[PR 93](https://github.com/anvai-labs/agentbrowser/pull/93),
[PR 94](https://github.com/anvai-labs/agentbrowser/pull/94)). PR 94 received
independent lifecycle and transport approval; all eight PR and
[post-merge checks](https://github.com/anvai-labs/agentbrowser/actions/runs/34143841691)
passed. Those changes are not yet released. Snapshot resilience merged in
[PR 95](https://github.com/anvai-labs/agentbrowser/pull/95) at `9eeb624`, followed
by page listing (PR 97) and the idle-timeout change (PR 96), bringing develop to
`b754262`. [Release review](snapshot-release-review.md) found snapshot validation
and timeout/test gaps. A focused correction is implemented and independently
approved; fresh follow-up PR/post-merge CI still gates its release acceptance.
Review the additional integrated changes in the final release compatibility check.

Ship a coherent, usable improvement, not an arbitrary number of PRs. Do not
hold verified local-mode fixes for the gateway/containment program.

| Milestone | Cohesive scope | Promotion / release condition | Version guidance |
| --- | --- | --- | --- |
| M1: local reliability checkpoint | T2b0–T2b2, reviewed snapshot resilience, packaged/installed acceptance checks | Snapshot and smoke units independently reviewed and merged; exact candidate and post-merge CI green; release gates below satisfied | Tentatively `v1.8.5`, only after confirming supported public contracts remain compatible |
| M2: gateway design checkpoint | T2c authentication, ownership, revocation, resource bounds and integration contract | Independently reviewed design with explicit failure/acceptance matrix | No release solely for a design document or unused internal primitive |
| M3: usable opt-in gateway | Small end-to-end gateway capability with installation, lifecycle and cross-session tests | Supported consumer can install and exercise the capability; guarantees and limitations documented | Usually minor for a new public capability; otherwise wait for a usable slice |
| M4: contained-browser checkpoint | Supported browser integration, gateway enforcement and OS-enforced gateway-only egress | T1–T4 acceptance passes, including worker/redirect/WS/WSS coverage and bypass controls; deployment approval obtained | Decide from actual public contract; never label an earlier milestone “contained” |

Maintain lockstep first-party package versions using the existing root version
and synchronization script. A patch is not automatic: review snapshot behavior
and custom network-policy snapshot requirements for compatibility. A breaking
supported contract needs migration/version reconsideration, not a patch label.
Urgent corrective patches can interrupt this sequence when justified.

M4 pulls forward only the necessary OS containment slice of ADR-008. Full
multi-tenant process/container isolation remains deferred for trusted local
deployments. Native/Homebrew delivery is not hostile-browser containment.
The [transport integration contract](transport-integration-contract.md) and
[remediation tracker](engineering-review-remediation.md) retain the detailed
security scope; this document tracks release completion, not R4 closure.

## M1 cohesive work units

| Unit | Deliverable and acceptance | Dependency / current status |
| --- | --- | --- |
| S1: snapshot resilience | Finish the existing branch; failing-before/fixed-after regression with real Playwright for the claimed failure; verify stable refs, semantic-staleness safety, timeout versus unrelated-error handling and inherited Obscura behavior where affected; independent adversarial review, eight PR checks and post-merge CI | PR 95 merged; follow-up safety correction independently approved; fresh CI pending |
| S2: release acceptance | Reusable version-aware smoke harness and release-workflow wiring; deterministic fixtures, bounded deadlines, unconditional cleanup and machine-readable evidence; independently reviewed | Proposed next implementation unit; candidate snapshot assertion depends on S1's accepted behavior |
| S3: release preparation | Version synchronization, compatibility/release notes and operator documentation; exact candidate verification and develop-to-main promotion PR | After S1/S2 merge and post-merge CI; do not mix gateway implementation into this unit |
| S4: consumer delivery | Verify published artifacts/npm, update all twelve Homebrew artifact references together, run tap CI and controlled installed-version smoke | After successful release gates; separate tap PR, then final evidence and merged-branch cleanup |

Prefer one worktree sequentially; do not create another delivery stack. The
snapshot correction uses one approved temporary worktree because another task
is actively editing the main checkout. Remove that worktree after delivery.
Record review/CI URLs against each row as evidence becomes available.

## What the smoke unit must prove

Existing checks are useful but cover different layers:

| Existing evidence | Missing release acceptance |
| --- | --- |
| `release:artifacts` checks built workspace versions using FakeEngine | Exact downloaded/installed server, CLI and MCP versions agree with an explicitly supplied expected release version |
| Compiled MCP initialize/catalog smoke; CLI help smoke | Installed MCP tool call and CLI command reach the real installed API/browser, not just boot successfully |
| Extracted server tarball navigates to example.com and observes its title | Snapshot, safe action, valid nonempty screenshot/PDF artifacts where supported, download behavior and session cleanup |
| Native Bun HTTP/HTTPS transport controls | Packaged production Node server exercises T2b behavior; Bun remains additional runtime evidence |
| Tap CI audits, freshly installs and runs formula help tests on Linux | Controlled prior-version upgrade and real installed workflow, with platform/runtime coverage stated explicitly |
| npm publish checks registry version metadata | Download and execute the exact published npm package's MCP protocol smoke |

Use one dependency-light harness with explicit expected version, executable
paths/server URL and baseline/candidate profile. Do not compare an older release
to the current checkout's package version. `v1.8.4` already has snapshot and
download routes; only the new regression semantics are candidate-specific.

The minimum behavioral sequence is create session/page, navigate, observe and
snapshot, perform a safe action, retrieve and validate artifacts, then close.
Add HTTP/HTTPS download controls, default policy denial, host/byte limits, a
candidate cancellation control and the accepted snapshot regression. Record
pass/fail/unsupported separately; an unsupported backend is not a passing test.

Keep two test contexts explicit: the stock launcher must retain its private-IP
denial, while deterministic local positive HTTP/TLS fixtures may use a separate
test process importing **extracted package modules** with an injected policy and
fixture trust. Drive the real packaged service/session download route and
session-close cancellation, not merely an isolated `DownloadTransport` instance.
That process proves packaged service integration, not stock policy configuration.
Never relax shipped defaults or install a host CA for smoke tests.
Use isolated ports/state/cache as needed and always close sessions/processes in
cleanup, including failures; do not restart the user's running Brew service.

Expose candidate packaging and the same acceptance harness in PR CI or an
untagged candidate invocation. Wiring only the current tag-triggered release
workflow cannot establish the required pre-tag acceptance evidence.

Workflow alignment belongs with S2: make server packaging depend on tag guard,
and gate npm publication behind candidate artifact acceptance. Today npm can
publish before binary/server smoke finishes. Cross-registry publication cannot
be atomic; record partial publication and recover deliberately. Investigate
Linux ARM binary runtime coverage (currently skipped despite an ARM server job)
and distinguish Darwin x64 tarball smoke on ARM Node from actual x64 runtime
coverage. Correct release notes' nine-tool claim (the smoke expects eleven) and
the operations guide's outdated source-only CLI installation guidance.

## Repeatable promotion and release sequence

1. Merge reviewed S1/S2 units into `develop`, resolving against current develop
   as needed. Confirm all eight checks on each reviewed head and post-merge SHA.
2. Prepare the version/changelog unit from that integrated baseline. Run version
   consistency, workspace checks and candidate artifact acceptance. Merge only
   after review/CI; freeze the release candidate SHA and included PR list.
3. Open `develop` → `main` PR. Confirm exact-head CI, merge, verify main CI, and
   sync main back into develop after the merge. Do not fold unrelated work into
   the candidate while promotion is being validated.
4. On release authorization, tag the exact verified main release commit. Verify
   tag/manifest agreement and every release job, not merely tag creation.
5. Download published assets and verify their checksums, version stamps and
   applicable smoke profiles. Verify the exact published npm package too. The
   current matrix has fourteen binary/tarball assets plus `sha256sums.txt`.
6. Update the tap in one PR: all twelve MCP/CLI/server URLs and SHA-256 values
   must match that release's actual bytes and published checksum manifest.
   Require formula contract tests, audit/install tests and tap post-merge CI.
7. On a controlled consumer host, verify fresh installation and upgrade from
   the previous release, resolved executable paths and actual installed versions.
   Run the real workflow against an isolated installed server. Obtain permission
   before changing an existing installation or restarting a managed service.
8. Record the evidence below; only then mark M1 delivered and remove verified
   merged task branches/worktrees. Preserve unmerged work and retained evidence.

Do not silently retag or replace published asset bytes to repair a failed
release. The existing release upload permits clobbering, so this is an explicit
operating constraint until immutable-publication handling is implemented.

## Delivery evidence template

For each milestone record release version, main commit, included PRs, review and
CI URLs, release workflow result, asset checksums, npm version/integrity, tap PR
and merge commit, OS/architecture/runtime, resolved installed paths, expected
and observed versions, fresh-install/upgrade results, behavioral smoke output,
unsupported/skipped checks, and cleanup outcome. Keep each validation layer
separate: **integration green → published artifacts verified → installed release
verified**. Pending/skipped coverage must never be summarized as fully tested.
