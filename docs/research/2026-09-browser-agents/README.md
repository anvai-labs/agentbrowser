# Browser-agent research review — 20 September 2026

Status: research-informed proposals plus a locally qualified implementation repair.
Code baseline: develop `9b80675f23bcba4a8680c4938f05779938a67037`.
The separate T3 standalone/cost checkpoint is merged through #231. The Q0 widget
repair is the current candidate; see [repair evidence](../../spec/evidence/t6-widget-commitment.md).
Other experiments below remain proposals, not implemented capabilities.

Keep the CLI-first service and shared authority design. The highest-value changes
are stronger failure qualification, reusable form mappings with applicability checks,
and evidence-aware observation expansion. Research does not justify a new planner,
browser fork, mandatory MCP bridge, vector database, or model runtime in this product.
These are our engineering judgments; paper results have not been reproduced here.

Read this overview first. Load [source evidence](evidence.md) only for the relevant
claim, [code findings](code-findings.md) for reproducible implementation gaps, and
[implementation experiments](experiments.md) only for the selected task.
These research files are deliberately outside the default spec-context manifest.

## Prioritized decisions

The accompanying code audit found an immediate repair ahead of research experiments:
four widget tests were not registered, and immediate/final commitment checks disagreed.
It also found missing runtime rejection of asynchronous application authorization
callbacks and a likely delta-identity mismatch. See [the evidence and priorities](code-findings.md)
and [Q0/Q0a repair packets](experiments.md).

