# T3 standalone recipe and completion checkpoint

Status: T3 complete on develop; exact candidate and post-merge CI passed. This record
does not change the published 1.9.0 release. See the [T3 packet](../tasks/t3-qa-regressions.md)
for scope and the [example](../../../examples/node-test/README.md) for usage.

## Qualified boundary

The existing application-owned Node recipe is copied as exactly two files into private
temporary staging and invoked from an unrelated working directory. The same three
live controls preserve exits 0/1/1, independent application outcomes, canonical offline
evaluation, private digest-linked evidence, native JUnit output and verified cleanup.
This qualifies the documented distribution seam against a preconfigured application.
It does not provision arbitrary applications or add a public runner.

Actual package execution found a macOS `/var` versus `/private/var` path-alias defect:
the copied entry could exit successfully without executing. Canonicalizing the staging
root fixes the entry guard, and the direct-entry negative test requires a failing exit
when required configuration is absent. Manifest byte measurements reuse the same
bounded no-follow buffer that validates the manifest; no second path lookup is needed.

The current matrix retains 13 deterministic cases, including broken UI, API shortcut,
required skip, lost response, stale identity, navigation reset and cleanup failures.
No new browser case, host, dependency, CI job, executor or verdict owner was introduced.

## Validation and measured scope

Reviewed head: `ff77b1781e6cac3ef6c0e23606213820bd2e62a1`.
Tree: `6f726765b4e4db5201cb5890d80c1b7e20062ad3`.
Base: `9b80675f23bcba4a8680c4938f05779938a67037`.
Independent exact-head adversarial review is clean. Normal commit/push hooks passed.
The final focused selection passes 62 tests on Node 24.21.0; the compatibility
selection passes 43 tests on Node 22.23.2.

The clean exact-head extracted package passes all eight acceptance groups with
`releaseEvidence: true` on Node 24.21.0, darwin-arm64. Package SHA-256:
`7d272e643c4e4ebb88f2aede372a27af6b9fa8161a000f9fb415079edc6f7b9a`.
Playwright is 1.62.1; the actual Chromium build was not recorded. The engine adapter
version and browser-cache directory are not substitutes for that observation.

| One local sample | Observed value / scope |
| --- | --- |
| Focused helper selection | 1,373 ms; 62 tests, no live package exercise |
| Extracted-package acceptance | 14,025 ms through cleanup; excludes build, packaging and report serialization |
| Outcome coordinator | 10,320 ms; includes its nested matrix, evaluator and recipe phases |
| Existing matrix / offline evaluation / copied recipe | 6,363 / 651 / 2,709 ms |
| Matrix CLI launches | 27 observed spawn callbacks; excludes executable internals |
| Largest discovery / evaluation bundle / case report | 73,925 / 1,607 / 923 bytes |
| Largest recipe config / evaluation / manifest / JUnit | 519 / 1,188 / 267 / 1,271 bytes |

Recipe invocation counts describe fixed qualified call paths, not all OS processes or
browser descendants. Zero model/MCP calls and zero model context bytes apply to the
T3 matrix; the full package gate separately exercises MCP. Timings overlap by scope
and must not be added as independent totals. One sample supports neither percentiles
nor a speedup claim. Focused selection is an explicit local aid; unknown impact falls
back to the full gate. Automatic CI selection remains T9 work.

## Delivery

PR: [#231](https://github.com/anvai-labs/agentbrowser/pull/231).
PR CI: [35537511614](https://github.com/anvai-labs/agentbrowser/actions/runs/35537511614),
all eight required checks successful without reruns or gate changes.
Develop merge: `cc4d72e0deecde9896896f1f20ebcbca5f3f80ad`; ancestry and tree equality
with the reviewed candidate independently verified. Post-merge CI:
[35537742978](https://github.com/anvai-labs/agentbrowser/actions/runs/35537742978),
all eight checks successful without reruns or gate changes.
Main promotion, tag, release, tap update and installed-harness qualification: not
performed in this checkpoint. Package qualification is not a release publication.

## Completion scope and remaining gates

The first application-owned regression seam now has a reusable definition, installed
CLI execution/evaluation, a qualified conventional report and failure-linked private
evidence. JUnit satisfies the initial report gate; HTML requires a concrete consumer.
The R04 QA outcome boundary and R15 focused/full measurement boundary are covered.
Production/G6 evidence and binding UX remain T4, durability remains T5, broader widgets
and mappings remain T6, and installed harnesses remain T8. Product-market validation
is separate from technical qualification.

Verified delivery and marking T3 complete permit T7 audit task context; T4 still
blocks appsec/bounty task context. T8 profile/full-run work also requires T1. The context
regression first failed while T3 was active and checks the manifest update,
without loading QA history, applicant data or unrelated mode modules into audit context.
