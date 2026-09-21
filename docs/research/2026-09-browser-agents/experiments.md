# Bounded implementation experiments

Status: Q0 is an implemented candidate with [separate evidence](../../spec/evidence/t6-widget-commitment.md);
the remaining packets are proposed follow-ups.
Use the existing task's context selection and gates. Read only the selected packet
and its cited evidence; keep the entire literature review outside runtime context.
Do not introduce a new executor, transport, test framework or generic planner.

## Q0 — Restore widget tests and unify commitment verification (first)

This packet is justified by code inspection and a local test run, not by a paper.
Baseline: develop `9b80675`; the unchanged file was also checked in the T3 worktree.

`packages/api/src/autofill.test.ts` declares 15 `it(...)` blocks, but the focused
Vitest command runs 11. Four widget tests are nested in the async test that starts
at line 237: `describe('multi-step widget strategies')` starts at line 250 before
the outer test closes. Its final closing braces are at lines 410–412. Both a root
check and an independent review observed the 11-test run.

Separately, `packages/api/src/autofill.ts` immediate verification accepts either
`value` or `attributes['autofill-committed']` around lines 366–370. Its final pass
compares only `value` around line 421. The dormant successful React-select fixture
uses an empty native input value with a committed selection marker. Source analysis
therefore predicted a final-verification mismatch. The subsequent Q0 repair restored
all 15 registrations and reproduced three failures before implementation; its evidence
records the corrected preflight expectation separately from runtime fixes.

Owner: T6; existing `runAutofill` and its trusted strategy registry.

1. Move the widget suite to top-level registration without changing expectations.
   Run `pnpm --filter @agentbrowser/api exec vitest run src/autofill.test.ts` and
   record all 15 registrations plus the actual failures. Investigate each failure;
   do not assume a single fix resolves every dormant test.
2. Introduce one local, strategy-aware commitment predicate shared by immediate
   and final checks. Native values and custom committed selections have different
   semantics. A custom widget's typed search query must not prove selection.
3. Pin positive selection with an empty search input, highlight/query without
   commitment, cleared commitment after a later field, changed node/block identity,
   and duplicate-label ambiguity. Retain suffix stopping and no write replay.
4. Run existing real-Chromium autofill tests and affected service/protocol checks,
   then the normal hooks/review/CI. Recheck existing native-input semantics.

Acceptance: all intended tests actually register; correct committed selections
remain verified after the final pass; noncommitted queries and later invalidation
cannot pass; dispatched actions are not repeated during verification. No claim of
transactional rollback or new widget support. Stop and update the packet if exposed
tests reveal a different expected contract. This small fix precedes mapping work.

## Q0a — Fail closed on malformed application authorization callbacks

Owner: T4/control, `application-authority.ts` and existing `trusted-callback.ts`.
The callback's TypeScript boolean contract is insufficient for JavaScript deployment
configuration. Current truthiness checks can accept Promise/thenable results.

First supply callbacks returning Promise-false, a rejecting Promise, a thenable, and
a truthy nonboolean through the existing authority fixture. Require no binding or
dispatch and no unhandled rejection. Reuse `synchronousResult` and require literal
`true`; map failures to the existing controlled denial shape without private details.
Apply the same guard at every application authorization boundary. Validate operation
names/modes centrally against existing protocol constraints, with malformed descriptor
tests. Preserve synchronous true/false behavior, receipts and exact-ID replay.

This addresses trusted-adapter misconfiguration; it is not a claim of a remote exploit.
No new policy registry or asynchronous authorizer mode is needed for this packet.

## Q1 — Fault qualification and shared lifecycle predicates

Owner: T3/T5, using `packages/control/src/session-authority.ts`, `outcome-runner.ts`,
`verifier-registry.ts` and the existing packaged counter fixture. Evidence: E1, E2,
E14. T3's bounded delivery remains distinct from broad production reliability.

First inventory existing tests by boundary and outcome; most basic lost-response,
revocation and takeover cases already exist. Add only missing combinations at boundaries
such as before dispatch, after app commit/before response,
after receipt/before observation, during revocation and during human takeover.
Use a coverage table to select missing cases, not a new test generator, LTL parser or
parallel runtime monitor merely because a paper uses one. Reuse the same
pure predicates when a demonstrated invariant currently has duplicate owners.

Red-first properties: at most one dispatch; unknown stays unknown without evidence;
revoked writers cannot start a suffix; replay/status lookup cannot bypass current
read permission; test success requires its declared seam and independent outcome.
True process-restart tests belong to T5 after the durable-ledger design exists.
An in-memory restart simulation must not be reported as durable recovery.

Record false passes, uncertain outcomes, duplicate effects, cleanup, elapsed cost and
operation counts separately. Acceptance is zero forbidden effects in the deterministic
matrix, not a statistical guarantee about arbitrary live websites.

