# AgentBrowser 1.11.0 release checkpoint

Status: published and Homebrew-installed on 2026-09-24 (America/Chicago).
Authorized after PR #288; preparation chronology below precedes the delivery results.
Candidate base: develop `0b1f1da76ed67a8b90d8af7c1a3058b62fab49df`.
Previous release: 1.10.1, protected main `124afc35484225374bfb8739a07b87b2698d03f4`.

## Scope and compatibility

This is a minor release because it adds public extraction request/server budgets,
MCP page provisioning and captured session diagnostics across REST/SDK/CLI/MCP.
It also includes guarded browser/application/review HTTP publication and browser
allocation/close ownership fixes. The private operation journal contract does not
enable a durable store, restart recovery or automatic replay.

CLI/MCP remain Bun binaries; the service ships compiled JavaScript and production
dependencies, with Node 24 in Homebrew. MCP remains optional. The SDK session type
now matches HTTP: engine.capabilities was never returned on these session endpoints.
Remote CDP creates a new context and does not adopt an authenticated profile.
No raw paths, CDP URLs or credentials are projected as launch facts. Session reads
retain per-request authorization; MCP aggregation is not atomic guarded publication.

See the [changelog](../../../CHANGELOG.md#1110---2026-09-24) and
[research smoke evidence](consumer-research-smoke.md).

## Release review and acceptance

Pre-release review identified a stale hard-coded tool count and release uploads that
could overwrite assets pinned by Homebrew. Notes now refer to the complete catalog;
publication fails on duplicate names instead of replacing bytes. Same-tag publication
is not an idempotent overwrite mechanism. Do not force tags or rerun publication to
replace artifacts; a changed release needs a new version.

The existing extracted-package acceptance now qualifies diagnostics, page provisioning,
complete extraction beyond 4 KB and request/startup ceilings with matching compiled
clients. No new workflow job or dependency is added.

Before commit, the 1.11.0 headed research smoke passed for 13/52 MiB fixtures. The
Darwin ARM extracted service plus actual Bun CLI/MCP passed all eleven acceptance
groups on Node 24.21.0 with graceful cleanup. This pre-commit package explicitly has
`dirty: true` and `releaseEvidence: false`; CI and published clean artifacts must still
qualify. Version/artifact checks, release contracts and documentation/context checks
passed. Independent review approved the full develop delta without product-code
blockers; release-only review covered immutability and corrected current plan statuses.
At preparation, exact candidate review, normal hooks, PR/main checks, tag ancestry,
release jobs, published checksums/npm integrity and Homebrew acceptance were still
required. The delivery sections below record their subsequently verified outcomes.

## Preserved state and remaining plan

The user's dirty root documentation and live browser service are preserved. Acceptance
uses owned isolated services and sessions. Installing binaries does not hot-upgrade a
running service; restart only at an explicit session checkpoint.

R5 lease/close-cause projection follows this release using the existing coordinator and
event owners. T4/T6 production evidence, T5 durable recovery, T7 audit/security and T8
installed external-harness qualification remain open; no milestone percentage changes.

## Promotion identities

Independent review approved release preparation `fddcf83ad753e52b1721f3be54a6d896e35e4c45`
and tree `66126de8e360f955a4f27dbb47f53c0daa49f5f0`. Both merge trees match.
Normal commit/push hooks passed (4,050 tests, 24 existing skips); no force push or
administration bypass was used. Main retains eight strict required checks,
administrator enforcement and force-push/deletion blocks.

| Gate | Identity | Result |
|---|---|---|
| Preparation [PR 289](https://github.com/anvai-labs/agentbrowser/pull/289) | `fddcf83` | [8/8 checks](https://github.com/anvai-labs/agentbrowser/actions/runs/36076160879) |
| Develop merge | `fa8731b6564d4e454b0196af4d6304a9275c98f6` | [8/8 checks](https://github.com/anvai-labs/agentbrowser/actions/runs/36076693985) |
| Promotion [PR 290](https://github.com/anvai-labs/agentbrowser/pull/290) | `fa8731b` | [8/8 checks](https://github.com/anvai-labs/agentbrowser/actions/runs/36076739648) |
| Main/tag target | `e00539eca682b60e5761702d1851472bb6401b12` | [8/8 checks](https://github.com/anvai-labs/agentbrowser/actions/runs/36077282556) |

Annotated tag object `3075e2e6666684515ecdef4e327dd148316a24c0` peels to that
protected-main commit. Tag version validation passed without drift.

## Release timeout investigation

The first attempt of [release run 36078934970](https://github.com/anvai-labs/agentbrowser/actions/runs/36078934970)
passed nine prerequisite jobs but Darwin x64 package acceptance reached its internal
90-second managed-child deadline. npm and GitHub publication were skipped. Existing
logs do not identify the managed phase, so Rosetta timing is an inference rather than
a proven root cause. No behavioral assertion failure was reported.

The original CI x64 CLI/MCP downloads passed all eleven acceptance groups locally
against the same clean tagged Darwin ARM JavaScript server package: 95,293 ms total,
60,929 ms outcome coordinator, `releaseEvidence: true`, graceful cleanup. This is
Rosetta client qualification, not native Intel service-runtime proof. That evidence
justified one failed-jobs-only retry without changing the tag, code or acceptance
thresholds. No published assets were replaced.

Follow-up: label managed acceptance phases and record bounded phase timings before
changing timeout budgets. Reuse the existing process owner and acceptance harness;
do not add a parallel runner or weaken behavioral assertions.

Darwin x64 passed on the second attempt with unchanged code and thresholds; all ten
prerequisite jobs then passed. This supports runner timing variance but does not
remove the diagnostic gap in phase-labelled acceptance timing.

## Published and installed qualification

The [release](https://github.com/anvai-labs/agentbrowser/releases/tag/v1.11.0)
published at 2026-09-25T01:13:23Z (2026-09-24 America/Chicago). Release run
36078934970 completed all twelve jobs successfully on attempt two. All fourteen
artifact downloads match `sha256sums.txt`, the fifteenth asset. All four server
archives identify 1.11.0, exact main `e00539e`, and `dirty: false`. Downloaded Darwin
ARM service/clients passed all eleven acceptance groups with `releaseEvidence: true`.

The exact npm `@anvailabs/agentbrowser-mcp@1.11.0` package identifies the same gitHead;
its 157,310-byte tarball matches registry SHA-1 and SHA-512 integrity:

```text
sha512-WZtX9ArhwG+VDYP4GUJMIf4i1EUQ3CDIKP7zyHD8cMz4PMqqMUoIv2o0I06G30I6P2zbPLAmQ5VgDP2MAxNATA==
```

The bundled executable passed initialization, the complete sixteen-tool catalog,
and both supported MCP protocols in unbound/delegated modes. Registry signatures
and SLSA provenance metadata are present; this qualification verifies integrity and
behavior, not the cryptographic attestation trust chain independently.

[Homebrew PR 73](https://github.com/anvai-labs/homebrew-tap/pull/73) merged as
`70a617b499101fadf58fbe2c7b97866539d9a84b` after independent exact-head review of
`92702f9f9ef5414ae21912c6570d6331ed1c6546` and all four
[PR checks](https://github.com/anvai-labs/homebrew-tap/actions/runs/36082478844).
All twelve formula URL/hash mappings were checked against downloaded bytes.
Node 24, wrappers and loopback defaults are unchanged. Strict audit, the actual
1.10.1-to-1.11.0 upgrade and formula tests passed before merge. The installed Cellar
service and Bun clients passed all eleven acceptance groups with
`releaseEvidence: true`; the Homebrew wrapper separately passed isolated readiness,
authentication refusal, authenticated real-browser page creation and graceful cleanup.
The installed tap was returned to merged main. Prior Cellar versions were retained;
no live service restart occurred. The existing service stayed healthy on 1.10.0.

Darwin x64 CI uses ARM Node with Rosetta clients and is not native Intel service
proof. Windows qualifies CLI/MCP binaries only, with no Windows service package.
Browser/package acceptance is not hostile-browser containment or live-job-application
completion. Finite foundation milestones remain 3 of 9 complete (33%); T9 is recurring.

The delivery-docs branch starts at protected main `e00539e` so its PR to develop
also preserves main ancestry. The user's dirty root documentation and tap `config/`
remain untouched. R5 lease/close-cause projection is the next consumer slice.
