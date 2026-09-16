# T0 transport contract audit

Scope: foundation candidate based on develop `2144455`. This is a source/fixture audit,
not certification of every installed client. The protocol package owns canonical
schemas; adapters must not substitute internal engine/state records for wire results.
This optional evidence is outside default task-context loading.

| Surface | Reused owner / current result | Decision |
| --- | --- | --- |
| autofill | Protocol AutofillRequestSchema / AutofillReportSchema; SDK autofill | Qualified canonical input and validated structured/text output; CLI schema discovery |
| plan | Protocol PlanStepSchema → PlanActionsSchema / PlanReportSchema; service executePlan | Qualified nested input and output; shared REST/CLI/MCP step validator; retain partial results, remap and per-step evidence |
| act | Protocol WireActionEnvelopeSchema and decodeWireAction; SDK ActionResult | Input already shares canonical wire validation. Do not project internal ActionResultSchema: it requires timestamps/revisions and a result envelope absent from the transport's status-oriented response |
| create | Protocol SessionRequestSchema; service session-create; SDK SessionResponse | MCP adds a first page and returns pageId. Internal SessionResponseSchema and OpenAPI SessionSummary describe different shapes. Reconcile transport envelopes before advertising output |
| navigate | SDK NavigationRequest/NavigationResponse and service navigate | NavigationStatusSchema is an internal fragment, not the full status/url/redirect response. Requires a wire output owner |
| observe | Protocol ObservationRequestSchema, PageStateSchema; SDK ObservationResponse | Shared conceptual fields are not identical DTOs: preserve delivered degradation/continuation/overlay fields and request enrichments before deriving one schema |
| snapshot | SDK PageSnapshot; service getSnapshot | Compact fields/mode/revision payload differs from PageStateSchema. Requires its own canonical transport schema, not a renamed internal observation |
| extract | SDK ExtractRequest/ExtractResult; deterministic extraction owners | Variant data depends on format and includes evidence. Qualify per-format contracts; do not advertise an unconstrained object as complete schema coverage |
| screenshot / pdf | Protocol ArtifactRefSchema; SDK artifact methods | Candidate for direct reuse, but first qualify delivered artifact variants/optional inline bytes on each engine. Keep existing text results until acceptance covers those variants |
| html | MCP bounded decoded HTML envelope; underlying SDK artifact export | Tool returns html/truncated/untrustedContent/warning, not ArtifactRef. A distinct transport envelope and byte-limit qualification are required |
| cookies | SDK ExportedCookie[] | Existing top-level array must remain text until an explicit object wrapper migration is qualified; MCP structuredContent is an object |
| close | Adapter-generated sessionId/closed acknowledgement | Small wire envelope, but not SessionResponseSchema. Preserve acknowledgement semantics; no implicit persistent-session guarantee |
| delegated session | Adapter joins ControlView with listPages | Composite response needs canonical page-list/control envelope, with current authorization preserved |
| delegated operation | Protocol OperationRecordSchema; SDK operation | Reuse candidate; qualify every operation status and error path through installed harnesses before expanding advertised structured output |

## Plan compatibility decisions

- Input steps keep the existing delivered flat vocabulary, waitMs/count/ref bounds,
  empty arrays, additive fields and server-side action-specific checks. No new array
  limit or nested plan language is introduced in this increment. CLI's existing 1 MiB
  JSON boundary still applies. Declared field validation does not prove target validity.
- PlanReport v1 requires ok/completed/results. mode and newRevision stay optional to
  preserve the pre-existing SDK contract; the current service always returns both.
  OpenAPI references the same compatible report schema. Additional result properties
  remain allowed, as in the existing OpenAPI contract; output validation is not redaction.
- The service result type retains required mode/newRevision internally. SDK, CLI and
  MCP reuse the common report type instead of maintaining four handwritten shapes.
- One protocol helper handles invalid execution-report uncertainty for plan/autofill.
  Shape validation neither proves business success nor validates evidence semantics;
  those belong to T2 verification contracts. No retry policy or executor was changed.
- The static OpenAPI artifact and generated MCP catalog must be regenerated after
  canonical changes. Their regressions check nested constraints and report references.

## Follow-up ownership

T2 should consolidate the remaining wire envelopes with compatibility fixtures before
expanding structured results. It must also qualify aggregate input/output limits (the
existing plan array has no independent count ceiling), bounded decoded HTML, and
verification versus execution semantics. T8 must exercise nested schemas and both text
and structured reports through installed Victor, Codex and Claude clients. T0 covers
accurate, qualified discovery; it must not imply universal schema or harness coverage.


## Fourth increment validation and delivery record

Three new MCP regressions failed before implementation: missing nested plan constraints,
invalid steps reaching the client, and malformed reports presented as success. Ten
protocol cases, two CLI cases and an OpenAPI reference/remap check were added. Existing
real Chromium plan success/timeout fixtures now validate their actual report shapes.

Local validation so far: protocol 140, MCP 71, CLI 97, API OpenAPI/service/REST/steps and
real plan fixtures 295 passing. Workspace build/type-check and lint passed (pre-existing
lint warnings remain). Static openapi.json and generated MCP documentation were refreshed.
The shared executable acceptance passed with both Node and Bun for autofill and plan;
partial evidence and text/structured equality survive both protocol and binding modes.

The full workspace test run passed before the final CLI-only report-boundary correction;
the affected CLI suite then passed all 97 tests and rebuilt successfully. The correction
validates the upstream autofill report before interpreting `ok` or emitting output, so a
malformed response cannot be presented as success or leak unvalidated fields. The final
adversarial recheck could not run because that reviewer exhausted its usage allowance;
the repository's mandatory commit and push gates remain the delivery authority.

| Catalog | Legacy bytes | Modern bytes |
| --- | ---: | ---: |
| Unbound | 22,189 | 24,964 |
| Delegated | 19,580 | 22,355 |

Modern output fields add 2,775 bytes. Exposing complete nested plan inputs also increases
legacy discovery size compared with the earlier opaque object schema; accurate constraints
are necessary grounding, not optional prose. These are bytes, not model-token/RSS claims.
The profile-selection optimization is T1 and must be measured separately.

The candidate was refreshed against develop `2144455`; develop contains the feature
ancestry delivered after the 1.8.16 package stamp. Comparison with the v1.8.18 release
found no missing release-changed file: 23 are byte-identical, 20 differ only by release
metadata, and the 15 intentional overlaps preserve the released autofill, CLI parity,
session-lifetime and smoke-test behavior while adding this foundation slice.

PR #179 passed all eight CI jobs and merged to develop as `e1835682`; the post-merge
develop run also passed all eight jobs without reruns. Main and release were not promoted.
