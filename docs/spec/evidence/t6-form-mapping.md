# T6 mapping preparation and guarded stage evidence

Base: develop `8d92da894c9680c3199e541b33d4b74949fe30b9` after #237.
Scope: [bounded mapping design](../design/t6-form-mapping.md). This candidate adds
local preparation and server grounding for one fully present form stage, not an
ATS/job product, submission, recovery or installed-harness/release qualification.
Version 1.9.1 remains immutable; integration follows the develop PR gate.

## Reuse and delivered behavior

Protocol owns the mapping schema/private join, reusing AutofillMatch, strategy schema,
request parsing and bounded descriptor-safe `snapshotJsonData`. The CLI command
`form prepare` reuses bounded JSON input and schema discovery; it emits compact private
JSON for the existing autofill command without creating a client or reading credentials.
The SDK re-exports the same helper. No new endpoint, package, dependency or runner exists.

An optional exact-URL scope enables preflight of all fields inside `runAutofill` using
its resolver/strategy registry before private-reference resolution or dispatch. Every
observation checks complete evidence, URL, distinct pinned node/block identities and
readiness. Scoped requests require explicit strategies and exact verification and
cannot skip failures. Native/custom writes share one dispatch helper; each invalidates
scope for raw artifact capture until another complete observation succeeds. Optional
MCP forwards the same property its protocol-derived schema advertises.

## Local falsifying evidence

Node 24.21.0, synthetic data, isolated Chromium/local fixture servers.

| Check | Evidence |
| --- | --- |
| Initial mapping contract | New test module failed collection because the mapping owner did not yet exist; this was not a behavioral test pass |
| Initial server scope probes | 15 failed / 46 passed before guarded-stage support |
| Initial CLI command/discovery probes | 3 failed / 4 passed before the offline adapter |
| Descriptor safety/explicit-strategy/total private-size probes | 3 failed / 26 passed before the guards |
| Repeated-value output expansion | 1 failed / 30 passed before the materialized UTF-8 byte bound |
| Dispatch failure followed by artifact export | 1 failed before scope was invalidated at the shared write boundary |
| Prepared-output reader boundary | 1 failed / 18 passed with pretty output; compact output and newline-inclusive bound repair passed |
| Preflight receipt attribution | 5 failed / 60 passed before attributing a later-field refusal to its own receipt |
| Final focused protocol/server/CLI | Protocol mapping 33 and existing autofill 29; server autofill 65; CLI preparation 19 |
| Actual Chromium | CLI and stdio both passed with offline CLI preparation, wrong-URL and missing-later-field denials, the five-field positive and existing widget negatives |

The actual fixture observes native input events and custom selections independently
at its HTTP server. The denials occur before any native/custom effect; expected positive
counts and zero submissions remain pinned. One test attempt could not bind loopback
inside the sandbox (`listen EPERM`); the authorized retry ran outside it. A subsequent
stdio negative exposed a stale compiled MCP adapter; rebuilding the correct package
restored scope forwarding and both actual surfaces passed. No claim is made that these
are installed Bun binary or live-site tests.

The mandatory hooks run full local type/lint/build/test gates. Required PR and post-merge
CI identities and the exact reviewed commit belong to the PR record; this evidence does
not preclaim integration. Independent adversarial review required safe JSON snapshots,
explicit strategies, no-fieldset identity support and scope invalidation after uncertain
dispatch. Regression tests retain each repair.

## Limits and continuation

All mapped fields must be ready initially and on every observation, even after earlier
fields commit; conditional/disabled-after-commit shapes need separate stage qualification.
Exact URL includes query/fragment and requires review before changing URLs. URLs/labels
must contain no private data or access tokens; schemas cannot establish that semantically.
Mapping provenance is not an application identity, signature or permission grant.

Bounds cover descriptor traversal, private strings and prepared output, not arbitrary
JavaScript proxy execution or hard browser-time isolation. Observation and dispatch are
not atomic against page scripts. After uncertainty, reconcile operation status; never
replay the preparation/execution pipeline as recovery. Raw HTML remains private.

Next qualify a concrete private job workflow through existing CLI/REST/SDK seams,
retaining candidate criteria, independent outcome evidence and exact-payload submission
approval. T6 remains active; T5/T8 retain their own recovery/harness gates.

Preflight field failures are attributed to that field's receipt; all other fields remain
`not_attempted`. Global URL/completeness failures use receipt 0 as the existing stage
error carrier; no field write is implied. After dispatch, failure remains attributed
to the active affected field and retains uncertainty.
