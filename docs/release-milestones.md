# Release milestones and acceptance gates

Status (2026-09-08): **local functional delivery is the active priority.**
v1.8.5 is published; M2 design and T2c1 are complete. Functional PRs 104-107
are merged to develop but are not yet released. The owner has deferred new
gateway, browser-enforcement and containment work for trusted single-user
local/intranet use. Resume with **L1** below, not T2c2.

This document is the sequencing source of truth. Historical M1-M4 identifiers
and security findings remain intact; deferral is not completion or a claim that
Internet pages are trusted. Existing safeguards, review and CI stay in place.

## Baseline and release boundaries

Published baseline: **v1.8.5**, exact release commit
`b9ef2fde1ee8a3fcfc65ba9dd6cddaffa3ab337d`, with main/develop synchronized at that release after
[promotion PR 99](https://github.com/anvai-labs/agentbrowser/pull/99).
T2b0-T2b2 (PRs 92-94), snapshot resilience/review corrections (PRs 95/98), idle
timeout/page discovery (PRs 96/97), version preparation (PR 100), and adversarial
release acceptance (PRs 101/102) are shipped. All eight
[main checks](https://github.com/anvai-labs/agentbrowser/actions/runs/34172753251)
and all twelve [release jobs](https://github.com/anvai-labs/agentbrowser/actions/runs/34176426799)
passed. All fourteen downloaded assets matched published hashes; all four server
archives stamped the exact clean release commit. Published Darwin ARM binaries
and the exact npm MCP package each passed the six-group real-browser workflow.
Registry integrity, signature and provenance attestation were verified.

[Tap PR 30](https://github.com/anvai-labs/homebrew-tap/pull/30) updated all twelve
references, passed two independent reviews and all three
[PR](https://github.com/anvai-labs/homebrew-tap/actions/runs/34179182998) and
[post-merge checks](https://github.com/anvai-labs/homebrew-tap/actions/runs/34181374079).
Linux CI performed actual Homebrew installation and CLI/MCP tests. The
[delivery closeout](https://github.com/anvai-labs/agentbrowser/pull/99#issuecomment-5578850103)
records exact evidence and limitations. Temporary merged work and generated
assets were removed, reclaiming approximately 1.05 GiB; reports and original
server/npm archives were retained. The owner subsequently reported the local
upgrade and restart complete; full installed-server workflow evidence remains
unverified. A new functional candidate needs its own installed-workflow evidence;
the owner's earlier upgrade/restart confirmation does not supply it.

The owner retained 1.8.5 as an explicit versioning exception, not a universally
drop-in or bug-fix-only SemVer patch. Custom-policy embedders must follow the
[upgrade requirements](operations.md#upgrading-from-184-to-the-185-candidate).

Ship a coherent, usable improvement, not an arbitrary number of PRs. Do not
hold verified local-mode fixes for the gateway/containment program.

| Milestone | Cohesive scope | Promotion / release condition | Version guidance |
| --- | --- | --- | --- |
| M1: local reliability checkpoint | T2b0–T2b2, reviewed snapshot resilience, packaged/installed acceptance checks | Snapshot and smoke units independently reviewed and merged; exact candidate and post-merge CI green; release gates below satisfied | Owner selected `v1.8.5` with explicit additive-API exception and custom-policy migration notice |
| M2: gateway design checkpoint | [T2c authentication, ownership, revocation, resource bounds and integration contract](session-gateway-m2-scope.md) | Complete: [PR 103](https://github.com/anvai-labs/agentbrowser/pull/103), two clean independent reviews, eight green PR checks, merge `46807ea`; docs-only post-merge push skips CI by design | No release solely for a design document or unused internal primitive |
| M3: usable opt-in gateway — deferred | Small end-to-end gateway capability with installation, lifecycle and cross-session tests | Not a dependency of local functional delivery; requires a new owner decision before resuming | No gateway release planned |
| M4: contained-browser checkpoint — deferred | Supported browser integration, gateway enforcement and OS-enforced gateway-only egress | Not a dependency of local functional delivery; T1–T4 acceptance still required if containment is later promised | No contained release planned |

T2c1 destination-policy adaptation and joint TCP admission completed in
[PR 108](https://github.com/anvai-labs/agentbrowser/pull/108), merge `92a845a`.
Two independent reviews, all eight [PR checks](https://github.com/anvai-labs/agentbrowser/actions/runs/34219078275)
and all eight [post-merge checks](https://github.com/anvai-labs/agentbrowser/actions/runs/34222956375)
passed. The [closeout](https://github.com/anvai-labs/agentbrowser/pull/108#issuecomment-5585656070)
supersedes intermediate pending labels in its implementation record. Keep the
merged code and unchanged download behavior; no rollback or gateway follow-on
is required. It does not itself warrant a release.

Maintain lockstep first-party package versions using the existing root version
and synchronization script. A patch is not automatic: review snapshot behavior
and custom network-policy snapshot requirements for compatibility. A breaking
supported contract needs migration/version reconsideration, not a patch label.
Urgent corrective patches can interrupt this sequence when justified.

If resumed, M4 would pull forward only the necessary OS containment slice of ADR-008. Full
multi-tenant process/container isolation remains deferred for trusted local
deployments. Native/Homebrew delivery is not hostile-browser containment.
The [transport integration contract](transport-integration-contract.md) and
[remediation tracker](engineering-review-remediation.md) retain the detailed
security scope; this document tracks release completion, not R4 closure.

## Local functional pivot: priority and sequence

Owner decision, 2026-09-08: prioritize useful local browsing over additional
security infrastructure. Trusted local/intranet access to the service is the
operating assumption, not a guarantee about visited Internet content.

- **Active:** real-browser workflow reliability, existing feature integration,
  actionable diagnostics, packaged/installed acceptance and consumer delivery.
- **Retained:** access controls, network-policy checks, secret redaction,
  approvals, timeouts, resource bounds and existing regression gates. This pivot
  authorizes neither broad private-network access nor disabling safeguards.
- **Deferred:** T2c2 CONNECT parser/relay and credential registry; T2c3/M3
  gateway lifecycle/delivery; further T1 inquiry/probes, T3 browser-enforcement
  integration and T4/M4 forced egress. Full ADR-008 multi-tenancy stays deferred.
  Preserve R4/T1 as open limitations, not closed findings or local-release gates.
- **Revisit only by explicit decision:** a concrete hosted/shared-service need,
  a requirement for enforced network containment, or new evidence that affects
  the accepted local-use assumptions. Do not auto-resume the deferred program.

### Reconciled integration checkpoint

As verified for this planning update, develop is `763bfa7`; published/main
baseline remains `b9ef2fd` (v1.8.5). Re-fetch on resume: these are evidence
checkpoints, not a frozen future release candidate. No functional PR is open.

| Unit | Integration status | Delivery status / evidence |
| --- | --- | --- |
| PR 104: timeout diagnostics, overlays, link hrefs, refusal details | Merged `fb4dc77` | All eight [post-merge checks](https://github.com/anvai-labs/agentbrowser/actions/runs/34230609476) green; unreleased |
| PR 105: waits, opt-in remap, action-step batches | Merged `65bd139` | All eight [post-merge checks](https://github.com/anvai-labs/agentbrowser/actions/runs/34230626361) green; unreleased |
| PR 106: inline artifacts and popup lifecycle | Merged `6616afa` | All eight [post-merge checks](https://github.com/anvai-labs/agentbrowser/actions/runs/34230640863) green; unreleased |
| PR 107: human handoff and synthetic-input limitations | Merged `763bfa7` | All eight [PR checks](https://github.com/anvai-labs/agentbrowser/actions/runs/34230046626) green; docs-only post-merge push skips CI; unreleased docs |
| PR 108: destination policy and shared admission | Merged `92a845a`, ancestor of this checkpoint | Review and PR/post-merge CI complete; retained internal prerequisite, unreleased |

These checks are not evidence that a newly installed package exercises all of
104-107 together. Do not reimplement the merged features or equate integration
with publication. Their combined functional acceptance is L1's scope.

### Active cohesive work units

Execute sequentially, with one task branch/worktree at a time. Do not create a
new feature backlog until a user workflow or a reproduced failure justifies it.

| Order / priority | Cohesive unit | Acceptance and handoff | Status |
| --- | --- | --- | --- |
| L1 / now | Integrated functional acceptance for PRs 104-107 on fresh develop | Inventory existing coverage; extend the shared packaged real-Chromium harness only for missing cases below; independent review and eight exact-head PR checks, plus post-merge CI where configured (record intentional docs-only skips, never call them green); report failures separately from unsupported behavior | **Next; not yet executed** |
| L2 / conditional | Small reproduced functional fixes from L1 | Failing test first, smallest cohesive fix, unchanged defaults/compatibility checked, independent review and green PR/post-merge CI; rerun affected integrated workflow | Not scoped; skip if L1 finds no defect, loop back to L1 after fixes |
| L3 / after L1 passes | Functional release preparation and promotion | Record included PRs and exact candidate SHA; compatibility/version decision, lockstep sync, changelog and packaged acceptance; reviewed develop-to-main PR, main CI, then main-to-develop sync | Pending; version not selected, no promotion performed |
| L4 / after release authorization | Publish and deliver the functional milestone | Tag only verified main; all release jobs green; published asset/npm verification; one tap PR updating all twelve references, tap CI; isolated installed workflow and approved upgrade/restart; durable evidence and scoped cleanup | Pending; no tag, publication, tap update or restart authorized by this planning edit |

L1's bounded functional matrix:

| Workflow | Required observable result |
| --- | --- |
| Navigate, observe, snapshot, act | Existing refs and default action behavior still work; link hrefs/optional overlays appear only under their intended contract |
| Waits and timeout diagnostics | Supported waits succeed and expire predictably; timeout details identify the tested blocker without changing the public error contract |
| Opt-in remap and action-step batches | Opt-in behavior works; default remains unchanged; ordered results and failure/partial-execution semantics match the merged contract |
| Tabs/popups | A popup is discoverable and usable; close removes it without stale registrations or leaking the session |
| Evidence and downloads | Inline and existing artifact paths return valid nonempty bytes; HTTP/HTTPS download and cancellation regressions still pass |
| Human handoff and input limitations | Documented handoff can be resumed in a controlled workflow; clearly report unsupported synthetic interactions rather than promise bypasses |
| Delivered surfaces and cleanup | Exercise applicable API, SDK, CLI and MCP paths through their existing contracts; do not invent a CLI counterpart for every API option; clean sessions/processes on success and failure |

Use deterministic local fixtures and an isolated candidate server. Do not visit
private intranet applications, use real credentials, restart the owner's Brew
service, or change host networking merely to run acceptance. Optional live-site
checks need explicit targets/authority and are not the deterministic CI gate.
Retain existing default-deny/secret controls without expanding the deferred
security program. Record exact executable/source identity and platform limits.

### Resume instructions

1. Re-read this pivot and check clean worktree, current develop/main, open PRs,
   CI and latest release. Preserve unrelated worktrees and owner changes.
2. Start L1 from current merged develop. Read the 104-107 diffs and existing
   `scripts/release-smoke*.mjs` / packaging harness coverage; tabulate actual
   gaps against the matrix before adding tests. An implementation PR is needed
   only where acceptance coverage or a reproduced functional defect needs code.
3. Record L1 evidence and any L2-sized defects here. Do not start T2c2 or choose
   a release version merely because the earlier transport sequence listed it next.
4. Stop at a verified functional checkpoint before L3/L4 delivery actions. The
   v1.8.5 patch exception is not automatic permission for another patch label;
   assess the additive public contract and obtain the release-version decision.

## M1 cohesive work units

| Unit | Deliverable and acceptance | Dependency / current status |
| --- | --- | --- |
| S1: snapshot resilience | Failing-before/fixed-after real Playwright regressions, stable-ref/semantic-staleness safety and bounded timeout recovery; independent adversarial review, eight PR checks and post-merge CI | Complete: PR 98, `0b65103`, all eight [post-merge checks](https://github.com/anvai-labs/agentbrowser/actions/runs/34160978203) green; shipped v1.8.5; local Obscura limitation retained |
| S2a: executable acceptance | Shared exact-version CLI/MCP checks, supported protocol/catalog, bounded output/deadlines, validated shutdown, failure-path tests and publication dependency ordering | Complete: independently reviewed PR 101 merged at `c0c4ac4`; all eight PR and post-merge checks green |
| S2b: packaged workflow acceptance | Extracted-package real-browser/download/snapshot workflow, stock default-deny control and pre-tag candidate packaging CI; explicit platform coverage and baseline limitations | Complete: independently reviewed PR 102, all eight [PR](https://github.com/anvai-labs/agentbrowser/actions/runs/34166795074) and [post-merge checks](https://github.com/anvai-labs/agentbrowser/actions/runs/34171582012) green; shipped v1.8.5 |
| S3: release preparation | Version synchronization, compatibility/migration notes and operator documentation; exact candidate verification and develop-to-main promotion PR | Complete: PRs 100/101/102 followed by promotion PR 99; main CI and release gates green; compatibility exception retained |
| S4: consumer delivery | Verify published artifacts/npm, update all twelve Homebrew artifact references together, run tap CI and controlled installed-version smoke | Published/npm acceptance, tap PR/post-merge CI and cleanup complete; owner reports local upgrade/restart done; full installed-server workflow evidence not yet verified |

Prefer one worktree sequentially; do not create another delivery stack. The
merged snapshot and release-preparation worktrees were each removed after
verification, reclaiming about 146 MB each. S2b uses the single shared checkout.
Record review/CI URLs against each row as evidence becomes available.

## Adversarial release review ledger

Independent review covers the executable harness separately from the integrated
release contracts. Fixes require regression evidence and re-review; green CI
does not waive a confirmed finding. RA1-RA8 close S2a; S2b has its separate
PA1-PA10 review and completed CI evidence below.

| ID | Finding / severity | Fix and acceptance | Status |
| --- | --- | --- | --- |
| RA1 | MCP smoke can pass with trailing malformed output or unsuccessful exit / high | Close stdin, drain output, validate zero exit and complete frames before success; malformed-tail, exit-7 and stalled-shutdown controls | Closed: reviewed PR 101; eight PR/post-merge checks green |
| RA2 | MCP smoke accepts an incompatible protocol string / medium | Require negotiated `2024-11-05`; incompatible-version control | Closed: reviewed PR 101; eight PR/post-merge checks green |
| RA3 | npm can publish before binary/server acceptance / high | Gate npm on tag guard and both build/acceptance matrices; server also depends on tag guard; workflow dependency regression | Closed: reviewed PR 101; eight PR/post-merge checks green |
| RA4 | CLI/MCP still advertise a two-minute idle default / medium | Correct both descriptions to ten minutes without adding a client-side override; failing-before/passing-after surface tests | Closed: reviewed PR 101; eight PR/post-merge checks green |
| RA5 | Custom-policy migration and additive-version exception not visible to operators / high | Owner retained 1.8.5; link explicit upgrade requirements from changelog, preserve all custom rules in immutable snapshots and close/recreate after policy changes | Closed: reviewed PR 101; no universal compatibility claim |
| RA6 | Page listing returns registered secrets in live URLs / high | Redact returned views; synthetic registered-secret service/REST regression | Closed: reviewed PR 101; nine API regressions and green CI |
| RA7 | Optional URL acquisition can block page-ID discovery indefinitely / medium | Optional synchronous cached-URL capability, no backend I/O; verify hanging async getter is never called and unavailable URL is omitted | Closed: reviewed PR 101; API/cache-ref regressions and green CI |
| RA8 | Malformed custom cached-URL values can violate the response schema / low | Omit non-string metadata; null and promise-valued adapter controls | Closed: reviewed PR 101; failing-before/passing-after controls and green CI |

Final correction review: **approved, no remaining blocking findings in RA1–RA8**.
All RA1–RA8 rows are now closed by [PR 101](https://github.com/anvai-labs/agentbrowser/pull/101),
merged at `c0c4ac4`, with all eight [PR checks](https://github.com/anvai-labs/agentbrowser/actions/runs/34163254664)
and [post-merge checks](https://github.com/anvai-labs/agentbrowser/actions/runs/34163544230)
green.
Independent checks:
16 executable/version tests, 36 CLI tests, 43 MCP tests, nine page-listing API
regressions, one real-Chromium cache/ref regression and 163 documentation links.
Native Bun CLI/MCP 1.8.5 version/protocol smokes also pass. Obscura cache
inheritance was inspected in source, not runtime-tested locally. Full commit and
push hooks passed; local conditional backend skips are not full backend proof.

Page listing still scans the service's global page map;
a session index remains lower-priority debt, not a claim of indexed lookup.

## Packaged acceptance review ledger (S2b)

These changes formed packaging/acceptance PR 102. The table preserves historical
implementation evidence; its intermediate pending labels are superseded by the
final approval and completed PR/post-merge CI recorded here and in S2b above.

| ID | Finding / severity | Fix and acceptance | Status |
| --- | --- | --- | --- |
| PA1 | Extracted dependencies can resolve back into the workspace / high | Audit the bounded full dependency tree, declared API dependency entrypoints and first-party versions; normalize only pnpm's verified API self-link inside owned staging; verify its physical parent before mutation | Real archive reproduced the escaping self-link; outside-parent mutation regression failed before and passes after correction; packager re-review approved |
| PA2 | Dirty source or caller-supplied SHA can masquerade as an exact release / high | Require actual HEAD and clean tracked/untracked state; reject mismatched SHA; explicit local dirty builds stamp `dirty: true` and cannot report release evidence | Negative controls pass; exact clean candidate CI pending |
| PA3 | Signature-only screenshot/PDF checks accept malformed bytes / high | PNG chunk bounds/names/CRC, bounded full zlib consumption and scanline checks for Chromium RGB/RGBA output; acceptance-only qpdf parser plus page count; malformed and valid fixtures | Five tests pass locally with qpdf 12.3.1, including high-bit/reserved-name rejection; final re-review pending; not a general image/PDF security scanner |
| PA4 | Fault injection can silently stop exercising snapshot failures / high | Assert body/element capture counters and unchanged page state after rejected actions; exercise named unbound and unnamed bound controls | Extracted-package local controls pass; harness safety re-review approved; final closure audit pending |
| PA5 | Total snapshot timeout misclassifies an observed but unbound named target / medium | Return retryable `STALE_TARGET` for an existing ref lacking a safe binding; unknown refs remain `TARGET_NOT_FOUND` | Real-Chromium failing-before regression fixed; all 36 snapshot tests pass on rerun |
| PA6 | Workflow failure can leave processes, sessions or extraction state behind / medium | Bounded requests/output/IPC, owned fixture/process/session cleanup, extraction EXIT traps; forced API termination is failure with descendant cleanup unverified | Failure-path tests implemented; full runtime/re-review pending |
| PA7 | Tag-only smoke and skipped ARM clients overstate pre-release coverage / medium | Share packager/harness between PR and release CI, run native Linux ARM clients, document Darwin x64-on-ARM/Rosetta and Windows-client-only limits | Workflow implemented; CI pending |
| PA8 | CLI advertises authentication but never forwards the API key to its SDK / high | Pass the existing option through the shared client factory; flag precedence and environment fallback regressions; real compiled CLI against authenticated packaged API | Three failing-before authentication cases fixed; 41 CLI tests and native authenticated packaged workflow pass; final review/CI pending |
| PA9 | Missing transitive modules can resolve from ancestor directories or inherited `NODE_PATH` / high | Clear inherited Node search overrides and audit packaged dependency resolution from each package, with explicit optional-dependency handling and an ancestor-fallback negative control | Confirmed review finding; correction in progress |
| PA10 | Operator guide claims CLI/SDK environment-variable behavior they do not implement / medium | Document explicit SDK `ClientOptions`; CLI URL uses `--base-url`, API key uses flag/env; MCP retains its environment contract | Documentation corrected; no additional runtime behavior introduced |

Final independent S2b code review: **approved; no remaining confirmed blocking
findings in PA1–PA10**. Exact-head PR and post-merge CI also passed (S2b links
above), superseding all intermediate pending labels. Forty release/packaging/
acceptance tests pass, as do two API policy tests, 41 CLI tests and 36 real-
Chromium snapshot tests. The extracted Darwin ARM candidate passes all six
workflow groups with Node 24.11.1 and qpdf 12.3.1; its dependency audit finds
76 contained packages and 101 dependency edges. Native CLI and MCP report 1.8.5,
the PDF parser reports one page, and API/fixture cleanup completed gracefully.
The initial local archive was built from dirty work at base `c0c4ac4` and explicitly
reports `releaseEvidence: false`; it was not release proof. Subsequent clean
candidate CI, tagged release acceptance and downloaded-package validation
passed; see the current release checkpoint above.
The JSON report is retained at
`/private/tmp/agentbrowser-s2b-v3.GfoHFV/acceptance.json` until evidence cleanup.

The 36-test snapshot run initially hit one timeout in an unchanged existing test;
that test passed unchanged in isolation and the complete suite then passed.
No timeout was widened to hide the transient failure.

### Published baseline limitation

The exact published `v1.8.4` Darwin ARM server archive was downloaded and its
SHA-256 verified against the release manifest:
`bca1a8103a5904ab3398f5f9e5e02d3bb40f2b4ffb3aa7878db5093c0121f248`.
Its pnpm API self-link points outside the extracted package. The strict tree
audit rejects this archive; do not rewrite published bytes or call that a pass.
Additionally, 1.8.4 lacks the trusted `buildServer({ networkPolicy })` seam used
by the isolated positive fixtures. A baseline profile therefore cannot claim
the candidate's injected workflow coverage. Baseline/upgrade acceptance remains
an explicit S4 limitation to resolve on a controlled consumer host, not proof
provided by a dirty local candidate or by a workspace fallback.

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

1. Merge reviewed units for the active milestone (L1/L2 now; historical S1/S2
   are complete) into `develop`, resolving against current develop
   as needed. Confirm all eight checks on each reviewed head and applicable
   post-merge CI. Record intentional docs-only push skips explicitly; a skipped
   run is not a green run. Harness/workflow changes still require post-merge CI.
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
8. Record the evidence below; only then mark the active milestone delivered and remove verified
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
