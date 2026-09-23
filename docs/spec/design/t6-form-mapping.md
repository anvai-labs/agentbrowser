# T6: bounded form mapping and private-value preparation

Status: implementation slice after owned-popup/readiness #237. One exact URL and
one fully present form stage; not arbitrary ATS support or application submission.

## Owners and contract

`protocol` owns `FormMappingSchema`, `FormValuesSchema` and the pure
`materializeAutofillMapping` join. A mapping has schemaVersion 1, public id/revision,
exact page scope `{url}`, and at most 50 fields. Each field reuses `AutofillMatch`,
an explicit existing widget strategy, input kind (`value` or `option`) and valueKey.
It stores no field values, saved refs, script, credentials or private profile. Shared
labels/URLs still need review before publishing; structural validation is not a PII detector.

The values input is a bounded own-key record of strings, with exactly the keys used by
the mapping. Repeated value keys are allowed. Missing/extra keys, wrong value types,
unknown versions/properties and mismatched strategy/input are refused with static
errors. There is no template evaluation, dotted-path lookup or prototype lookup.
The shared descriptor-safe snapshot helper copies both inputs without invoking getters;
invalid reflection is sanitized, but arbitrary JavaScript proxies are not sandboxed.
Mapping data is bounded to 128 KiB/2,000 nodes/depth 8, values to 512 KiB/51 nodes/depth 2,
and compact output plus newline to 1 MiB. Materialization returns the existing
`AutofillRequest` with
exact verification and fail-on-ambiguity/verification policy. id/revision describe
mapping provenance locally; they grant no authority and are not a server registry.

An optional additive `AutofillRequest.scope` enables guarded execution. Its URL must
be canonical HTTP(S), without credentials; comparison includes query and fragment.
Different URLs require an explicitly reviewed mapping change. This conservative first
version avoids broad URL patterns; URL equality is not business/account identity.
Scoped requests cannot weaken exact verification or skip failures. Unscoped requests
retain existing semantics, including bounded delayed-field resolution.

## Server grounding and execution

Extend only `runAutofill`, reusing its scoped resolver, strategy registry, identity
maps, policy/deadline, receipts and dispatch path. Before resolving vault references
or writing, obtain one complete non-degraded observation and validate scope plus ALL
mapped fields: unique match, node/block evidence, visible/enabled qualified strategy,
and distinct target nodes. Pin those identities. Missing/ambiguous/unsupported fields
reject the stage before any writes; initially hidden/dependent fields need a later stage.

Every subsequent observation rechecks exact URL and all pinned node/block identities,
selectors and strategy readiness. A changed field stops further writes; already
performed effects remain visible as partial/uncertain receipts and are never rolled
back or replayed. Existing engine ref/form-evidence checks remain the dispatch guard.
Every dispatch clears scope validation; only a subsequent complete observation can
restore it. No snapshot is exported after failed or invalidated scope validation. Observation and action are not
atomic against page scripts, and URL equality cannot detect every same-URL navigation;
engine document/ref identity supplies the existing additional boundary.

## CLI and privacy

`form prepare <mappingJson> <valuesJson>` is an offline adapter over the protocol join.
Use the existing bounded JSON reader for inline JSON, @file or a single stdin input.
It emits a private prepared request, suitable for existing `autofill` stdin. Help and
`describe --schema` expose both inputs and the output contract. No endpoint, executor,
transport, package or dependency is added. REST/SDK and optional MCP consume the same
materialized scope; MCP must forward the property it advertises.

Prefer a public mapping file and private values on stdin/private files; prepared output
contains values and must not enter logs, public artifacts or source control. Preparation
is not permission to execute. Resume/job ranking, PDF provenance, submission approval,
operation recovery and installed-binary qualification retain their separate gates.

## Falsifying tests and acceptance

- Strict/bounded schemas: version, origin credentials, canonical URL, unsafe keys,
  duplicate/missing/extra keys, input/strategy mismatch, deep copy and sanitized errors.
- Zero writes and zero vault resolution on wrong URL, incomplete evidence, absent or
  ambiguous later field, hidden/unsupported control and two mappings targeting one node.
- Positive repeated labels in distinct fieldsets; node reorder is safe; later replacement,
  block movement, selector/URL drift and cross-field invalidation stop without replay.
- CLI offline preparation from file/stdin, dual-stdin rejection, honest discovery schema;
  actual Chromium CLI and stdio execution preserve scope and independent fixture outcomes.
- Existing unscoped autofill behavior and mandatory contract/local/CI gates stay green.

Next: qualify one concrete private job workflow and named ATS shapes. Mapping preparation
alone does not complete T6. Keep v1.9.1 immutable and integrate through develop PR review.

Preflight field failures are attributed to that field's receipt; all other fields remain
`not_attempted`. Global URL/completeness failures use receipt 0 as the existing stage
error carrier; no field write is implied. After dispatch, failure remains attributed
to the active affected field and retains uncertainty.
