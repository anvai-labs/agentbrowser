# Delegated-session validation — 2026-09-14

Implementation base: AgentBrowser `db860b6` (1.8.13), isolated branch
`feat/delegated-coexistence`. Companion Victor base: `c8a0950fe`, isolated branch
`fix/mcp-response-correlation`. The original checkouts were left untouched.

## Test-first evidence

Tests were added before their corresponding behavior. Confirmed red cases:

- Missing core state machine; subsequently six initial state/operation invariants passed.
- Controlled creation accepted unauthenticated local clients; control routes and
  deduplication absent; artifact generations absent. Four initial API cases failed.
- Firefox/WebKit falsely advertised PDF/CDP support (two assertion failures after
  workspace dependencies were built; the earlier missing-dist error was not used
  as behavioral evidence).
- Failed fresh observation left a usable review. The added regression failed;
  failure now returns authority to the human.
- An operator write after review did not invalidate that review. The added core
  regression failed; a new review is now required.
- SDK operation IDs, reconciliation methods, and lost-response identifiers were
  absent (three failures).
- Bound MCP still offered owner/cookie tools; mutations lacked a caller-known ID.
  Both new tests failed before the catalog and argument-handling changes.
- CLI lacked controlled creation/handoff, and the operator panel returned 404.
- OpenAPI omitted all five new control/operation paths.
- Victor returned notifications as results, mixed concurrent responses, and kept
  the timed-out process alive. Three real-stdio tests failed before the fix.

Additional regression cases exercise takeover during deferred evidence capture,
plan suffix cancellation, and HTTP client disconnection while a browser promise
remains pending. These extend the original state-machine invariants.

## Final local checks

Environment: macOS arm64, Node 24.11.1, pnpm 9.15.0; locked Playwright 1.62.1.
CI remains configured for Node 22. No hosted runner was invoked.

| Check | Result |
| --- | --- |
| `pnpm -r build` | Passed |
| `pnpm -r type-check` | Passed |
| `pnpm -r lint` | Passed; repository warning-level diagnostics remain |
| `pnpm -r test` | 1,461 passed, 14 skipped, across 96 passing files |
| `pnpm test:coexistence` | Focused build and regression loop passed; subsequently added HTTP-disconnect case also passed |
| Documentation links | Passed |
| Release version consistency and built API/CLI/MCP smoke | Passed at product version 1.8.13 |
| CI YAML parse/invariant inspection | All eight existing jobs retained; cancellation limited to PR events |
| Victor response-correlation + existing client tests | 61 passed |
| Victor → built AgentBrowser MCP over real stdio | Passed: bind, discover restricted catalog, act, reconcile, revoke |

The skipped cases are six Safari and eight experimental Obscura tests. They are
not evidence of a qualified alternate deployment. Chromium fixtures run on fresh
owned contexts and local fixture servers; no personal profile or external account
was used. Sandbox-denied loopback/browser starts were rerun with execution approval;
they were not treated as implementation failures or silently skipped.

## Independent outcome evidence and limits

The real Chromium acceptance fixture exercises the operator panel through its UI,
uses a bound MCP instance for agent actions, and inspects an independent HTTP
fixture's recorded effects. A repeated operation records one click, not two.
Takeover rejects the old connection; after a human edit/review/delegation, the new
agent sees the edit and its old element reference fails. This tests the actual
page and panel, without a model provider or agent narrative as the outcome oracle.

The input fixture separately asserts trusted adapter click/text-input/keydown
and an untrusted explicit DOM dispatch control. It does not claim every input
kind or browser family has been qualified.

The Victor cross-repository acceptance uses real stdio and FakeEngine to isolate
harness transport. It is opt-in via `AGENTBROWSER_ROOT`; the browser behavior is
qualified by AgentBrowser's separate Chromium fixture. Live Codex/Claude accounts
were not used; their MCP registration syntax was checked using installed CLI help.
No persistent harness configuration or delegated production credential was changed.

No independent Firefox/BiDi service, restart-safe operation store, external
business transaction precondition, or hosted network containment is certified.
These remain the explicit next acceptance tracks in
[the design and operating guide](../delegated-sessions.md).
