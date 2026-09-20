# Modular product and engineering specification

Status: active product architecture and implementation contract. A capability is
delivered only when its task evidence records a merged and qualified implementation.
Functional baseline: AgentBrowser `de95a3ba2a99c675c0039e9cbb001d43172a9851`
(1.9.0 release candidate); Victor was last inspected at
`c8a0950fed49914bb2877feeb65f5ab32cc47b97`. Reviewed 2026-09-19 UTC.

Build a shared execution and verification service for people and agents. A mode
selects a small policy and capability profile; it does not create another runner,
session manager, transport, database, browser installation, or agent framework.

## Load only the needed specification

The [manifest](manifest.json) is the local, versioned context routing contract.
Every selection includes [core](core.md) and exactly one mode's dependency closure.
Links are references, not instructions to recursively read other documents.

The dependency-free local context loader reads this manifest and only its declared
Markdown modules:

```sh
node scripts/spec-context.mjs --list
node scripts/spec-context.mjs --mode qa
node scripts/spec-context.mjs --mode forms --view algorithms
node scripts/spec-context.mjs --mode application --view contracts --format json
node scripts/spec-context.mjs --mode qa --view review
node scripts/spec-context.mjs --mode qa --task t2
node scripts/spec-context.mjs --check
```

`agent` is the default view: essential invariants and a mode-specific operating
contract. `contracts`, `algorithms`, `stack`, and `review` are explicit engineering
expansions. Each has a byte ceiling. The loader resolves declared dependencies,
deduplicates modules, rejects unknown selections/cycles/escaped paths, and fails over
budget without emitting a partial context. It reports exact serialized UTF-8 bytes and
per-module SHA-256 hashes. It does not read personal data,
external links, the rest of the repository, or install a runtime plugin.

`--task` selects the task view and loads one packet plus its declared shared inputs;
implementation dependencies are checked for readiness without loading their packets.
Unsupported task/mode pairs or conflicting view selections fail explicitly.

The original delivery contained **specification and design only**, including
machine-readable routing metadata and [agent task packets](tasks/README.md). Later
increments implemented part of that design. The [task index](tasks/README.md) now
separates released, active and pending work. A smaller Markdown bundle alone does not
prove lower model token use, process RSS, or a smaller browser dependency closure.

