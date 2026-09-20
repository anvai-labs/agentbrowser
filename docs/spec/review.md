# System, software and application design review

Original review baseline: AgentBrowser 1.8.17 commit
`cec8b657b84afd82fcea6307b40666c0168531d6` and Victor
`c8a0950fed49914bb2877feeb65f5ab32cc47b97`. Progress was reconciled against released
AgentBrowser 1.8.19 commit `b4360b93276146123076f776f7a7592bc4bf1740`
on 2026-09-17. Findings describe design risks; the task index and evidence records
state which closures have shipped. This is not a new runtime penetration test or
independent approval of unqualified modes.

## Decision

Proceed with the modular design, subject to the implementation gates below. Reuse
the existing control state machine, authority, protocol, action/observation and artifact
owners. Avoid separate mode runtimes. The largest risks are incorrect outcome claims,
authority/recovery races, stale grounding, unqualified network boundaries, and confusing
smaller prompts with actual dependency independence.

## Findings and required closure

| ID / priority | Grounded finding or design risk | Required closure / task |
| --- | --- | --- |
| R01 P0 | README/MCP discovery under-reports newer tools and recommends outdated form selection | Canonical catalog + explicit runtime acceptance; T0 |
| R02 P0 | Current MCP action prose recommends retry after timeout; writes can be uncertain | One retry policy and reconciliation guidance; after-commit disconnect tests; T0/T2 |
| R03 P0 | Root security claims exceed [engine qualifications](../engines.md) | Honest deployment capability matrix; no hosted scope claim without probes; T0/T7 |
| R04 P0 | A completed browser command is not an application commit | Independent outcome predicates and separate execution/verification axes; T2/T3/T4 |
| R05 P0 | Inspected Victor client reads per request and warns on response-ID mismatch | One bounded correlation owner; late/canceled/out-of-order tests; T8 prerequisite |
| R06 P1 | Mode fragmentation can duplicate policies, stores, schemas and helpers | Descriptor-only modes and one-owner reuse review; T1/T2 |
| R07 P1 | Selective docs do not enforce runtime tool or data access | Server intersection of policy/grant/profile/capability; context-leak tests; T1 |
| R08 P1 | In-memory status and synchronous autofill receipts do not survive restart | Optional journal with intent/dispatch/terminal crash matrix; T5 |
| R09 P1 | React-select and chip-multiselect now have named strategies; broader widgets, rollback and cross-engine commitment remain unqualified | Strategy-specific commitment/focus tests; no fallback replay; T6 |
| R10 P1 | Public application tools and durable application receipt qualification are pending | Reuse typed port; no arbitrary endpoints; UI/API oracle parity; T4/T5 |
| R11 P1 | Package installation and runtime imports have different dependency costs | Isolated application-only and bridge audits plus startup/RSS measurements; T1/T8 |
| R12 P1 | CLI/MCP/server can each accumulate retry, schema and result translations | Canonical schema/result helpers and exactly one transport retry classifier; T0/T2/T8 |
| R13 P1 | Raw artifacts can contain private values and attacker-controlled HTML | Scoped reads, safe viewer, default summary/reference policy and retention tests; T2/T7 |
| R14 P1 | Main protection does not constrain release tags or prove release ancestry | Re-read settings; protected-main ancestry and artifact provenance gates; T9 |
| R15 P2 | Full PR suites and packaging can duplicate work; unsafe filtering can skip requirements | T3 measures an explicit focused loop and fails to the full gate when impact is uncertain; required checks keep reporting. Any automatic CI selector or gate change needs separate T9 evidence |
| R16 P2 | Hidden navigation/decision UI excludes users with unavailable arrow keys | Inline accessible decision component, mouse/Tab/Enter/plain text tests; T1/T8 |

Source anchors: [MCP definitions](../../packages/mcp-server/src/mcp-server.ts),
[wire action owner](../../packages/protocol/src/wire-action.ts),
[control state](../../packages/core/src/session-control.ts),
[authority](../../packages/control/src/session-authority.ts),
[application port](../../packages/control/src/application-authority.ts),
[bulk autofill qualification](../bulk-autofill.md). Victor paths are external repo
references: `victor/integrations/mcp/client.py` and `victor/tools/mcp_adapter_tool.py`.
Older coexistence reviews contain historical findings; do not assume every old finding
is still open or that a different installed binary matches the inspected checkout.