## Q2 — Reusable mappings with applicability checks

Owner: T6; `packages/protocol/src/autofill.ts`, `packages/api/src/autofill.ts`, existing
engine observation evidence and authority/receipt owners. Evidence: E3, E4, E7.
Prerequisite: Q0 plus existing T2 authority gates.

Reuse `parseAutofillRequest`, the existing match/value schemas and `runAutofill`.
There is no existing versioned mapping/applicability parser to reuse. Add a single
bounded descriptor/parser in the existing protocol owner only after failing cases
establish its contract. Specify field/block matchers, supported strategy,
required schema/capabilities and applicability predicates. Keep private values behind
the existing resolver. Never persist element refs as reusable field identity.

Mappings require deployment-owned versioned provenance. Page content or retrieval may
not register trusted mappings, and selecting one grants no action/destination authority.
Existing grants, route capabilities, approval and network policy still govern every
effect. Tenant-private mappings stay tenant-scoped rather than entering a shared catalog.

Algorithm: validate all mapping/value inputs and bounds → confirm applicability from
fresh complete evidence → resolve each block/field uniquely → execute serially with
the existing strategy → verify commitment → recheck earlier fields → issue the current
per-field report. Reject an inapplicable mapping before writes; retain uncertainty and
partial effects if the page changes later. No guessed clearing/compensation.

Falsifiers: two identical company labels in distinct/reordered blocks; removed block;
async option appearing after a bounded delay; recycled option nodes; focus theft;
Enter-triggered submission; selected chip removal; one field changing another; changed
locale/normalization; private values leaking through mapping or diagnostics. Build on
current fixtures instead of writing a second fake-browser framework.

Acceptance: one submitted payload has no per-field agent round trips; internal browser
actions remain proportional to work. Verify exact field membership and final app state
independently. The under-four-minute/two-live-application target still needs a separate
authorized live qualification; a fast synthetic form cannot satisfy it.

## Q3 — Evidence-aware observation expansion

Owner: T1/T8; shared core normalizer/revision/budget/artifact owners and engine evidence.
Evidence: E5, E3. Start as harness policy over existing surfaces; add protocol fields
only if missing semantics are proved by a failing case.

Baseline existing bounded snapshot/interactive observation and revision history first,
including the real-engine diff falsifier in the code findings. Whole-page HTML and
separate screenshot artifacts exist; scoped DOM/image expansion is proposed, and
`compact_dom`/`visual` modes currently reject. Screenshots lack DOM-revision/completeness
binding, masking is warning-only, and artifact size enforcement occurs after capture.

Compare baseline, valid revision deltas, and a proposed bounded expansion policy on the
same fixtures. Before expanding, specify provenance/completeness and pre-capture resource
bounds through the existing owners. The harness selects representation; the service
retains authorization and hard limits. Avoid model-name routing hardcoded into it.

Algorithm: inspect completeness and required target evidence → request the smallest
missing authorized representation → invalidate incompatible history → re-resolve →
act only with current evidence. Expanding observations must not replay a prior write.
If a delta base is missing, navigation changed generation, or output is truncated,
request a fresh bounded baseline or return incomplete rather than merging guesses.

Falsifiers: dialog occlusion, same-label controls with different layout, virtualized
lists, reordered blocks, navigation while observing, cross-origin frame content,
truncated responses, revoked artifact access, secrets in screenshots and stale deltas.
Acceptance: fewer grounding errors or lower total cost without additional false passes,
authority bypass or artifact leakage. Full HTML and screenshots are opt-in evidence,
not default prompt inflation. Paper results do not establish our gains in advance.

## Q4 — Selective procedural reuse with a no-memory control

Owner: T1/T6/T8; context loader/profile catalog, mapping applicability, installed harness.
Evidence: E6, E7. No mandatory vector store or online memory writer.

Use Q2's deployment-owned, tenant-scoped mapping provenance and authority rules.
Start with a small reviewed catalog and deterministic filters for origin/app,
task family, widget/capability version and expected input/output semantics. Rank only
after eligibility; abstain when there is no suitable candidate. Restore neither grants
nor receipts from a retrieved procedure. A success narrative is insufficient training
evidence; retain independent verification provenance for promoted procedures.

Compare no memory, known-correct mapping, filtered retrieval and deliberately near-match
retrieval. Include changed websites and uncovered tasks. Bound memory loading, generation,
curation and retrieval costs alongside the actor's tokens; do not count only prompt size.
Keep data retention, tenant separation and deletion policy outside generic task memory.

