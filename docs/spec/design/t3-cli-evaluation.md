# T3 next slice: offline CLI evaluation and conventional test integration

Status: implemented in the develop candidate; not published in 1.9.0. Design baseline:
`4601e77`, with the 13-case foundation delivered by #212/#214.
Load this file only for this T3 slice. T3 remains active; its completion gates do not change.

## Problem and decision

A shell-based test can already execute `agentbrowser outcome`, but the bound TestCase
contract is accessible only through private workspace packages. External test code
cannot assume protocol/testkit/SDK are public npm dependencies. Copying their verdict
logic into examples would recreate the drift these foundations remove.

Add an **offline** `agentbrowser test evaluate <evaluationJson>` projection of the existing
bound contract. Conventional test tools keep execution and lifecycle ownership; the
installed CLI provides canonical validation and deterministic exit status. This is
an evaluation of caller-observed data, not browser execution or an evidence fetch.

| Alternative | Decision |
| --- | --- |
| Conventional runner + installed CLI evaluator | Selected: reuses existing execution and case truth without a new service. |
| Public `test run` now | Defer: fixture identity, operator/delegated credentials and lifecycle ownership are not yet a portable product contract. |
| Server runner / fixture registry / scheduling | Defer: introduces new authority and state ownership without a demonstrated need. |
| Publish protocol/testkit/SDK merely to enable an example | Defer: separate compatibility/distribution commitment; existing binary can expose the needed operation. |
| Copy the pass predicate into a Bash/Node example | Reject: creates a second truth owner and diverges on skips, versions and cleanup. |

The stock server does not automatically register application adapters, verifiers or
receipt sources. `applicationReceiptOutcomeOptions` is trusted deployment composition,
not a stock-binary plugin loader. This slice does not change that deployment boundary.

## Input, output and limits

Compose strict protocol schemas from existing TestCase/AssertionInvocation/report
schemas. No new action vocabulary, verifier DSL, schema registry or request hashing.

```ts
interface TestCaseEvaluationInput {
  schemaVersion: 1;
  descriptor: TestCaseDescriptor;
  invocations: readonly AssertionInvocation[];
  report: TestCaseRunReport;
}
interface TestCaseEvaluationReport {
  schemaVersion: 1;
  provenance: 'caller_observed';
  verdict: 'passed' | 'failed';
  descriptor: TestCaseDescriptor;
  report: TestCaseRunReport;
}
```

Use IDs `urn:agentbrowser:test-case-evaluation-input:v1` and
`urn:agentbrowser:test-case-evaluation-report:v1`. Input/output are strict bounded plain
JSON using the existing verification snapshot limits (64 KiB, existing depth/node
limits); descriptors retain 1–16 assertions with at least one required. The CLI reader retains its 1 MiB transport cap and stdin deadline. Measure all 13
bundle sizes before enforcing the smaller aggregate protocol budget.

One protocol entry, `evaluateTestCaseRun(input: unknown)`, parses the bounded envelope
before property access. Use only that snapshot to create `createTestCaseRunContract`,
parse the report, derive verdict via the captured contract's `isPassing`, and construct
output from parsed descriptor/report. Validate complete output before emitting it.
No second pass formula or unbound truth predicate. Retain bounded revalidation until
profiled. Re-export schemas/types/helper through the SDK barrel for CLI consumption;
add no SDK HTTP method or dependency.

Output deliberately omits invocation requests and private expected values. It preserves
the canonical report and opaque evidence refs, including on cleanup failure. Existing
report diagnostics can be sensitive. `--json` explicitly opts into full-report stdout,
which CI may log; it is not sanitized or private. Harnesses capture it in memory without
logging. Recipes must explain private-file handling. Human output is only case ID/verdict;
parser errors never echo input excerpts or filesystem details.

## CLI contract

```sh
agentbrowser describe test evaluate --schema
agentbrowser --json test evaluate - <evaluation.json
# @evaluation.json and existing inline JSON remain supported; prefer stdin for private input.
```

- Valid passing input: exit 0, one evaluation report with `--json`.
- Valid non-passing input: exit 1, one report retaining failure evidence with `--json`.
- Invalid input: exit 1, no stdout, bounded value-free stderr.
- No service client construction, API key lookup, browser, MCP or network call.
- Definition-local schemas use `advertiseWireSchema` and input uses `readCommandJson`;
  the existing JSON-contract audit must see this argument. No discovery path switch.
- Reuse existing error/output primitives. Extract offline plumbing only if `describe`
  and evaluation both use it; do not copy the online action wrapper or rewrite the CLI.

`--operation-id` is not a service operation for this offline command. Evaluation never
mints/reconciles IDs, retries a write, creates fixtures or upgrades the installed CLI.
The new command is absent from published 1.9.0; discovery must identify its availability.

## Trust and lifecycle

The trusted conventional test coordinator captures expected requests before dispatch,
then gathers service responses and independently observed environment metadata. Pins
belong to `descriptor`; observed CLI version, service health version, session engine,
and fixture-owned ready identity belong to `report.environment`. Never copy expected
fixture/version values into the observed report. If observation fails, fail setup in
the framework; do not invent metadata to obtain a well-formed evaluation artifact.

