# T0: canonical contracts and accurate discovery

Status: active. Repository: agentbrowser. Depends on: none.
Inputs: core, contracts, interfaces, delivery. Follow the common task protocol.

## Reuse and scope

Inspect `packages/protocol/src`, MCP tool definitions, SDK translations, OpenAPI
emission, root/package README and release smoke/catalog checks. Reuse existing schema
validators and wire translation. Add no second tool registry or schema framework.

## Slices

1. Correct tool selection/retry/security/version guidance and expose actual unbound
   versus delegated catalog behavior. Generate catalog documentation where practical.
2. Define versioned output contracts and project them to MCP structured results while
   preserving legacy text clients. Keep actual-runtime acceptance independent of generation.
3. Describe package/service separation and delegated configuration; prepare registry
   metadata if publication is selected. Do not change protocol version without qualification.
4. Keep CLI a first-class shell/LLM surface: offline command descriptions, canonical
   request-schema discovery and bounded JSON-file/stdin input. Reuse protocol validators
   and SDK calls; avoid private payloads in shell arguments or new per-command parsers.
   Add bulk CLI operations only through that common input boundary and existing executors.

## TDD and acceptance

Detect a missing runtime tool, outdated generated catalog, lost nested field schema,
incorrect read-only hint and a successful HTTP response containing failed verification.
Prove write-timeout documentation and SDK policy do not imply blind retries. Validate
links, generated contract consistency, actual stdio catalog and packaged result format.
All existing action/autofill contracts remain compatible. Counts are derived release
facts; no identical hardcoded list spreads across multiple new files.

## Completion / stop

Close R01/R02 discovery aspects and R12 schema ownership; document R03 limits honestly.
Record old/new schema bytes and qualified clients. Stop a breaking change without a
migration path; finish independently compatible documentation work. Unlock T1/T2/T8/T9.

## Current implementation state

Local candidate on `feat/foundation-discovery`, rebased onto develop `2144455` (#177).
#178 released the upstream CLI parity batch as 1.8.18; develop still stamps 1.8.16.
Foundation delivery is in progress; see the latest evidence record for identifiers. The original local work is
preserved in stash `bb41ee8c07c0cbcc67e7b8dcec4f6e4cb1ab9399`.

Implemented locally:

- Shared protocol interaction/reconciliation guidance and offline shallow CLI discovery.
- One bounded JSON input reader for existing autofill/policy and plan commands, canonical
  autofill/plan types and schemas, shared plan validation across REST/CLI/MCP, and
  nonzero exit with retained JSON for failed bulk reports.
- Generated MCP catalog documentation checked in the existing release-artifact gate.
- Versioned canonical autofill output validation and negotiated MCP 2025-06-18 structured
  and plan results alongside equivalent text; explicit 2024-11-05 clients retain legacy catalogs.
  Failed autofill/plan reports set isError while preserving receipts. No retry added.

Latest contract slice: protocol 140, MCP 71, CLI 97, and 295 API regression tests passed,
including OpenAPI consistency and real Chromium plan success/timeout. Workspace build,
type-check and lint passed (existing lint warnings remain); actual Node/Bun stdio checks
cover both bulk tools in both protocol/binding modes. Full delivery gates are in progress.
No GitHub CI run has yet been triggered for this candidate.

The [wire-contract audit](../evidence/t0-contract-audit.md) records each remaining surface
and why internal schemas must not be advertised as incompatible public wire contracts.
Those migrations belong to T2; installed harness qualification remains T8. Modern output
fields add 2,775 serialized catalog bytes; complete nested plan inputs add context to
both catalogs. T1 must measure selection savings rather than claim shrinking all schemas.

## Next increments

1. Preserve the completed contract audit when reviewing this candidate. Autofill and
   plan are qualified here; migrate remaining wire envelopes under T2 with fixtures
   rather than extending T0 with unqualified output schemas.
2. Deliver the scoped foundation changes via the common task protocol, reconciling
   develop again before push. Preserve the backup. The adversarial review's one finding
   (validate autofill reports before CLI success/output) has a red-then-green regression;
   its final recheck was unavailable because the reviewer exhausted its usage allowance.
3. Only then close T0 acceptance and unlock dependent increments. Installed Victor,
   Codex and Claude structured-result qualification remains T8; no runtime mode loader
   exists yet (T1). Registry metadata is conditional on selecting publication.

Detailed evidence, compatibility decisions, measurements and earlier validation are in
[the optional evidence record](../evidence/t0-foundation.md). Do not load that record
by default or recursively include documentation links in task-context bundles.