Acceptance: report covered/uncovered results and harmful-match rate separately; a useful
known mapping must not imply useful search at library scale. Keep only improvements
that survive matched total budgets and repeated runs. A small catalog can remain a
plain file structure until measured lookup requirements justify indexing.

## Q5 — Application/API parity and optional document tools

Owner: T4/T8; ApplicationAuthority and existing REST/SDK/CLI projections. Evidence:
E8, E9, E12, E13, S1. Existing typed API and CLI paths are the starting point.

The controlled counter/CLI fixtures already distinguish UI receipts from ignored UI,
API shortcuts and historical receipts using an independent oracle. Inventory that
evidence first. The next qualification needs a representative deployment-owned source
and binding UX, preserving explicit separate coverage. Break only the UI and require the API case
to pass while the UI case fails. Exercise stale versions, revocation, changed account,
duplicate operation IDs and response loss. Preserve production-evidence gating.

Only if a concrete customer site exposes document tools, design an experimental WebMCP
adapter behind current admission. Bind discovery/invocation to origin, document
generation, trusted schema digest and granted capability. On navigation, unregister or
schema change, invalidate pending selection before invocation. Tool metadata, including
read-only hints, cannot grant permission or authorize another destination.

Acceptance for that optional spike includes mid-session registration replacement,
poisoned names/schema/results, late completion after navigation and uncertain effects.
Do not auto-import arbitrary page tools into the trusted application registry. Retain
CLI discovery/JSON invocation even if no MCP bridge is installed. No public WebMCP
support or browser compatibility claim before an actual installed-browser qualification.

## Q6 — Human handoff and cross-session recovery

Owner: T5/T8; SessionAuthority, operation status/receipts and the existing scoped cursor.
Evidence: long-horizon and provenance findings E2, E10, E13; the UX proposal is ours.

Review before action should show bounded field/block changes, tested seam and partial
effects inline. A human can revoke/take over; an already dispatched operation drains.
Resume reconciles operation identity, current authority, document generation and app
state. It must not infer success from a remembered page or rerun a possibly committed
write. T5 defines durable single-owner recovery before this is advertised across restarts.

Test a human editing another field, navigation during takeover, closing/replacing a
bridge, missing receipt, restart with an in-flight write, expired grant and two claimants.
Physical human input can bypass service-mediated ownership; fresh observations and
conservative uncertainty reconcile it, rather than assuming a lock on the browser UI.
Use current service ownership across transports; a named pipe alone solves none of
these identity or durability requirements. T8 must record actual harness versions and
accessible inline interaction, not just successful protocol initialization.
Start with the installed CLI/shell baseline, then configured codingagent, Codex, Claude
and Rover projections where available. Record absent clients as unavailable; do not
infer cross-harness equivalence from another client's result.

## Q7 — Qualified engine alternatives and security workloads

Owner: T9 backend qualification; T7 only after its declared dependencies and scope gates.
Evidence: S2, E4, E11. Reuse existing Firefox BiDi/Safari and independence audits.

Run a capability-specific fixture on the existing alternate backend with Playwright
unavailable. Name unsupported scoped observation, widget verification, downloads and
network containment explicitly. Never treat a second Chromium client as browser
independence or promote read-only equivalence to write/receipt equivalence.

For authorized security regression, start with local identity/permission/configuration
fixtures and reproducible evidence. Privacy-settings automation is a useful adjacent
workflow, not broad pentesting. Live targets, scanner adapters and bounty reporting
remain separate customer/scope decisions; no new payload library follows from a paper.

## Measurement and delivery shared by every packet

Use existing tests first. New deterministic cases belong in the affected existing
suite; full package acceptance stays authoritative where shared lifecycle changes.
Offline paper review requires no GitHub runner. Do not add model calls or internet
benchmarks to required PR checks. Run paid harness experiments separately and promote
only deterministic regressions into CI, with one ready push after local falsifiers pass.

For initial model-dependent pilots, predeclare a small matched corpus and run budget
before execution (for example 12 tasks × 3 runs × 2 policies = 72 trajectories).
That is a proposed pilot size, not a power calculation or confidence guarantee. Expand
only when the measured uncertainty warrants it; report all failures and censored runs.

Record source/artifact/browser/harness/model identity, task/seed, verified outcome,
false pass, unsupported/uncertain/refused counts, human interventions, tool calls,
all model tokens/calls including memory, bytes, latency and repair effort. Keep browser
process cost distinct from service/bridge/model cost. Byte counts are not token counts.
Include costs of failed attempts in cost per verified completion; if there are zero
verified completions, report that explicitly rather than a favorable average.

Progress must use implemented → qualified on a named surface → merged → released as
separate facts. Recheck develop before each packet; reuse existing helper ownership,
obtain adversarial review and pass current gates. Research citations do not unlock
milestones or make a proposed dependency mandatory.
