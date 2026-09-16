# Quality engineering and efficient CI

Status: implementation acceptance plan. This specification adds no jobs or tests.
Reuse the existing testkit, browser fixtures, packaging smoke tests and CI jobs.

## TDD sequence for each task

1. Identify the invariant and an observable failure, including a negative control.
2. Add the smallest regression test to the existing owner's suite and demonstrate
   it fails for the intended reason, not a missing browser or unrelated environment.
3. Implement the smallest change through existing helpers and contracts.
4. Run the focused suite, then relevant cross-surface/real-engine qualification.
5. Refactor duplicated behavior only after behavior is green. Re-run affected tests.
6. Review correctness, security, resource lifetime and independent evidence. Close
   findings before one final candidate CI run and the authorized release sequence.

Docs-only work runs manifest/link/consistency checks. Do not build a browser matrix
to validate prose. Future context-loader tests are meaningful because incorrect
dependency closure could omit required instructions or include unrelated data.

## Falsifying acceptance matrix

| Requirement | Test that must fail a broken implementation | Reuse location |
| --- | --- | --- |
| INV-01/02 authority | Revoke between admission/dispatch/output; old cleanup callback targets replacement; two pages race | Core/control suites and delegated fixtures |
| INV-03 identity | Same-URL reload, moved block, recycled node, repeated labels, truncated candidates | Engine conformance and autofill fixtures |
| INV-04 replay | Response lost after commit; same ID/different input; bridge death; late response; service restart | Existing continuity harness, future journal contract |
| INV-05 truth | UI reports success but server rejects; model fabricates success; redacted values collide | Testkit independent application oracle |
| INV-06 privacy | Wrong tenant fetches artifact; revoke buffered event; HTML includes secret; profile switch leaks memory | Artifact/control/transport suites |
| INV-07 bounds | Oversized nested values, disk full, slow subscriber, hung adapter, expired monotonic deadline | Existing resource-budget suites plus journal adapter |
| INV-08 reuse | Application-only isolated install loads browser/scanner; duplicated schema loses field | Deployment audits and contract tests |
| INV-09 capability | Missing engine, unsupported action, incomplete egress, custom widget misclassified as native | Qualified backend matrix and negative capability tests |
| INV-10 context | Unknown mode, cycle, missing dependency, escaped path, overbudget bundle, unwanted mode included | Future local context-loader suite |

Use generated action sequences with a deterministic seed for state-machine races
when they exercise additional cases; add a property-testing dependency only after
existing test tools are insufficient. Retain a minimal reproducer for each discovered
failure. Avoid asserting an implementation's own output as the sole success oracle.

## Test tiers and scheduling

| Tier | Trigger | Cost and evidence |
| --- | --- | --- |
| 0: static/docs | Specification or schema change | Links, manifest closure/budgets, schema/catalog consistency |
| 1: pure contracts | Changes to owner module | Validators, state transitions, deterministic fault injection |
| 2: integration | Changed execution/adapter seam | Deterministic service + actual CLI/MCP framing and independent state |
| 3: real engine | Changed browser semantics | One qualified browser fixture; affected alternative backend only |
| 4: packaged product | Final candidate/release | Extracted artifact + matching CLI/MCP + cleanup/negative smoke controls |
| 5: broader qualification | Scheduled or dependency/platform change | Cross-platform/engine/security/soak suites with named coverage |

Run local impacted tiers before pushing the final candidate. The existing eight
required main checks remain required until an explicit reviewed workflow/protection
migration replaces them. Do not remove them merely to achieve a green PR. Required
checks must always report on PRs; path filtering must not leave them pending forever.

If an aggregate gate is introduced later, it must inspect all required job outcomes
including failure/cancel/skip semantics and run with an unconditional completion
condition. An untested change cannot turn green because all its tests were skipped.
Keep cancellation limited to obsolete PR candidates; do not cancel integration/release
evidence unintentionally. Never retry a failed suite without diagnosing whether the
failure is infrastructure, determinism or a product regression.

## Adversarial review protocol

Review system trust boundaries and failure ordering separately from code style.
Challenge every success claim with a counterexample, every cache with an invalidation
case, every retry with an after-commit disconnect, every dependency with an absent-
package startup, and every mode with an unauthorized cross-mode call. Have a separate
reviewer/agent inspect the final diff when available; author tests alone are not
independent review. Record findings and their resolution, not a generic approval.

## Evidence and performance

Record source/base SHA, artifact hash, platform/browser/harness versions, exact
commands, pass/fail/skip counts, failure controls, cleanup and unqualified dimensions.
Measure schema/context bytes, model-specific tokens, startup/RSS and correctness on
the same corpus before and after optimization. Initial gates: zero false passes on
negative fixtures, zero writes after successful pre-dispatch revocation, zero blind
replays after uncertain delivery, and complete required outcome evidence.

Flake, latency and memory thresholds require a baseline and sample size. Do not turn
an arbitrary target into a claim of achieved reliability. Offline fixtures qualify
regression behavior; live third-party forms require separate authorized acceptance.
