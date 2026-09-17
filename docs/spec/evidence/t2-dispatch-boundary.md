# T2 dispatch-boundary evidence

Status: active implementation evidence for the first T2 slice. This record does not
claim that the complete shared-result or verifier contract is delivered.

## Defect and boundary

Bulk autofill previously marked a field as dispatched before calling its service action
port. The service can still refuse an action during target validation, approval or
policy admission, so such a refusal was incorrectly reported as `uncertain`, as though
the browser might have received the write.

The action port now receives a no-throw dispatch observer. The service invokes it from
the existing `ActionExecutor.beforeAction` seam after decoding, target resolution,
staleness and fingerprint validation, and approval checks. The executor immediately
calls the engine adapter after that seam without another asynchronous boundary.
Autofill keeps one monotonic local lifecycle per field:
`not_started -> dispatched -> completed`.

- An exception before the observer is `failed`; no browser write was dispatched.
- An exception after the observer is `uncertain`; the caller must reconcile before
  another write.
- A completed write with conclusive value mismatch remains `failed` with independent
  verification evidence.
- Verification retries only reobserve and never cross the dispatch boundary again.

`AgentBrowserService.act()` retains its public signature. The observer method is
private, and protocol, OpenAPI, SDK, CLI and MCP schemas are unchanged. This slice
reuses the action executor, approval gate, autofill orchestrator and snapshot artifact
owner. It adds no package, runtime dependency, durable state or retry loop.

## TDD and validation

The initial falsifying tests observed `uncertain` for both a port refusal and a real
service approval refusal. The implementation then made those cases `failed` while a
fake-engine rejection after dispatch remains `uncertain`. Tests also assert that an
approval refusal never calls the engine and that verification retries produce exactly
one action and one dispatch observation.

Validation on 2026-09-16:

```sh
pnpm --filter @agentbrowser/api exec vitest run \
  src/autofill.test.ts src/autofill-service.test.ts
# 2 files; 17 tests passed before overlapping retry coverage was consolidated

pnpm --filter @agentbrowser/api type-check
# passed

pnpm exec biome check packages/api/src/autofill.ts packages/api/src/service.ts \
  packages/api/src/autofill.test.ts packages/api/src/autofill-service.test.ts
# passed

pnpm --filter @agentbrowser/api test
# 44 files passed; 551 tests passed; 2 skipped
```

An independent adversarial review found no blocker. It verified callback placement,
monotonic no-throw state, one dispatch across read retries, unchanged public surfaces
and continued separation of snapshot evidence. Its only suggestion was to consolidate
overlapping retry tests; that cleanup was applied before delivery.

## Develop delivery

[PR #183](https://github.com/anvai-labs/agentbrowser/pull/183) was independently
reviewed at head `5cb7a84a2ef239b6fb651426a958a698cf9704f3` and merged to `develop` as
`618817b2f74e10fe575f01b63ddd685f12ca2570`. All eight jobs passed in the
[exact-head run](https://github.com/anvai-labs/agentbrowser/actions/runs/35092394891)
and the [post-merge run](https://github.com/anvai-labs/agentbrowser/actions/runs/35092745217).
GitHub did not permit a formal self-approval by the authenticated PR owner; the
independent review was recorded in the delivery workflow. No main promotion or release
was performed.

## Remaining boundary

This slice does not define a new public result union, durable dispatch journal or
trusted verifier registry. T2 still needs compatible shared outcome projections and
the remaining authority, identity, late-completion and cleanup acceptance cases. Main
promotion and release are outside this slice's develop delivery.