Operator code owns application binding/reservation, grants and cleanup. Agent CLI
processes receive only the delegated QA token through the existing environment
allowlist. A test definition cannot execute operator shell hooks or gain application
execute/receipt capabilities. Reuse #219's composition helper and explicit policy;
do not change absent-authorization semantics or the stock server configuration.

The evaluator checks internal consistency against supplied expectations. It does not
prove that the caller actually executed the request, that a receipt exists remotely,
or that the fixture supplied its claimed version. In particular, changing private
request input that has no report projection is not necessarily detectable. No claim of
cryptographic binding, tamper-proof artifacts, production causality or G6 follows.
The service, operation ledger, trusted coordinator and independent oracle remain those
execution/evidence boundaries. A model-authored passing JSON object is not test evidence.

Case `cleanup` retains its existing meaning: the resources owned by that case were
settled by trusted orchestration. Shared fixture/process finalization remains an outer
obligation. The packaged integration must buffer case bundles and invoke the evaluator
only **after** `withManagedChild` returns successfully and all outer finalizers pass.
Stage all 13 evaluations locally; publish none until all finish and enclosing package
finalizers succeed. An outer-finalizer failure rejects the run before publication. The existing cleanup-failure control still produces a failed case after its
outer fallback succeeds. Do not rewrite a failed case as passed because cleanup retried.

A saved evaluation report's `verdict` is a display projection, not a new authority.
Future exporters run in the same trusted evaluation flow or re-evaluate the original
bundle. Do not add a function that accepts an arbitrary serialized verdict and certifies
it as a fresh successful test. Conventional runner failures still override any case
artifact; artifact presence alone never determines CI success.

## Integration and reuse map

| Existing owner | Minimal change |
| --- | --- |
| `packages/protocol/src/test-run.ts` and test | Composed envelope/output schemas and one evaluation entry reusing the existing bound contract and parser. |
| `packages/sdk-typescript/src/index.ts` | Re-export the canonical evaluation API for existing CLI dependency wiring; no HTTP surface. |
| `packages/cli/src/cli.ts` and tests | One offline subcommand with existing bounded input, metadata and output mechanics. |
| `scripts/cli-outcome-acceptance.mjs` | Feed buffered 13-case bundles to the compiled CLI evaluator after outer finalization; remove the private protocol import used to produce verdicts. Reuse `runAgentCli` without an agent token for evaluation. |
| Existing package acceptance/release smoke owners | Require the actual evaluator/schema in the candidate binary and assert 13 evaluations ran; do not add a CI job. |
| Existing testkit/application fixture/composition | Reuse unchanged execution and independent oracle. No generic callbacks or alternate browser driver. |

Retain audited protocol dependency-closure checks even if the harness no longer imports
it directly. The product still depends on it. Keep 11 outcome calls and 11 exact-ID
replays, two discovery calls plus the navigation/snapshot/stale-ref probe; count new
evaluation/discovery invocations separately. This offline integration adds subprocess
cost, not agent/model turns: measure it against the current 13-case baseline before
claiming footprint or latency improvements. No repeated full matrix in an extra job.

A conventional-runner recipe may use installed CLI execution/evaluation against a
caller-supplied, preconfigured deployment, without private package imports. The existing
fixture child still imports private modules: its end-to-end qualification remains
repository-internal, not portable deployment setup. Evaluate the runner's existing
JUnit/reporting facilities first; add an adapter only for a demonstrated gap. HTML must
escape content and never inline active page HTML or private requests.

## Implementation tasks and failure-first acceptance

1. **Protocol boundary:** add schemas/helper in the existing owner. RED for missing
   helper; then prove required skip, verification unknown/failure, incomplete setup and
   cleanup cannot pass. Preserve optional-skip semantics and cleanup-failure evidence.
2. **Binding and limits:** reject altered reported case/version, environment, assertion
   order/cardinality, outer operation ID, verifier ID/version and UI seam. Reject unknown
   fields, malformed/oversized/cyclic/accessor input without reading getters or echoing
   sentinel secrets. Preserve the explicit limitation on unreported private input.
3. **Offline CLI:** missing command/schema is RED; then qualify stdin/@file/inline,
   nonzero-with-report versus invalid-without-report, no client/network/credential access,
   and canonical output schema. Test-only clients may throw on construction to prove it.
4. **Actual binary integration:** all 13 current cases retain their expected verdicts
   through the compiled evaluator. Pin missing-evaluator and version-drift refusal.
   Outer-finalizer failure must yield zero evaluator calls; evaluator N failure must
   yield no partial export. Retain first-failure and resource-closure evidence. Do not equate expected-negative fixture
   controls with customer tests that passed.
5. **Conventional runner/report qualification:** positive and broken flows use the CLI,
   independent oracle and framework cleanup against a preconfigured deployment. Qualify
   exit/failure behavior, including cleanup failure. Evaluator portability does not prove
   portable end-to-end setup. JUnit/HTML and impact selection retain separate gates.
6. **Delivery:** focused local gates, exact-head adversarial review, one ready PR through
   existing required checks, normal merge verification, accurate develop/release status.

Steps 1–4 are implemented; see [qualification](../evidence/t3-cli-evaluation.md).
Step 5 is the next integration/report slice. A public execution
runner, fixture/plugin configuration, scheduling, parallelism, durable history and public
npm publication remain deferred until evidence justifies their added ownership.
