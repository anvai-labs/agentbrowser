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
| Authorized targets only | a scope is necessary, not sufficient: live targets need the researcher's explicit authorization (recorded as `program.authorizedBy/At`); public reachability or an imported program file is not permission. Until a live target is named, T10 is tested on local fixtures only |
| No parity claim | T10 ships engagement tooling; T7's T4 condition still governs any application-security parity claim, which T10 does not make |
| Restrictive-only | every new scope field can only narrow; inexpressible program rules are refused |
| Metadata only | the ledger never holds request or response bodies (a later ADR decides bodies) |
| Manual submission | reports are drafts; nothing sends a finding anywhere |
| Reuse, don't build | no scanner, payload database or bounty executor (T7 rule); ZAP stays the adapter |
| Fail closed | a lane the scope cannot check (cdp-attach, service workers, unchecked workers) is refused |

## Milestones and acceptance

| Milestone | Release | Acceptance (each test-first; real Chromium where traffic is involved) |
| --- | --- | --- |
| M1 scope without holes | 1.21.0 | an in-scope POST/PUT/PATCH redirected out of scope is blocked and recorded; a scope with `cdpAttach` or `allowServiceWorkers` is refused; worker traffic is checked or the session refused; release smoke covers a scoped session |
| M2 status and ledger | 1.22.0 (status, sub-codes); 1.23.0 (ledger, export, offline verify) | scope status (in-effect scope, budget used/remaining, expiry, denials by sub-code) and a no-budget dry-run check on REST/SDK/CLI/MCP; `SCOPE_*` sub-codes in request events and wire-level denials (blocked redirects, `page_create`, `act`/`plan`); the `navigate` preflight refusal already carries one on all four surfaces; an opt-in append-only hash-chained ledger that is exportable after close, refuses when full, never writes query strings, bodies or identity values, and fails verification when edited |
| M3 program scope and findings | 1.23.0 | restrictive fields (excludes, ports, schemes, rate limit, program metadata); an importer for published program scope that maps `*.host` to subdomains only (the apex is in scope only when listed), refuses ambiguous wildcards and anything else it cannot express; findings bound to the engagement (out-of-scope evidence refused, confirmations cite ledger entries), SARIF draft export |
| M4 automation runs | 1.24.0 | a saved plan file runs from the CLI with label targets, optional durable classification and JUnit/JSON results; the CI action accepts it. Released alongside: T6 rollback and async/recycled-option coverage, owned and recorded by [T6](t6-widget-strategies.md) |

## Not in T10

Body capture (separate ADR), ADR-022 compact identifiers (2.0.0), OS-enforced egress (N2, gated),
automatic submission or outside communication of findings.

## Evidence

| Item | State |
| --- | --- |
| M1: redirects after POST/PUT/PATCH checked in scoped sessions | #540 |
| M1: a scope refuses `cdpAttach`, service workers and a top-level (unvalidated) scope | #541 |
| M1: workers | dedicated-worker POST redirects are checked (`body-redirect-guard.test.ts`; observed coverage, not a guarantee); service workers are refused with a scope (#541); shared workers and worker WebSockets stay a stated residual (not qualified) |
| M1: released in 1.21.0 | [release record](../evidence/release-1.21.0.md): the smoke passed on the extracted release candidate |
| M1: release smoke | `scripts/scope-consumer-smoke.mjs`: lane refusals (REST rule ids; CLI/MCP service workers), out-of-scope navigation on all four surfaces, POST redirect blocked and recorded; local fixtures, run against the extracted release candidate |
| M2: engagement ledger (recorder, fail closed) | `engagement-ledger.ts`; operator guide "Engagement ledger"; export and verify surfaces next |
| M2: `SCOPE_*` sub-codes everywhere a scope denies | navigate preflight (#547); redirect hops, `request.failed` events, MCP structured errors (#549); released in 1.22.0 |
| M2: scope status and dry-run check (REST, SDK, CLI, MCP) | `GET /v1/sessions/{id}/scope`, `…/scope/check`; MCP `scope` tool (#548, #551); released in 1.22.0 |
| M2: export and offline verify | `GET /v1/engagements/{id}`, SDK, CLI `engagement export` / `verify` |
| M2: ledger release smoke; crash-path ordering | `scope-consumer-smoke.mjs` ledger check (export over REST, CLI verify, edited copy refused); crash keeps close-time records |