## System review

Ownership is coherent when one service admits operations across browser/application
paths and connections remain disposable. Restart fences grants and attachments;
business receipts remain application-owned. Single-owner optional persistence is
appropriate for the current scope. Active-active service ownership, broker coordination
and parallel same-session writes add unresolved fencing problems without demonstrated
demand. Reject those additions until their independent invariants and benefits exist.

Connection loss, service crash, page crash and application rejection are distinct
failures. The design keeps them distinct and does not promise transactional browser
rollback. Events are resynchronizable notifications, while receipts establish outcomes.
Resource quotas must be enforced before allocation and at external I/O boundaries.

## Software review

Existing package seams are sufficient for the first increments. Shared helper extraction
must follow semantic ownership, not arbitrary file length or repeated syntax. A generic
`utils` package, mode-specific service classes and a new workflow DSL would proliferate
code. Plan and autofill share primitives but retain different resolution contracts.
One schema owner and one control machine prevent drift; independently testing runtime
exports prevents a generated catalog from merely checking its own assumptions.

Protocol adapters need versioned compatibility, bounded correlations and lossless
nested schema/result projection. Context loading is an allowlisted dependency-closure
operation, not semantic search over all memory. A mode switch removes stale context
and reauthorizes; it cannot retract data already present in an LLM transcript.

## Application review

QA must preserve the tested seam and use independent expected outcomes. Business
operations require versioned mappings, partial-effect reporting and explicit recovery.
Appsec requires distinct test identities and enforced request scope; browser login
success is not comprehensive security testing. Forms need committed widget state,
not text resemblance. Browser-free application operations are valuable but cannot
be counted as UI coverage. Shared business predicates enable parity without sharing
the code path that could hide the bug.

## Failure walkthroughs

| Scenario | Required result |
| --- | --- |
| Human takes over during autofill | Stop undispatched suffix, drain active action, withhold revoked output, show partial/unknown effects |
| Save commits but MCP response is lost | Query operation/application receipt; no automatic repeated click |
| Service crashes after dispatch marker | New generation; old grant invalid; result unknown until independent reconciliation |
| Readback matches a redacted prefix only | Compare private full value; verification fails when suffix differs |
| API fix passes while UI stays broken | API test passes, UI test fails; no merged single success |
| Agent switches from forms to security | New profile is intersected with existing authority; no automatic active-testing permission |
| Artifact store or journal fills | Reject new dependent work before dispatch; retain duplicate-protection semantics |
| Unsupported custom widget looks like a text input | Refuse or classify through a qualified strategy; no optimistic native fill |

## Residual questions and release gates

Journal retention/key rotation, hard engine-call termination, hosted egress coverage,
custom widget versions and exact installed harness compatibility require implementation
evidence. They are explicitly not resolved by this document. Each task must record
its chosen bounds and rollback/migration behavior before coding. Release only the
capabilities whose falsifying tests and packaged acceptance pass; retain unsupported
states for the rest. No measured footprint reduction or security certification is
claimed by this specification delivery.

## Specification validation performed

The repository documentation-link checker passed: 366 relative links across 108
Markdown files. Read-only validation of the manifest checked all 30 module paths,
module/task dependency cycles, seven mode profiles, ten task packets and 82 allowed
mode/view/task selections. Each selection retained core, excluded unrelated modes
and stayed inside its proposed bundle ceiling with 1 KiB per module reserved for
future framing. Bounty's appsec inheritance was the explicit allowed exception.

Default agent-view documents measured 6,402–8,104 UTF-8 bytes before framing. These
are selected source-document measurements, not executed loader results, tokenizer
measurements or runtime memory benchmarks. Whitespace checks passed. No runtime code,
context loader, new tests, CI workflow or implementation task was executed/added as
part of this specification-only delivery.
