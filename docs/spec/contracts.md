# Shared data contracts and schema ownership

Status: conceptual vNext data model, not a new shipped wire API. Existing protocol
types remain canonical until an explicitly versioned migration lands. Type sketches
below express required fields and invariants; implementation must derive validators,
SDK types, OpenAPI and tool schemas from one source instead of copying these sketches.

## Contract families

| Contract | Minimum fields | Owner and lifetime |
| --- | --- | --- |
| Execution context | Verified tenant/principal, service generation, session, control epoch, deadline and cancellation | Host-created; never trust caller-supplied actor labels |
| Resource binding | Adapter ID, resource/account ID, binding generation, allowed operations | Shared authority, scoped to session control identity |
| Target reference | Attachment/page/document generation, observation revision, node/block evidence | Engine/session-private until expiry |
| Operation identity | Session-scoped ID, canonical argument fingerprint, operation kind/schema, binding, principal scope | Existing control records; optional future journal |
| Capability snapshot | Profile/schema revision, adapter/browser/protocol versions, supported operations, policy limitations and bounds | Service generation plus relevant configuration versions |
| Evidence reference | Opaque ID, kind, size, digest, sensitivity, capture boundary, expiry, completeness | Shared authorized artifact/evidence store |
| Verification | Predicate/version, expected reference, actual evidence references, result, achieved grounding layer | Run result; private values stay out of general receipts |
| Run definition | Mode, objective, tested seam, ordered steps, assertions, fixtures, budgets, cleanup policy | Versioned trusted mapping/test source |
| Run record | ID, definition hash, capabilities, admitted operation IDs, outcomes, evidence and cleanup status | Service-owned; durability explicitly advertised |

Do not put authentication secrets, raw DOM, model transcripts or full form profiles
in the shared operation envelope. Large data is referenced, separately bounded and
authorized. Operation IDs are identifiers, not bearer capabilities.

## Outcome axes

Keep these dimensions separate to avoid a proliferation of overloaded status enums:

```ts
// Design vocabulary. Map to existing wire types at the adapter boundary.
type ExecutionStatus = 'not_started' | 'running' | 'completed' | 'failed' | 'unknown';
type VerificationStatus = 'passed' | 'failed' | 'unknown' | 'not_requested';
type Availability = 'available' | 'blocked' | 'unsupported';
type CleanupStatus = 'not_needed' | 'pending' | 'complete' | 'failed' | 'unknown';
type TestedSeam = 'ui' | 'application' | 'agent_tool';
```

Existing control statuses (`in_flight`, `completed`, `failed`, `outcome_unknown`) and
autofill field statuses remain intact in their delivered APIs. Translate explicitly;
do not silently rename them. A report may have a completed executor and failed
verification. A successful batch with `verify: none` is not a verified test pass.
Skipped required assertions cannot satisfy the run. Cleanup failure is independently
visible even if the desired business outcome passed.

## Mode descriptor

One registry entry describes a profile, not executable code from the model:

```ts
interface ModeDescriptor {
  id: string;
  revision: string;
  instructionModuleIds: readonly string[];
  requiredCapabilityIds: readonly string[];
  optionalCapabilityIds: readonly string[];
  schemaIds: readonly string[];
  strategyIds: readonly string[];
  verifierIds: readonly string[];
  reportAdapterIds: readonly string[];
  policyProfileId: string;
  memoryProfileId: string;
}
```

The registry and referenced implementations are trusted server configuration.
Effective permissions are the intersection of deployment policy, authenticated
principal, session grant, resource binding, mode profile and qualified capabilities.
Selecting a more capable profile cannot enlarge a grant. Report unsupported required
capabilities before mutation. Optional capabilities are absent until requested and
qualified. Runtime descriptors and this documentation manifest serve different
purposes; the Markdown manifest cannot register a runtime tool or grant permission.

## Runs, mappings and assertions

A TestRun is a small orchestration record around existing operations, not a new
programming language. Initially support ordered steps, bounded read polling and
registered predicates. Use existing Playwright test integration/export where it
satisfies deterministic QA instead of inventing loops, expressions and script eval.

Separate reusable mapping (site/form version, blocks, matches, verifier IDs) from
private values (vault references and per-run materialization). A mapping stores no
credentials. Resolve all required private values and validate total size before
dispatch, but retain them only for the bounded operation lifetime. Account/resource
changes invalidate the mapping binding and any prior review.

Assertions declare required evidence layer and seam. Fixture setup/cleanup use
trusted registered adapters under their own scoped authority; the test cannot turn
a setup credential into the identity under test. Baseline updates are explicit
reviewable data changes, not a fallback when assertions fail.

## Serialization, privacy and compatibility

Reuse `canonical-json.ts` for bounded application input traversal; reuse protocol
validators and wire-action translation. No parallel JSON canonicalizer in MCP, QA
or a durable store. Specify canonicalization version and bind fingerprints to the
operation schema and scoped binding. For retained fingerprints of low-entropy secret
values, use a keyed digest with a documented key lifetime; an unkeyed hash alone is
not secret protection. This is a proposed durable-store refinement, not current behavior.

Validate at public trust boundaries and before external dispatch. Internal typed
calls should not repeatedly serialize the same validated value. Cache compiled
validators by schema/version in a bounded registry; reject unknown versions and
remove unused mode validators only when no active run references them.

Additive optional fields require compatibility tests with installed clients. Breaking
semantics need a versioned contract, migration and deprecation window. Generated
catalogs and result schemas must share the same revision/hash; fixture coverage must
detect loss of nested arrays, unions, enums and structured results through harnesses.