Implementation was subsequently activated for the first foundational T0 increment:
shared CLI/MCP guidance, bounded CLI input/discovery and negotiated MCP autofill
results with generated catalogs. See [T0 progress](tasks/t0-contract-catalog.md#current-implementation-state).
T1 now has a local spec-context loader, trusted fixed runtime profiles, a scoped
non-secret run cursor and inline operator mode selection. See the
[T1 packet](tasks/t1-context-profiles.md) and
[qualification evidence](evidence/t1-context-profiles.md). Installed harness cursor
consumption remains T8 work.
T2 is complete. AgentBrowser 1.9.0 includes the configurable REST/SDK/CLI outcome run,
shared receipt correlation, admission/drain and evidence-permission foundations, and
the controlled G4 CLI qualification delivered through PR #208. T3 is active with
the delivered bound-report/navigation foundation and candidate offline CLI evaluation;
[native JUnit probes](design/t3-node-test-qualification.md) advance internal reporting.
An [application-owned installed-CLI recipe](design/t3-application-recipe.md) is locally
qualified against the fixed counter deployment; arbitrary application setup remains. Production evidence sources, G6 and durable
recovery remain explicitly unqualified. See the
[foundation qualification](evidence/t2-foundation-qualification.md) for the acceptance
mapping and delivery record.
See the
[T2 packet](tasks/t2-shared-execution.md) and
[dispatch-boundary](evidence/t2-dispatch-boundary.md) and
[HTTP result-classification](evidence/t2-http-result-classification.md) and
[application identity](evidence/t2-application-identity.md) and
[semantic result-validation](evidence/t2-semantic-result-validation.md) and
[plan verification-evidence](evidence/t2-plan-verification-evidence.md) and
[outcome/verifier foundation](evidence/t2-outcome-verifier-foundation.md) and
[outcome-run vertical](evidence/t2-outcome-run-vertical.md) and
[application permission](evidence/t2-application-evidence-permission.md) and
[installed CLI application outcome](evidence/t2-cli-application-outcome.md) evidence.

The T3 candidate reuses that CLI/service path for a 13-case deterministic matrix.
Offline `test evaluate` and SDK barrel exports compose the same bound contract; no
REST/MCP tool, dependency or CI job is added. It remains active and does not unlock
T7 or T3-dependent T8 qualification. See the [T3 packet](tasks/t3-qa-regressions.md)
and [CLI qualification](evidence/t3-cli-evaluation.md). Published 1.9.0 lacks this command.

T4 has one public-interface slice delivered in 1.8.20 by PR #201: bounded,
authenticated application discovery, execution and receipt lookup now use the shared
`ApplicationAuthority` through REST, the TypeScript SDK and a first-class CLI command
group. This is not the complete application-parity vertical. The 1.9.0 foundation
adds delegated receipt-permission composition; operator-binding UX, an independent
UI/API parity oracle, production application evidence and durable restart receipts
remain open. MCP is optional and has no
application-operation projection. See the
[application authority guide](../application-operation-authority.md) and
[T4 packet](tasks/t4-application-parity.md).

T6 is partially delivered in 1.8.19: the existing autofill orchestrator now has named
`react-select` and `chip-multiselect` strategies. Broader widget qualification,
reusable mapping and cross-engine acceptance remain open. T3 has an active internal
foundation but no delivered product vertical; T5 and T7 have none. T8 still needs
installed-harness qualification. T9 is a
recurring release gate rather than a one-time feature.

## Modes

| Mode | Job | Incremental data; shared execution remains mandatory |
| --- | --- | --- |
| [qa](modes/qa.md) | Web development and repeatable regression | Test case, fixture, assertions, baseline and test report |
| [operations](modes/operations.md) | Recurring authorized business workflows | Mapping, checkpoint and application outcome predicate |
| [audit](modes/audit.md) | Website visual, accessibility and performance checks | Audit plan, baseline and measurements |
| [appsec](modes/appsec.md) | Authorized application-security regression | Scope policy, identity matrix and finding evidence |
| [bounty](modes/bounty.md) | Researcher-directed bug-bounty assistance | Appsec contract plus program rules and report provenance |
| [forms](modes/forms.md) | Bulk forms, including job applications | Mapping and scoped private value references |
| [application](modes/application.md) | Browser-free application operations and UI/API parity | Trusted binding, business version and durable receipt locator |

## Engineering modules

| Module | Load to answer |
| --- | --- |
| [Vision](vision.md) | Who buys, what is differentiated, what stays out? |
| [Architecture and reuse](architecture.md) | Who owns each concern; which existing code is extended? |
| [Grounding](grounding.md) | What evidence makes an action or a success claim valid? |
| [Contracts](contracts.md) | Which data structures cross boundaries and who validates them? |
| [Execution algorithms](execution.md) | How are resolution, dispatch, verification and recovery ordered? |
| [State and memory](state-memory.md) | What is retained, loaded, invalidated and reclaimed? |
| [Security](security.md) | Which trust boundaries must hold before a deployment is qualified? |
| [Interfaces and UX](interfaces.md) | How do MCP, CLI, UI and application interfaces share semantics? |
| [Quality and CI](quality-ci.md) | Which falsifying tests prove requirements without redundant CI? |
| [Delivery](delivery.md) | What is delivered, what comes next, and what is the release gate? |
| [Design review](review.md) | What failed review, what remains uncertain, what closes each finding? |

## Precedence and change control

This is the current cross-mode design proposal, extending the historical
[MVP specification](../../agentbrowser-mvp-spec.md). Shipped wire behavior remains
defined by protocol source and qualified tests; new behavior requires explicit
versioned migration. Existing [engine qualifications](../engines.md),
[bulk autofill limits](../bulk-autofill.md), and
[transport deferrals](../transport-integration-contract.md) remain factual limits.
This proposal does not restart the deferred browser-egress gateway project.

Invariant IDs in core are normative for this design. Detailed modules refine them
without weakening them. Requirements in modes reference shared contracts instead
of copying them. Update this index/manifest only when a module's responsibility or
load boundary changes. Update source-derived capability documentation with its
implementation; never maintain parallel handwritten protocol schema catalogs.
