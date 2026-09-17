# T2 HTTP result-classification evidence

Status: active implementation evidence for the second T2 slice. The complete shared
result and verifier contract remains pending.

## Defect and owner

Controlled HTTP writes run through `SessionAuthority`, which records `completed`,
`failed` or `outcome_unknown` and refuses a same-ID replay. The HTTP composition layer
previously told that authority about thrown errors, HTTP status failures and one
autofill-specific in-band marker. Plan and batched action failures intentionally return
HTTP 200 with useful partial receipts, so `{ ok: false }` and `{ status: "failed" }`
were incorrectly recorded as `completed`.

The route owner now uses one private typed helper for the existing canonical execution
envelopes:

- `{ ok: boolean }` for plan and autofill;
- `{ status: "success" | "failed" }` for single and batched action.

The helper marks only a top-level in-band failure and passes the report unchanged to
Fastify. It does not inspect nested action evidence. `SessionAuthority` remains the
single lifecycle owner and combines that marker with its existing dispatch fact:

- failure before engine dispatch becomes `failed`;
- failure after a dispatch becomes `outcome_unknown`;
- success remains `completed`.

Response status, bodies, operation statuses, schemas and endpoint signatures are not
expanded. The only observable correction is that operation lookup no longer calls an
in-band failed execution completed. CLI, MCP, SDK and direct HTTP clients all inherit
the same service-side result. No dependency, retry path, durable record or state
machine was added.

## TDD and validation

The falsifying integration test first produced `completed` for all three cases: a
partially applied plan, a partially applied batched action and a plan refused before
its first engine action. The passing test now proves:

- plan and batch stop after one real engine dispatch, record `outcome_unknown`, and a
  same-ID replay performs no additional write;
- a first-step pre-dispatch refusal records `failed` and performs no engine write;
- successful plan and batch operations still record `completed`;
- existing partial-autofill reconciliation remains covered by the same suite.

Validation on 2026-09-16:

```sh
pnpm --filter @agentbrowser/api exec vitest run src/coexistence.test.ts
# 1 file; 14 tests passed

pnpm --filter @agentbrowser/api type-check
# passed

pnpm exec biome check packages/api/src/server.ts packages/api/src/coexistence.test.ts
# passed without diagnostics

pnpm --filter @agentbrowser/api test
# 44 files passed; 554 tests passed; 2 skipped
```

Independent design and adversarial implementation reviews found no blocker. They
confirmed the defect, narrow top-level typing, all three execution surfaces, the HTTP
composition seam, separate engine/operation test oracles, replay behavior and unchanged
wire contracts. The review rejected changing failed reports to non-200 errors, throwing
away partial receipts, adding a status, or moving API report knowledge into the control
owner. CLI-side classification cannot know whether engine dispatch occurred and would
duplicate the service contract already consumed by CLI, MCP and SDK.

## Remaining boundary

This classifier covers delivered browser execution envelopes only. It does not infer a
business commit from a UI command, make operation records durable, retain full result
payloads or register trusted application verifiers. Those remain separate T2/T4/T5
increments. Main promotion and release are outside this slice's develop delivery.
