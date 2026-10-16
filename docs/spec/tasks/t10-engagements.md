# T10: engagements and automation runs

Status: ACTIVE (approved 2026-10-16). Repository: agentbrowser.
Depends on: T7 (scope primitive, audit adapters); T5 (durable classification) for M4 runs.
Inputs: core, the selected appsec/bounty/operations/qa mode, security, contracts, quality-ci.

## Goal

Turn the qualified scope primitive into an engagement a researcher or operator can run, audit
and export, and make saved plans runnable from CI, without a new language or a scanner.

```
program scope ─▶ EngagementScope ─▶ scoped session ─▶ engagement ledger ─▶ findings ─▶ SARIF draft
     (M3)            (M1 holes closed)      (M2 status)      (M2, metadata only)   (M3)    (manual submit)
saved plan file ─▶ plan run ─▶ JUnit / JSON ─▶ test evaluate / CI action                  (M4)
```

## Guardrails

| Rule | Consequence |
| --- | --- |
| Authorized targets only | the scope is required for engagement features; nothing widens it |
| Restrictive-only | every new scope field can only narrow; inexpressible program rules are refused |
| Metadata only | the ledger never holds request or response bodies (a later ADR decides bodies) |
| Manual submission | reports are drafts; nothing sends a finding anywhere |
| Reuse, don't build | no scanner, payload database or bounty executor (T7 rule); ZAP stays the adapter |
| Fail closed | a lane the scope cannot check (cdp-attach, service workers, unchecked workers) is refused |

## Milestones and acceptance

| Milestone | Release | Acceptance (each test-first; real Chromium where traffic is involved) |
| --- | --- | --- |
| M1 scope without holes | 1.21.0 | an in-scope POST/PUT/PATCH redirected out of scope is blocked and recorded; a scope with `cdpAttach` or `allowServiceWorkers` is refused; worker traffic is checked or the session refused; release smoke covers a scoped session |
| M2 status and ledger | 1.22.0 | scope status (in-effect scope, budget used/remaining, expiry, denials by sub-code) and a no-budget dry-run check on REST/SDK/CLI/MCP; `SCOPE_*` sub-codes in request events; an opt-in append-only hash-chained ledger that is exportable after close, refuses when full, redacts the query unless kept, and fails verification when edited |
| M3 program scope and findings | 1.23.0 | restrictive fields (excludes, apex-plus-subdomain wildcard, ports, schemes, rate limit, program metadata); an importer for published program scope that refuses what it cannot express; findings bound to the engagement (out-of-scope evidence refused, confirmations cite ledger entries), SARIF draft export |
| M4 automation runs | 1.24.0 | a saved plan file runs from the CLI with label targets, optional durable classification and JUnit/JSON results; the CI action accepts it; T6 rollback and async/recycled-option coverage |

## Not in T10

Body capture (separate ADR), ADR-022 compact identifiers (2.0.0), OS-enforced egress (N2, gated),
automatic submission or outside communication of findings.

## Evidence

Each milestone's PRs and its release record are linked here as they land.
