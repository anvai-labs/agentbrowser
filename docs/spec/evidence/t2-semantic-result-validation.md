# T2 semantic result-validation evidence

Status: active implementation evidence for the fourth T2 slice. The complete shared
verifier/result contract remains pending.

## Defect and owner

The versioned plan and autofill TypeBox schemas validate shapes, while their top-level
`ok` fields summarize nested execution outcomes. The shared `parseExecutionReport`
helper previously checked shape only. It therefore accepted schema-valid contradictions
such as a successful plan containing a failed step or successful autofill containing a
failed, uncertain, skipped or unattempted receipt.

CLI exits and MCP tool-error projection trust the parsed top-level `ok`. A mismatched,
version-skewed or hostile remote service could consequently turn a nested failure into
shell exit 0 or an MCP success result. The bundled first-party service is internally
consistent, but client-side parsing is a trust boundary and cannot assume that producer.

The shared parser now accepts a typed semantic predicate and uses the same generic,
value-free uncertainty error for structural and semantic invalidity. Plan and autofill
own only their canonical predicates:

- plan `ok: true` requires `completed` to equal result count, contiguous step indices,
  the original request count, successful steps and no step/top-level error;
- autofill `ok: true` requires exactly one contiguous receipt per requested field and
  permits only error-free `verified/true` or `unverified/false` evidence.

These are deliberately one-way invariants. A pessimistic `ok: false` envelope remains
valid even if its retained prefix looks successful. An empty plan remains valid; an
autofill success cannot be empty because its canonical request requires 1–50 fields.
An `unverified` receipt with `verified: false` remains a valid success for
`verify: none`; no verification evidence is invented.

There is no schema, schema ID, OpenAPI, MCP catalog or HTTP wire change. The SDK captures
the original request count before dispatch and validates the HTTP response inside its
existing mutation error boundary. An invalid response becomes a private-safe
`INVALID_RESPONSE` carrying the exact dispatched operation ID for reconciliation. CLI
and MCP also capture request cardinality before calling injected or custom clients and
retain the same shared parser calls, so no adapter gains its own result state machine or
retry rule.

## TDD and validation

Five schema-valid contradictions first passed unexpectedly: one failed plan step and
four non-success autofill receipt statuses under aggregate `ok: true`. Adversarial
review then found eight more: plan count, index and error contradictions plus autofill
status/evidence mismatches and a positive receipt carrying an error. After the shared
predicate was completed, empty or non-contiguous autofill successes were also rejected.
The final adversarial case used internally consistent one-item successes for two-item
requests; request-relative cardinality now rejects those truncated tails. All fail
closed with uncertain-write guidance. SDK, CLI and MCP tests prove one upstream call,
failure, no retry and no private nested result echo through adapter output.

A second adversarial pass mutated caller-owned arrays while each request was in flight.
Cardinality is now snapshotted before every dispatch, so post-dispatch mutation cannot
weaken validation. Deferred SDK response tests cover both bulk paths and also prove that
generated and caller-supplied operation IDs survive semantic rejection. Injected CLI
and MCP clients mutate their arguments in equivalent regression tests.

Validation on 2026-09-16:

```sh
pnpm --filter @agentbrowser/protocol exec vitest run src/plan.test.ts src/autofill.test.ts
# 2 files; 44 tests passed

pnpm --filter @agentbrowser/protocol build
pnpm --filter @agentbrowser/cli exec vitest run src/cli.test.ts
# 1 file; 91 tests passed

pnpm --filter @anvailabs/agentbrowser-mcp exec vitest run src/mcp-server.test.ts
# 1 file; 71 tests passed

pnpm --filter @agentbrowser/sdk-typescript exec vitest run src/client.test.ts
# 1 file; 37 tests passed

pnpm --filter @agentbrowser/protocol type-check
pnpm --filter @agentbrowser/cli type-check
pnpm --filter @anvailabs/agentbrowser-mcp type-check
pnpm --filter @agentbrowser/sdk-typescript type-check
# passed

pnpm exec biome check packages/protocol/src/validators.ts \
  packages/protocol/src/plan.ts packages/protocol/src/autofill.ts \
  packages/protocol/src/plan.test.ts packages/protocol/src/autofill.test.ts \
  packages/sdk-typescript/src/client.ts packages/sdk-typescript/src/client.test.ts \
  packages/cli/src/cli.ts packages/cli/src/cli.test.ts \
  packages/mcp-server/src/mcp-server.ts packages/mcp-server/src/mcp-server.test.ts
# passed
```

## Remaining boundary

JSON-Schema-only consumers retain structural validation unless they call the exported
canonical parsers with the original request count. Typed independent application
verification, durable outcomes and restart recovery remain T4/T5 work. Main promotion
and release are outside this slice's develop delivery.
