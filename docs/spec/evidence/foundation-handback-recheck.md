# Foundation handback: verified baseline and remaining work

Checkpoint: 2026-09-19 America/Chicago (health probe returned 2026-09-20 UTC).
Rechecked base: `4601e77d4390133ec554c13919b25f0edecf5472`, the PR #222 handback
merge after code tip `13f1073`. This supersedes stale status observations in the
[original handback](../../agent-handoffs/handback-foundation-alignment.md).

## Repository, release and machine identity

- Canonical remote here is `anvai-labs` → `anvai-labs/agentbrowser`. Local `origin`
  points to `anvaiops/agentbrowser`; never substitute it silently during takeover.
- PRs #212, #214 and #215–222 are all MERGED, and their merge commits are ancestors
  of `4601e77`. No open PRs existed at this checkpoint. Other worktrees were preserved.
- PR #222 passed all eight checks in run `35477991461`. Its docs-only merge has no
  push CI run by design; code parent `13f1073` passed run `35477370973`. Do not invent
  a post-merge run on `4601e77`.
- Published release remains `v1.9.0`; remote main/tag both identify
  `02f263f3764b41f923553c69c11dff69c819fae5`. Develop's later capabilities are not a
  newer installed release merely because package versions still say 1.9.0.
- Installed `agentbrowser --version` reports 1.9.0. A read-only local health probe
  reports healthy service 1.9.0. No upgrade, restart, configuration or credential change
  was made. Health/version alone does not qualify production verifiers or harnesses.

## Acceptance re-run, not an import-only probe

`node scripts/cli-outcome-acceptance.mjs` is **not a test command**: the module exports
helpers and has no direct-entry runner. It exits 0 with no output and executes zero
cases. The real entrypoint is `scripts/package-acceptance.mjs`, which awaits the outcome
matrix as part of its extracted-package checks.

This recheck built a clean package and compiled CLI/MCP binaries from `4601e77`, then
ran the actual entrypoint under Node v22.23.2 against isolated local fixtures:

```sh
# Required values identify one freshly built/extracted candidate and its native clients.
PLAYWRIGHT_BROWSERS_PATH="$BROWSER_CACHE" node scripts/package-acceptance.mjs \
  --server-root "$EXTRACTED/server" --expected-version 1.9.0 \
  --expected-commit 4601e77d4390133ec554c13919b25f0edecf5472 \
  --cli "$CLI_BINARY" --mcp "$MCP_BINARY"
```

Observed result: **PASS, eight of eight groups, all 13 expected outcome case verdicts**;
package `dirty: false`, report `releaseEvidence: true`. This is clean candidate package
evidence, not a new tag, main promotion or publication. Local audit artifact:
`/private/tmp/t3-handback-acceptance.json`; packaged build stamp and compiled binaries
were checked independently by the acceptance entrypoint.

Navigation reset is already delivered by PR #214 (`9e36292`) and remains in this
matrix. Do not start another navigation-reset implementation. It qualifies explicit
same-page CLI navigation/reference reacquisition, not cookie/storage/context isolation.

## Reconciliation of prior review findings

| Finding | Current disposition | Bounded follow-up |
| --- | --- | --- |
| Exported live `delegatedRoutes` authority table | Resolved by #218: table/export deleted; authorization reads registration config | Preserve definition-local capability ownership. |
| Optional SDK mirror members can disappear without compilation failure | Still reproducible on `4601e77` | Derive selected member types from the SDK using `Pick`/`Partial<Pick>` or prove a required production projection; retain partial test stand-ins. |
| Narrowed SDK request inputs pass method-style assignability | Still reproducible on `4601e77` | Prove incompatible caller inputs fail compilation; avoid another copied interface or generic framework. |
| Download-ID / duplicate-filename semantics absent from help/OpenAPI | Still present | Document ID-preferred collection and unique-filename fallback without changing the existing wire route; qualify the existing ambiguous-name/ID-success behavior. |

The compiler fault models still compile after removing `applicationDiscover`/`operation`
and narrowing `create` to require an extra input field. The merged type assertions are
useful intent documentation, but not proof that all renamed/narrowed signatures fail.
Treat these as finite follow-ups, not a reversal of the merged alignment work or T0/T2.

### Follow-up implementation

The next slice derives CLI/MCP client signatures from the SDK with `Pick`/`Partial<Pick>`.
`scripts/sdk-client-contract.test.mjs` compiles real consumers against in-memory SDK
faults: renamed optional methods and narrowed create inputs now fail, while the baseline
compiles. It runs in the existing Type Check job. This resolves the two compiler findings
above; their `4601e77` observations remain the historical failing-first evidence.
CLI discovery/help, SDK parameter documentation and generated OpenAPI now describe
ID-preferred collection and unique-filename fallback. The wire path and delegated
permissions are unchanged; the existing real-browser duplicate-filename/ID test
remains the runtime oracle.

Two additional review questions should be tested before broadening claims:

- Route snapshots expose capability but infer admission/safety from path lists. Add a
  mutation probe for changed `admission`/`safe` and, if it stays green, pin the actual
  registration metadata rather than introduce another policy table. The remaining
  mutable `registeredRoutes` snapshot affects test-oracle integrity, not live authority.
- The outcome composition builder selects a verifier to derive source metadata but
  forwards deployment authorization policy unchanged. Before multi-verifier reuse,
  test a second verifier sharing that source/capability and define whether selection
  is exclusive. Do not claim an automatic ID/version fence that the helper lacks.

Focused independent recheck passed 22 API route/contract/provider tests, 31 application
permission tests and the workspace build. These passes do not negate the negative
fault models above. Keep rejected global authorization-default changes and broad MCP
schema spreads rejected; no new evidence justifies them here.

## Next plan and ownership

1. Preserve the landed definition-local CLI/route metadata, protocol constant, schema
   sync and `applicationReceiptOutcomeOptions` helpers. No alternate registrations.
2. Preserve the compiler fault probes and ID-preferred download descriptions above.
   Do not widen delegated download permissions.
3. Implement the reviewed [offline CLI evaluation design](../design/t3-cli-evaluation.md)
   as the next T3 binary integration, then qualify a conventional-runner/report recipe.
   The later [CLI qualification](t3-cli-evaluation.md) implements that design in the
   develop candidate; published 1.9.0 remains unchanged.
4. Keep T8 installed harness work separate per repository, T5 recovery conditional,
   and T7's evidence/scope gates closed. T9 remains active and recurring. Main/release
   promotion needs fresh candidate evidence and the applicable authorization.

T3 execution runners, scheduling, fixture/plugin configuration, standalone JUnit/HTML
adapters, impact selection and public npm packaging remain separate decisions. The next
slice shares existing case truth and lifecycle; it does not create a new harness service.
