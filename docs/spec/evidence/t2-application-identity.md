# T2 application operation identity evidence

Status: active implementation evidence for the third T2 slice. Persisted service
incarnations and the complete shared verifier/result contract remain pending.

## Defect and owner

`SessionAuthority` owns one operation ledger per registration, so a caller's operation
ID is scoped to that registered session owner. `ApplicationAuthority` previously
discarded this identity when it built `ApplicationScope`. A trusted adapter received
tenant, resource and the raw operation ID only. Two admitted sessions bound to the same
application resource could therefore send the same raw ID and collide in an
application ledger. The same defect recurred if a textual session ID was removed and
registered again with a fresh control ledger.

`SessionAuthority` now creates a random `sessionIncarnation` for each registration.
It remains stable across bind/unbind and changes if the textual ID is reused.
`ApplicationScope` carries both that incarnation and its `sessionId`. A trusted
application can key idempotency and receipts by
`(tenant, resource, sessionIncarnation, operationId)` or an opaque application-owned
equivalent. The caller cannot supply or override either session field. There is no
HTTP, SDK, CLI, MCP or browser wire change and no new dependency, retry path, state
machine or application-side storage in the control package.

Binding generation stays in the control-plane write fingerprint, where it invalidates
old admission and review after rebinding. It is deliberately absent from the adapter's
receipt identity: after fresh authorization, the same registration rebound to the
same resource must still reconcile its prior application receipt. The incarnation is
not persisted, so this increment prevents false aliasing but does not restore old
receipts after restart; persisted service/session fencing remains T5 work.

## TDD and validation

The first falsifying test registered two independent sessions against one versioned
application resource. Both used raw operation ID `write-1` for sequential writes and
failed because the adapter scope contained no session identity. Adversarial review then
found that a textual ID can be removed and registered again; a second red run failed
with `MISSING_INCARNATION`. The passing tests prove both concurrent registrations
commit once, each resolves its own receipt, unbind/rebind preserves an old receipt, and
remove/register of the same textual ID creates a separate effect and receipt.

Validation on 2026-09-16:

```sh
pnpm --filter @agentbrowser/control exec vitest run src/application-authority.test.ts
# 1 file; 19 tests passed

pnpm --filter @agentbrowser/control type-check
# passed

pnpm --filter @agentbrowser/control test
# 3 files; 45 tests passed

pnpm --filter @agentbrowser/control build && pnpm test:application-independence
# production dependency deployment and external authority exercise passed

pnpm exec biome check packages/control/src/application-authority.ts \
  packages/control/src/application-authority.test.ts \
  packages/control/src/session-authority.ts packages/control/src/session-authority.test.ts
# passed; existing test warnings only

actionlint .github/workflows/release.yml
# passed
```

The application state and application-owned receipts are the test oracle. Adapter
response status alone is not treated as commit proof. Existing takeover, lost-response,
duplicate-suppression, rebinding and no-replay tests remain in the focused suite.

## Remaining boundary

This identity prevents aliasing inside the current in-process, ephemeral authority. A
future durable outcome reference must persist its host/service fence and return a
typed, independently verifiable result. Generic verifier registration remains deferred
until T4 has a public typed output/rejection/receipt consumer. Main promotion and
release are outside this slice's develop delivery.
