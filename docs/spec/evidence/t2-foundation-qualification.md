# T2 foundation qualification

Status: T2 complete on develop. PR #208 passed exact-head CI, merged, and passed
merge-commit CI. Main/release promotion is outside this completion slice.

## Scope of completion

T2 provides shared execution, verification and cleanup outcomes, scoped evidence
permission and bounded read-only verification through the existing executor and
admission lifecycle. The compiled CLI can drive this path without MCP. The controlled
G4 form fixture qualifies the shared foundation; it does not qualify production
application commits or G6. T3 starts with fixture-backed deterministic regression.
Production UI/API parity and evidence sources remain T4; durable recovery remains T5.

Two independent adversarial audits checked the declared T2 matrix against the tests
below. No additional executor, state machine, receipt store, package or dependency is
needed to close the foundation task. A production-source prerequisite in the earlier
vertical-slice record was broader than the T2 completion contract and is corrected by
this audit; unsupported evidence levels remain explicit.

## Acceptance mapping

| Required boundary | Existing falsifying coverage |
| --- | --- |
| Admission takeover, revocation and terminal authority checks | [Application evidence](../../../packages/control/src/application-evidence.test.ts), [actual outcome route](../../../packages/api/src/outcome.test.ts), [application provider](../../../packages/api/src/outcome-provider.test.ts). |
| Same operation ID with different input; no write replay | [Application authority](../../../packages/control/src/application-authority.test.ts), [application HTTP](../../../packages/api/src/application-http.test.ts), [installed CLI matrix](../../../scripts/cli-outcome-acceptance.mjs). |
| Pending calls retain admission until drain; late output is withheld | [Session authority](../../../packages/control/src/session-authority.test.ts), [actual outcome route](../../../packages/api/src/outcome.test.ts). |
| Changed document or application binding | [Target identity](../../../packages/engine-playwright/src/target-identity.test.ts), [application authority](../../../packages/control/src/application-authority.test.ts), installed wrong-resource case. |
| Truncated candidates, redaction collisions and cross-field resets | [Autofill](../../../packages/api/src/autofill.test.ts), [autofill service](../../../packages/api/src/autofill-service.test.ts), [private evidence boundary](../../../packages/api/src/evidence-boundaries.test.ts). |
| After-commit disconnect, uncertain suffix and no blind retry | [Real stdio continuity](../../../packages/api/src/coexistence-stdio-continuity.test.ts), [HTTP coexistence](../../../packages/api/src/coexistence-http.test.ts), autofill tests, installed lost-response case. |
| Evidence failure, read-only bounded polling and cleanup | [Outcome runner](../../../packages/control/src/outcome-runner.test.ts), application evidence and actual outcome route tests. |
| Browser acknowledgement differs from application commit | [Scoped UI fixture](../../../packages/testkit/src/versioned-app.test.ts), installed success/historical/ignored/failed-action/stale cases and independent oracle. |
| Actual delivered surfaces and compatibility | [Extracted package acceptance](../../../scripts/package-acceptance.mjs) covers CLI, existing stdio/MCP, real Chromium and packaged service; [CLI matrix](t2-cli-application-outcome.md) adds seven cases and seven reconciled replays. |

## Review findings closed at the foundation boundary

- **R02 execution:** one operation record and reconciliation path; uncertain writes stop
  the suffix. No evidence poll retries a write. CLI/MCP guidance preserves this rule.
- **R04 foundation:** canonical availability, execution, verification and cleanup axes
  are distinct. A click acknowledgement cannot satisfy the independent scoped fixture
  predicate. Market-facing TestCase/report delivery remains T3.
- **R12 ownership:** protocol validators and report parsers, the existing plan executor,
  `SessionAuthority`, `ApplicationAuthority`, trusted registries and HTTP classification
  remain the shared owners. CLI/MCP are projections; no duplicate retry/authority loop.

## Delivery and remaining limits

| Delivery field | Verified value |
| --- | --- |
| Repository / PR | [agentbrowser #208](https://github.com/anvai-labs/agentbrowser/pull/208) |
| Base | `03c2144ac6770cfe9e4f386818fbd839b17fa2bd` |
| Reviewed head | `dfcc9d5bb6d6db4dd5b1a5300f066bfceeb52047`; independent review clean |
| PR CI | [35431407886](https://github.com/anvai-labs/agentbrowser/actions/runs/35431407886), eight of eight jobs successful |
| Develop merge | `944229096647e5047620a4afafa537b3d78dced6` |
| Merge CI | [35433726360](https://github.com/anvai-labs/agentbrowser/actions/runs/35433726360), eight of eight jobs successful |
| Main / release | Not performed in this slice |

The first CI candidate exposed an empty-input pipe race, reproduced and fixed before
this reviewed head. A queued Docker gate completed after user-authorized runner
recovery; no rerun, skip, workflow change or gate bypass was used.

The T3 context test first failed while T2 was active, then passed when the manifest
recorded completed delivery. It also checks that selecting QA/T3 does not load T2
history, forms/security mode data, or more than the declared 64 KiB task bundle.

Unqualified production sources, G6, durable recovery, hard termination of arbitrary
engine calls, independent browser qualification and installed harness support retain
their own task gates. T2 completion is not completion of the multi-use-case roadmap.
