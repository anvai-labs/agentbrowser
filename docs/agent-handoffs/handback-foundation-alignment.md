# Handback: foundation-alignment sequence complete

Status: done. All work merged to `develop`; nothing open on the scope this
session owned. Written 2026-09-19 by the session that executed the
[foundation-reuse handoff](claude-foundation-reuse.md). The original session
can take over from `develop` at `13f1073`.

## Takeover recheck

The receiving session verified current develop `4601e77` after this document merged.
[Rechecked identities, acceptance and remaining work](../spec/evidence/foundation-handback-recheck.md)
supersede the original status observations below: navigation reset already shipped
through PR #214, and the helper module alone is not an acceptance entrypoint. The
alignment PRs remain merged; the recheck records finite residual contract-guard gaps.

## What was done

Cross-validated T0–T3 per the handoff (installed binaries, service, source,
published artifacts — capability matrix with evidence returned first), then
implemented only demonstrated gaps, as eight merged PRs in three arcs.

### Arc 1 — the demonstrated reuse gap

| PR | Delivered | Merge |
| --- | --- | --- |
| [#213](https://github.com/anvai-labs/agentbrowser/pull/213) | `describe application execute --schema` projects the canonical protocol schemas through the T0 machinery. The audit's one proven silent-null drift. | `54f7246` |

### Arc 2 — shared-infra slice 2 (ApplicationAuthority over REST/SDK/CLI), released as v1.8.20

| PR | Delivered | Merge |
| --- | --- | --- |
| [#201](https://github.com/anvai-labs/agentbrowser/pull/201) | Operator bind/unbind + delegated discover/execute/receipts; `application.discover`/`application.execute` capabilities granted only to the `application` agent mode (browser modes fenced); HTTP oracle re-driving the versioned-counter fixture. Released through the full ladder (tap #55, brew, live smoke). | `0d18b0c` |

### Arc 3 — architectural alignment (the drift classes, made mechanically impossible)

| PR | Delivered | Merge |
| --- | --- | --- |
| [#215](https://github.com/anvai-labs/agentbrowser/pull/215) | Bidirectional openapi parity from the server's own route collector (registered⇔documented), `openapi.json` freshness gate, manifest↔protocol registry sync. Fixed a real miss: `POST .../downloads/{filename}` was never documented; the `expectedPaths` hand-list had rotted 3 rows. | `ffc1fca` |
| [#216](https://github.com/anvai-labs/agentbrowser/pull/216) | Compiled `AgentBrowserClient satisfies CliClient/McpClient` contracts (ADR-015:145–146, open since 1.8.18); mirror returns tightened to protocol aliases. | `0a568d5` |
| [#217](https://github.com/anvai-labs/agentbrowser/pull/217) | Wire contracts declared at command definition; the `describe --schema` ternary deleted; runtime gate refuses unadvertised JSON commands; `jsonContractAudit()` drift test; `extract --schema/--records` onto the bounded reader (@file/stdin/1 MiB). Review verified byte-identical output across all 66 describe paths. | `c677c3c` |
| [#218](https://github.com/anvai-labs/agentbrowser/pull/218) | Capability/admission/safety declared at route registration via `on()`; the `delegatedRoutes` regex table and wrapper string-matches deleted; `SELF_ADMITTING_ROUTE_SEGMENTS` protocol constant consumed by wrapper + SDK mint predicate; 34-route golden snapshot + delegated spot tests. | `824a0ea` |
| [#219](https://github.com/anvai-labs/agentbrowser/pull/219) | `applicationReceiptOutcomeOptions` — the blessed T2 composition extracted from the acceptance fixture; descriptor derived from the verifier's own descriptor; anti-weakening guard on the permission stamps. | `3736491` |
| [#220](https://github.com/anvai-labs/agentbrowser/pull/220) | MCP `OPERATION_ID_TOOLS` dedupe + schema-sync gate pinning the five hand-written tool schemas to their true surfaces with reviewed-absence reasons. | `34938ca` |
| [#221](https://github.com/anvai-labs/agentbrowser/pull/221) | `requireWireContract` exported pure + refusal-branch pinning test; `jsonContractAudit()` frozen snapshot; api re-exports the composition policy types. | `13f1073` |

Every PR: failing-first tests, full workspace gate, CI 8/8, adversarial
review of the exact head (all verdicts SHIP), merge commit. A final
workspace gate on the merged tip (`13f1073`) was green: 16 packages
type-check, all suites pass.

## What was corrected

- **#217 silently failed its first merge.** A `gh pr merge` inside a chained
  background command errored invisibly; the branch stayed OPEN while later
  PRs merged around it, and the executing session reported it merged in
  error. Caught when the operator re-asked "did it merge"; fixed by merging
  current develop into the branch (one conflict: both tail test describes
  kept — the wire-contract drift gate and #216's SDK-mirror companion) and
  re-landing as `c677c3c`. Lesson recorded: verify PR state after every
  merge command; chained `tail` output hides failures.
- **#201 review majors fixed pre-release** (`feeb902`): the SDK minted a
  random-UUID operation header on every non-GET session call, so application
  replays threw `INVALID_RESPONSE` instead of reconciling; and the published
  replay schema omitted the `operation` field the authority returns.
- **Review nits folded in**: `additionalProperties: false` assertion (#213),
  HEAD-parity pins for the fastify config copy (#218, `e5565c7`), gate
  pinning + audit freeze + type re-exports (#221).

## Rejected candidates (do not re-propose without new evidence)

1. **Flipping `sourceDescriptor` so absent `authorization` defaults to
   `'required'`** — ≥10 legitimate no-auth read-only evidence sources rely on
   absence meaning "not required" (`outcome.test.ts`, `outcome-runner.test.ts`);
   the flip breaks `supportsCorrelation` and `prepareRead` semantics for all
   of them. Replaced by the builder + anti-weakening guard (#219).
2. **Deriving the five hand-written MCP tool schemas from protocol spreads** —
   three of the five have no protocol schema, and existing protocol schemas
   advertise fields the handlers ignore (`ObservationRequest.sinceRevision`,
   `SessionRequest.locale`). `browser_navigate` is the one clean per-tool
   derivation follow-up (#220).

## Still open (unchanged ownership — not gaps in this work)

- **T3 slices 2–4**: public `test run` surface, JUnit/HTML exporters,
  navigation reset — deferred by design
  (`docs/spec/design/t3-regression-report.md:184–186`); no written design to
  implement against yet. The parallel session's branch
  `test/t3-navigation-reset` was observed in flight.
- **T8** installed-harness qualification — separate repo (`../codingagent` /
  Victor), own PR gates.
- **T5** durable recovery; production verifier/source deployment
  configuration — deployment-side; the surface ships fail-closed.
- **Small follow-ups noted, deliberately not churned**: `session create
  --cookies` stays inline (shape owned by `SessionRequestSchema.cookies`;
  documented in code); navigate-only MCP schema derivation; the route
  collector's OPTIONS filter would hide a hypothetical future OPTIONS
  contract route.
- **Release position**: published release is v1.9.0; `develop` additionally
  carries the T3 internal foundation (#212) and this whole alignment
  sequence. Nothing on develop is breaking; cut the next release through the
  normal ladder when ready.

## Machine state (this Mac)

brew + service on **1.9.0** (`:5709`, healthy); release smoke exit 0;
`openapi.json` and MCP catalogs gate-enforced. Working worktree
`/tmp/ab-t4` is on the merged tip; local alignment branches can be pruned.
