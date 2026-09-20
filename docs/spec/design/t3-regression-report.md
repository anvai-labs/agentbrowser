# T3 first slice: bound regression report

Status: first internal foundation delivered through PR #212. It is not a user-facing
runner or a claim that T3 is complete.

## Decision

Wrap one existing UI outcome in a request-relative TestCase report, reusing the CLI,
service, adapter, verifier, oracle, parsers and lifecycle. No new executable, network
or user-facing runner surface, store, package, dependency or CI job.

A case passes only with completed operator setup/cleanup, passing required UI outcomes
and matching observed versions. The report has no `ok`/`passed`; one bound contract
owns parsing and truth:

```ts
const contract = createTestCaseRunContract(descriptor, invocations);
const report = contract.parse(raw);
contract.isPassing(report);
```

Do not export an unbound truth helper.

## Minimal contract

Add strict plain-data schemas in `packages/protocol/src/test-run.ts`. Keep 1..16
assertions with at least one required; the reference case executes one.

```ts
interface TestCaseDescriptor {
  id: string;
  version: string;
  testedSeam: 'ui';
  environment: {
    productVersion: string;
    cliVersion: string;
    engine: { name: string; version: string };
    fixture: { id: string; version: string };
  };
  assertions: readonly { id: string; required: boolean }[];
}

interface AssertionInvocation {
  id: string;
  operationId: string;
  request: OutcomeRunRequest;
}

type SkipReasonCode = 'CAPABILITY_UNAVAILABLE' | 'PRECONDITION_UNAVAILABLE';

type AssertionResult =
  | { id: string; status: 'completed'; operationId: string; report: OutcomeRunReport }
  | { id: string; status: 'skipped'; reasonCode: SkipReasonCode };

interface TestCaseRunReport {
  case: { id: string; version: string };
  environment: TestCaseDescriptor['environment'];
  setup: 'completed' | 'failed' | 'unknown';
  assertions: readonly AssertionResult[];
  cleanup: 'complete' | 'failed' | 'unknown';
}

createTestCaseRunContract(
  descriptor: TestCaseDescriptor,
  invocations: readonly AssertionInvocation[]
): {
  parse(input: unknown): TestCaseRunReport;
  isPassing(input: unknown): boolean;
};
```

The factory snapshots inputs with the bounded JSON helper. Descriptor assertion IDs
are unique, at least one is required, and requiredness exists only there. Assertion
and operation IDs occupy separate namespaces.

Results have descriptor cardinality, order and IDs. Completed results and invocations
form an exact bijection: each completed result has one matching invocation/outer ID,
each invocation has one completed result, and skipped results have none. Nested reports
pass `createOutcomeRunReportParser(invocation.request)`, including `testedSeam: "ui"`.
Required skips never pass.

Skip codes use `^[A-Z][A-Z0-9_]{0,127}$` and the fixed allowlist above. The adapter maps
recognized pre-dispatch exceptions to those codes; unexpected exceptions fail report
creation. Raw errors/messages, accessors, unknown fields, exotic prototypes, cycles,
mutation and oversize values fail closed under existing value-free parser rules.

The parser pins reported projections, not remote execution or hidden request values.
The trusted adapter and ledger bind the request/outer ID; the oracle proves the effect.
Add no request hash, private projection or attestation.

Skip parsing pins only status and absent evidence. The operation ledger and oracle
separately prove no UI/application dispatch, claim, read or effect. CLI discovery,
health and HTTP preflight remain allowed.

## Lifecycle and authority

Existing `withManagedChild` owns the adapter; add no callback/registry. Register
resources immediately, use operator setup, delegate QA, invoke the CLI with only the
agent token, and settle resources in outer `finally`, preserving the first failure.

Report `cleanup: "complete"` means session operator cleanup completed before parsing.
The later outer finalizer closes every fixture listener and any session retained after
partial setup or cleanup failure. Its failure fails the harness even if the bound
report passes. Future JUnit/HTML consumes this bound verdict, never an unbound pass.

Assertion preparation receives one frozen narrow context:

```ts
interface AssertionContext {
  sessionId: string;
  pageId: string;
  targetRef: string;
  command: Readonly<CounterCommand>;
  businessCorrelationId: string;
}
```

It receives no operator client/key, child, environment, reader or oracle. Outer and
business operation IDs are distinct. The adapter owns the agent token and CLI spawn.

Build CLI environment from an allowlist (`PATH`, required temp/locale/cert variables)
plus the agent key. Exclude operator credentials, `AGENTBROWSER_API_KEYS`, proxies,
`NODE_OPTIONS`/`NODE_PATH` and other secrets. Test a sentinel through the spawn helper.

## Independent environment observation

Observe CLI `productVersion` locally through `describe`, CLI `cliVersion` through the
actual binary's `--version`, service `productVersion` through `/health`, engine
name/version through authenticated readiness/session state, and fixture ID/version
through the child ready message. Require describe, binary and service product versions
to agree, then compare every observation with descriptor pins; never copy pins into the
report. Keep commit/dirty state, platform and Node version in the package report.

## Failure-first tests

Protocol tests first fail for the missing factory, then prove:

1. exact setup, completed request-relative outcome, observed environment and cleanup
   pass for one required assertion;
2. all-optional descriptors are invalid; required skip, failing setup/cleanup, unknown
   verification and missing evidence do not pass; optional skip may pass;
3. altered identities, non-bijective/reordered mappings, arbitrary skip text, raw
   errors/messages, accessors, cycles, oversize values and mutation fail;
4. inputs are captured once and contracts with different reported identities do not
   accept each other's reports; and
5. evidence references survive cleanup failure without exposing request or exception
   values.

Extend the existing packaged acceptance in its current browser job:

- **fixed twice:** fresh sessions produce distinct scoped UI events with zero LLM/MCP;
- **broken UI:** ignored click yields unknown verification, no receipt and failure;
- **API shortcut:** an operator setup write creates matching visible state without a
  reserved UI receipt, so the assertion fails;
- **required skip:** CLI/HTTP preflight may run, while ledger and oracle prove zero
  UI/application dispatch, claim, read and effect;
- **partial setup:** fail after session creation and browser binding; independently
  prove the session, binding and fixture close in the outer finalizer; and
- **cleanup failure:** a passing assertion followed by injected cleanup rejection stays
  non-passing while the outer finalizer closes all resources.

The API shortcut replaces the hidden oracle mutation and uses an operator credential
and distinct ID. The agent token gets 403 from raw application execute/receipt routes.

This fixture's exclusive UI actor qualifies controlled G4 only. It does not establish
a production evidence source, production causality or G6 independence.

## Ownership and validation

Expected files are protocol `test-run.ts`, its test/export,
`scripts/cli-outcome-{child,acceptance}.mjs`, and `scripts/package-acceptance.mjs` with
its nearest test. They own the contract, shortcut/version observation, lifecycle,
packaged loading and environment allowlist respectively.

No API, SDK, CLI, OpenAPI, MCP, runtime profile, catalog or workflow change is
expected. Task metadata alone marks T3 active while this foundation is qualified.

Run focused protocol/package-helper tests and type checks, then the existing packaged
job once. Record two fixed runs, negative controls, one CLI call per executed assertion,
zero UI/application dispatch for skip, zero model calls, report sizes and observed
versions. Make no latency/memory claim without a baseline.

## Deferred

Navigation reset shipped in #214. Next: [offline CLI evaluation](t3-cli-evaluation.md).
Execution runners and durable history remain deferred.
