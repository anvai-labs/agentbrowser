# Release milestones and acceptance gates

Status: release acceptance in progress, updated 2026-09-07. The owner selected
including snapshot resilience in the next release **after independent review
and CI**. This record does not itself authorize a tag,
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
and timeout/test gaps. The independently reviewed correction merged in
[PR 98](https://github.com/anvai-labs/agentbrowser/pull/98) at `0b65103`; all eight
[post-merge checks](https://github.com/anvai-labs/agentbrowser/actions/runs/34160978203)
passed. Version preparation subsequently merged in PR 100 at `ae5bcda`.
Promotion [PR 99](https://github.com/anvai-labs/agentbrowser/pull/99) is held in
draft until acceptance and upgrade documentation are complete. The owner retained
1.8.5 after reviewing compatibility: this is an explicit versioning exception,
not a universally drop-in or bug-fix-only SemVer patch. Custom-policy embedders
must follow the [upgrade requirements](operations.md#upgrading-from-184-to-the-185-candidate).
Review the additional integrated changes in the final release compatibility check.

Ship a coherent, usable improvement, not an arbitrary number of PRs. Do not
hold verified local-mode fixes for the gateway/containment program.

| Milestone | Cohesive scope | Promotion / release condition | Version guidance |
| --- | --- | --- | --- |
| M1: local reliability checkpoint | T2b0–T2b2, reviewed snapshot resilience, packaged/installed acceptance checks | Snapshot and smoke units independently reviewed and merged; exact candidate and post-merge CI green; release gates below satisfied | Owner selected `v1.8.5` with explicit additive-API exception and custom-policy migration notice |
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
| S1: snapshot resilience | Failing-before/fixed-after real Playwright regressions, stable-ref/semantic-staleness safety and bounded timeout recovery; independent adversarial review, eight PR checks and post-merge CI | Complete: PR 98, `0b65103`, all eight post-merge checks green (linked above); local Obscura limitation retained in review record |
| S2a: executable acceptance | Shared exact-version CLI/MCP checks, supported protocol/catalog, bounded output/deadlines, validated shutdown, failure-path tests and publication dependency ordering | Implemented on `ci/release-executable-acceptance`; independent re-review approved after correcting reproduced false passes; PR/post-merge CI pending |
| S2b: packaged workflow acceptance | Extracted-package real-browser/download/snapshot workflow, stock default-deny control, pre-tag candidate packaging CI, published/npm and installed profiles; explicit platform coverage | Pending; S2a handshake/help checks are not browser or installed-workflow proof. Both S2a and S2b are required before release |
| S3: release preparation | Version synchronization, compatibility/migration notes and operator documentation; exact candidate verification and develop-to-main promotion PR | PR 100 prepared 1.8.5 early; owner retained this label with explicit compatibility exceptions. Upgrade notes and corrected CLI/MCP ten-minute help implemented; review/CI pending. PR 99 remains draft until acceptance completes |
| S4: consumer delivery | Verify published artifacts/npm, update all twelve Homebrew artifact references together, run tap CI and controlled installed-version smoke | After successful release gates; separate tap PR, then final evidence and merged-branch cleanup |

Prefer one worktree sequentially; do not create another delivery stack. The
merged snapshot worktree was removed, reclaiming about 146 MB. A concurrently
created release-preparation worktree is now owned by this release effort;
remove it after confirming its merged content and clean state.
Record review/CI URLs against each row as evidence becomes available.

## Adversarial release review ledger

Independent review covers the executable harness separately from the integrated
release contracts. Fixes require regression evidence and re-review; green CI
does not waive a confirmed finding. No row below closes the S2b gate.

| ID | Finding / severity | Fix and acceptance | Status |
| --- | --- | --- | --- |
| RA1 | MCP smoke can pass with trailing malformed output or unsuccessful exit / high | Close stdin, drain output, validate zero exit and complete frames before success; malformed-tail, exit-7 and stalled-shutdown controls | Fixed; independent S2a re-review approved; CI pending |
| RA2 | MCP smoke accepts an incompatible protocol string / medium | Require negotiated `2024-11-05`; incompatible-version control | Fixed; independent S2a re-review approved; CI pending |
| RA3 | npm can publish before binary/server acceptance / high | Gate npm on tag guard and both build/acceptance matrices; server also depends on tag guard; workflow dependency regression | Fixed; independent S2a re-review approved; CI pending |
| RA4 | CLI/MCP still advertise a two-minute idle default / medium | Correct both descriptions to ten minutes without adding a client-side override; failing-before/passing-after surface tests | Fixed; final review/CI pending |
| RA5 | Custom-policy migration and additive-version exception not visible to operators / high | Owner retained 1.8.5; link explicit upgrade requirements from changelog, preserve all custom rules in immutable snapshots and close/recreate after policy changes | Documented; final review pending; no universal compatibility claim |
| RA6 | Page listing returns registered secrets in live URLs / high | Redact returned views; synthetic registered-secret service/REST regression | Fixed; nine focused API regressions pass; independent re-review/CI pending |
| RA7 | Optional URL acquisition can block page-ID discovery indefinitely / medium | Optional synchronous cached-URL capability, no backend I/O; verify hanging async getter is never called and unavailable URL is omitted | Fixed; API regressions and one real-Chromium cache/ref test pass; independent re-review/CI pending |
| RA8 | Malformed custom cached-URL values can violate the response schema / low | Omit non-string metadata; null and promise-valued adapter controls | Fixed; both controls failed before normalization and pass afterward; independent re-review/CI pending |

Final correction review: **approved, no remaining blocking findings in RA1–RA8**.
The status cells above preserve the implementation checkpoints; this re-review
supersedes their pending-review labels, but not CI gates. Independent checks:
16 executable/version tests, 36 CLI tests, 43 MCP tests, nine page-listing API
regressions, one real-Chromium cache/ref regression and 163 documentation links.
Native Bun CLI/MCP 1.8.5 version/protocol smokes also pass. Obscura cache
inheritance was inspected in source, not runtime-tested locally. Full hooks and
fresh PR/post-merge CI are required before merging this correction unit.

Page listing still scans the service's global page map;
a session index remains lower-priority debt, not a claim of indexed lookup.

## What the smoke unit must prove

Existing checks are useful but cover different layers:

| Existing evidence | Missing release acceptance |
| --- | --- |
| `release:artifacts` checks built workspace versions using FakeEngine | Exact downloaded/installed server, CLI and MCP versions agree with an explicitly supplied expected release version |
| Version-aware compiled MCP initialize/catalog/shutdown and CLI version/help smoke (S2a) | Installed MCP tool call and CLI command reach the real installed API/browser, not just boot successfully |
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

S2a makes server packaging depend on tag guard and gates npm publication behind
the existing binary/server acceptance jobs. The previous workflow allowed npm
to publish before those jobs finished; S2b still must deepen their acceptance
and add pre-tag execution. Cross-registry publication cannot
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
