# T2 plan verification-evidence

Status: active implementation evidence for the fifth T2 slice. Independent
application outcome verification and trusted verifier registration remain pending.

## Defect and ownership

A plan step can request native fill readback with `expectValue`. Ordinary successful
execution retained the service's sanitized `{ verified: true }` result, but the
stale-target remap success path dropped it. Client parsers also checked plan execution
cardinality without binding a successful response to verification requested by the
original plan. A schema-valid report could consequently claim success for a verified
fill while omitting its readback evidence.

The protocol remains the semantic owner. `createPlanReportParser` snapshots the action
count and one boolean per step before dispatch. It retains neither `value` nor
`expectValue`. A successful fill that requested verification must carry the exact
plain value-free result `{ verified: true }`; missing, false, inherited, non-plain or
value-bearing evidence is rejected with generic uncertain-write guidance. Failed plan
reports remain compatible, and steps that did not request fill verification gain no
new requirement.

The SDK creates this parser inside its existing HTTP mutation boundary, retaining the
exact operation ID on `INVALID_RESPONSE`. CLI and MCP create the same parser before
calling injected clients. The service's remap branch now copies the already sanitized
`ServiceActResult.result`, matching the ordinary branch without adding a retry or a
second verifier.

There is no schema, schema ID, OpenAPI, MCP catalog or wire-format change and no new
dependency. This qualifies G5 native property readback only. A remote producer can
still lie about `{ verified: true }`; G6 requires a separately authorized independent
application oracle.

## TDD and validation

Red tests first reproduced all affected boundaries: protocol accepted missing evidence,
the remap producer dropped valid evidence, and SDK, CLI and MCP accepted a success with
no requested readback result. An adversarial review then demonstrated that a loose
`verified: true` check would pass private sibling fields through client output. The
canonical exact projection and polluted-response regressions close that privacy gap.
Accessor-backed evidence is rejected without invoking the getter, and accepted evidence
is copied into a fresh `{ verified: true }` object so later producer mutation cannot
change or disclose client output. The shared execution-report boundary snapshots plain
data descriptors before validation, so stateful accessors on the report envelope or a
result row cannot change the meaning between validation and projection.

Validation on 2026-09-16:

```sh
pnpm --filter @agentbrowser/protocol test
# 6 files; 162 tests passed

pnpm --filter @agentbrowser/sdk-typescript test
# 4 files; 53 tests passed

pnpm --filter @agentbrowser/cli test
# 3 files; 102 tests passed

pnpm --filter @anvailabs/agentbrowser-mcp test
# 3 files; 78 tests passed

pnpm --filter @agentbrowser/api exec vitest run src/service.test.ts \
  src/plan-real-chromium.test.ts
# service producer and real Chromium plan verification passed

pnpm --filter @agentbrowser/protocol type-check
pnpm --filter @agentbrowser/sdk-typescript type-check
pnpm --filter @agentbrowser/cli type-check
pnpm --filter @anvailabs/agentbrowser-mcp type-check
pnpm --filter @agentbrowser/api type-check
# passed
```

The real Chromium fixture fills a native password input with `expectValue`, returns only
`{ verified: true }`, and independently observes the resulting native value. The remap
fixture proves one successful fill dispatch after the pre-dispatch stale refusal and
no private value in the plan report. Main promotion and release are outside this
develop delivery.