| Priority | Recommendation | Existing owner / milestone | Why now; evidence |
| --- | --- | --- | --- |
| Repair gate | Restore widget tests/commitment checks and reject malformed authorization callbacks | Existing autofill strategy and ApplicationAuthority owners; Q0/Q0a | Concrete code findings precede the research experiments; see the linked reproduction and static evidence. |
| P0 | Extend fault and negative-control qualification before adding autonomy | TestCase/outcome runner; T3, then T5 recovery | Live-site instability and long trajectories expose failures hidden by short clean tests. WAREX and Wuying [E1–E2](evidence.md#reliability-and-evaluation). |
| P0 | Finish reusable, versioned form mappings and widget commitment predicates | `runAutofill`, existing request/match schemas, strategy registry; T6 | Stateful controls and complex interactions remain difficult. Reuse the existing bulk loop; test committed state rather than highlight/text alone. CAP and WebSP-Eval [E3–E4](evidence.md#reliability-and-evaluation). |
| P0 | Preserve independent application outcomes and explicit UI/API coverage | ApplicationAuthority, verifier registry; T4 | CLI/API execution can be efficient, but cannot prove the UI works. Terminal/API findings support offering both seams [E8–E9](evidence.md#interfaces-and-tool-design). |
| P0 | Test page/tool provenance and destination authorization at existing boundaries | SessionAuthority for actors; NetworkPolicy/session request policy/engine enforcement for destinations; T2/T4, optional T7 | Structured tools also carry injection and lifecycle risks. Add local adversarial fixtures before exposing dynamic page tools [E10–E13](evidence.md#trust-and-security). |
| P1 | Add bounded observation escalation experiments | Observation normalizer, revision store, budgets, artifact store; T1/T8 | Minimal observations are not always best. Compare compact state, revision deltas, scoped DOM and selected screenshots under equal total budgets [E5](evidence.md#observation-and-memory). |
| P1 | Retrieve reusable procedures only after applicability checks | Existing context loader, mappings and harness; T1/T6/T8 | Near-match memory can erase transfer gains. Include a no-memory baseline and account for retrieval/curation cost [E6–E7](evidence.md#observation-and-memory). |
| P1 | Qualify restart reconciliation and human takeover before unattended long runs | Operation ledger design and SessionAuthority; T5/T8 | Long-horizon results motivate recovery tests; they do not establish safe write retries. Keep uncertain outcomes explicit. |
| P2 | Prototype document-native tools only as a gated adapter | ApplicationAuthority and existing projections; T4/T8 | WebMCP is an evolving draft with relevant lifecycle hazards, not a reason to replace REST/CLI [S1](evidence.md#standards-and-adjacent-evidence). |
| P2 | Expand independent backend qualification where required | Existing Firefox BiDi and Safari adapters; T9 | Keep Playwright as the qualified baseline while testing a named alternate capability. Different wrappers over Chromium are not independent browser redundancy [S2](evidence.md#standards-and-adjacent-evidence). |

P0 means priority within the relevant task's existing gates, not permission to skip
T3 delivery or start every workstream concurrently. New experiments remain proposals.

## Architecture consequences

The common path stays: authorized intent → discovery → admitted operation → selected
UI/application adapter → observed evidence → independent verification → bounded receipt.
CLI, REST, SDK and optional MCP translate this same contract. Model choice, planning,
memory ranking and learned recovery policies remain in the agent harness.

For automation, select an authorized API or UI seam before dispatch using declared
requirements and qualified capabilities. For a UI regression, require the UI seam.
After an uncertain write, reconcile the original identity; never try the API, another
browser, or a fresh operation ID as an automatic fallback. Capability fallback is safe
only before effects, or after an independently established no-effect outcome.

Keep serial mutation as the default. Separate fieldsets are not proof of independent
DOM state: focus, validation, shared suggestions, autosave and submit handlers may span
them. Parallelize independent read-only research or isolated sessions, not form writes
without an explicit dependency and effect proof.

Form filling is already a server-orchestrated bulk operation. The next unit of reuse
is declarative mapping data, not generated executable scripts: schema/version,
applicability predicates, block-scoped field matches, qualified strategy identifiers,
expected commitment semantics, and references to private values. The service resolves
fresh refs and executes through the existing loop. Field verification remains distinct
from full business submission/receipt verification.

Adaptive observation must never turn a larger prompt into stronger authority. Preserve
document/session generations, completeness, redaction and evidence provenance across
compact, delta, DOM and image representations. Expand for missing evidence under a
budget; treat exhausted or degraded evidence as incomplete. A screenshot can help
ground an action but cannot independently certify a backend commit.

Memory has distinct owners: the harness may retain distilled procedural hints; the
service owns execution identity, grants and operation status and mediates scoped receipt
reads; the application/adapter owns business receipts. Cached hints cannot restore a
grant or reuse a stale ref. Start with deterministic applicability checks and a small
trusted mapping catalog; a vector index is optional only after retrieval value is shown.

Human collaboration should expose a bounded proposed action, affected block/fields,
observed changes and uncertainty inline. Reuse takeover/revocation/drain semantics;
resuming requires fresh authority and observations. Service control cannot physically
lock out a person clicking a headed browser; reobserve and preserve uncertainty after
out-of-band changes. No destructive DOM rewriting is
needed to offer a review preview, and nothing should depend on an arrow-key UI.

## Product implications

Retain the existing order: developer regression QA, recurring business workflows,
then audit and authorized security regression. Forms are a valuable demanding workload
for these foundations. Papers establish technical failure classes, not TAM, pricing,
retention, or willingness to pay. A numeric market estimate would need separate data.

For solo developers, prioritize installation simplicity, local reproduction, private
evidence and low repair effort. Measure false passes and cost per verified completion,
not just success rate or cheap actions. General browsing, scraping and short-form demos
alone provide a weak differentiation hypothesis; dependable shared authority and
reproducible failure evidence are the stronger hypothesis to validate with users.

Website privacy-settings tests are an adjacent use case; WebSP-Eval is not evidence
that AgentBrowser performs penetration testing. Security modes still need authorized
scope, identity fixtures and reproducible findings. No scanner dependency or live-target
testing follows automatically from this review.

## Sequence and stop rules

1. T3 standalone/cost qualification is delivered with all eight PR and post-merge checks
   green; retain its bounded [completion scope](../../spec/evidence/t3-standalone-qualification.md).
2. Deliver the Q0 widget repair after independent review/CI, repair the application callback
   guard (Q0a), then take the
   mapping/commitment packet in [experiments](experiments.md), starting
   with failing tests in existing deterministic fixtures; retain T4's parity gate.
3. Qualify T1/T8 observation and memory choices on the same tasks and budgets.
4. Implement T5 recovery before advertising unattended cross-session write resumption.
5. Consider WebMCP or extra backends only when a named workload fails for lack of them.

Retain all current authority and privacy gates throughout. Do not expand T3 completion
to mean general browser-agent reliability. Do not import research frameworks into the
runtime simply to reproduce a paper. Stop an experiment if it duplicates an owner,
weakens a falsifying test, hides unsupported behavior, or adds cost without measured gain.

The literature review itself adds no runtime dependency or release. Q0's implementation
and T3's completion record are separate, linked evidence; neither establishes the other
research proposals. The LAN search credential is not stored in these documents.
