# T3 offline CLI evaluation: qualification record

Scope: develop candidate after `5e7eae5`; not included in published 1.9.0.
T3 remains active. This implements steps 1–4 of the
[offline evaluation design](../design/t3-cli-evaluation.md), not a public execution
runner or conventional-runner/report qualification.

## Delivered seam and reuse

`agentbrowser test evaluate` consumes a bounded descriptor/invocations/report bundle
without a service client, credentials, browser or MCP connection. Protocol schemas and
`evaluateTestCaseRun` compose the existing captured TestCase contract; its `isPassing`
remains the only aggregate truth owner. The SDK barrel exposes the same helper to the
CLI. Existing `advertiseWireSchema`, `readCommandJson` and output/error primitives own
discovery, bounded stdin/@file/inline input and diagnostics.

A valid failing case returns its complete report with exit 1; invalid input returns
no stdout and a value-free error. Output omits invocation requests but can still contain
sensitive report diagnostics. `caller_observed` means consistency against supplied
expectations, not authenticated remote evidence or proof of execution. See the
[CLI guide](../../cli-agent-usage.md#evaluate-a-completed-case-offline-develop-candidate).

## Failing-first and adversarial controls

- Protocol: five new failures for missing schemas/helper before implementation;
  17 focused tests pass afterward. A ~34 KiB invocation and ~34 KiB report each pass
  their existing owners, but fail when combined beyond the aggregate budget. Case,
  environment, operation, verifier ID/version and action-count drift remain rejected.
- CLI: six new tests fail before the command exists; all 126 CLI tests pass afterward.
  Probes cover discovery/audit, no credential/client/network access, private input
  omission, stdin/@file/inline, failure-with-report and invalid-without-report.
- Package/release helpers: 41 tests pass. The evaluator waits on the actual managed
  child settlement promise before discovery. A workflow-complete/finalizer-failed
  promise yields zero calls; an Nth evaluator failure yields no partial returned batch.
  Sentinel tests reject private contents in error stacks, including runner failures.
- Adversarial review corrected assertion-error leakage and a vacuous finalizer test.
  Re-review is clean. No second runner, verdict algorithm, dependency or CI job was added.

## Native package measurements

The first full local measurement used Node v22.23.2, freshly compiled darwin-arm64
CLI/MCP binaries and an extracted package stamped `5e7eae5`, `dirty:true`. It passed
**8/8 groups**; its report correctly has `releaseEvidence:false`. This local run is
measurement evidence, not the later clean committed candidate or a publication.
Local artifact: `/private/tmp/t3-eval-local-acceptance.json`.

| Measurement | Result |
| --- | --- |
| Cases / expected verdicts | 13; four positive cases pass, nine negative controls fail |
| Compiled evaluator calls / evaluator discovery | 13 / 1 |
| Existing outcome calls / exact-ID replays | 11 / 11, unchanged |
| Existing command discovery calls | 2, unchanged |
| Navigation probes | navigate, snapshot and stale-ref refusal retained |
| Serialized evaluation bundles | 669–1,607 bytes |
| Original case reports | 340–923 bytes |
| Largest bundle overhead over its case report | 684 bytes |
| Model / MCP calls | 0 / 0 |

The harness retains audited package closure but no longer imports the private protocol
package for verdict computation. It holds one report per case plus small provenance
metadata, omitting invocation payloads. Publication waits for all evaluations and the
enclosing package finalizers. Additional CLI subprocesses have a cost; no latency
improvement is claimed.

## Delivery and remaining gates

The existing built-artifact gate and candidate package acceptance require the new
command/schema. Historical baseline smoke remains usable; its unsupported checks keep
`releaseEvidence:false`. A clean exact-commit package run, exact-head review and the
existing eight PR/integration checks remain merge gates; their final identities belong
in the implementation PR's delivery record to avoid a documentation-only CI cycle.

Next: conventional-runner qualification against a preconfigured deployment, then report
formats and impact selection under T3's existing gates. Portable fixture deployment,
public `test run`, scheduling, T5 durable recovery and T8 installed harnesses remain
separate work. Reassess a release at the completed offline-CLI checkpoint; no version
bump, main promotion, tag, tap change or release is part of this slice.
