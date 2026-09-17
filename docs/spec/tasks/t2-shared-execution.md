# T2: shared execution, verification and result helpers

Status: active. Repository: agentbrowser. Depends on: T0.
Inputs: core, architecture, contracts, execution, grounding.

## Reuse and scope

Start in SessionControl, SessionAuthority, ApplicationAuthority, existing action
executor, autofill orchestrator, budget and artifact helpers. Preserve their existing
ownership and wire outcomes. Add one shared result/verifier contract and extract only
demonstrably duplicated sequencing. Do not merge plan/autofill identity semantics.

## Slices

1. Separate execution, verification and cleanup outcomes through compatible projections.
2. Reuse bounded evidence, canonical serialization and operation admission across run
   consumers. Specify any missing shared helper's owner and exact responsibility.
3. Add trusted verifier registration and independent outcome references. Ensure reads,
   final rechecks and uncertainty all obey the same authority/deadline boundaries.

## TDD and acceptance

Test takeover at every boundary, same-ID/different-input conflict, late completion,
changed document/binding, truncated candidates, redaction collision, cross-field resets,
after-commit disconnect and terminal evidence failure. Unknown writes stop the suffix;
read retries never dispatch another write. Pending calls drain before ownership release.

An application rejection and a UI command acknowledgment produce distinct results.
Existing API/SDK/CLI/MCP actions and native autofill remain compatible. No duplicate
state machine, ad hoc retry loop, private-value cache or artifact store is introduced.
Run existing control/authority/autofill suites plus one actual service/stdio fixture.

## Completion / stop

Close R02 execution aspects, R04 foundation and R12 shared helper ownership. Record
unsupported evidence levels rather than inventing commits. Unlock T3/T4/T5/T6.

## Current implementation state

The first slice reuses the existing `ActionExecutor.beforeAction` admission seam to
report when autofill has crossed from validation and approval into engine dispatch.
Autofill now reports a refusal before that seam as `failed` and an exception after it
as `uncertain`; bounded verification reads still cannot replay the write. The public
service method and HTTP, OpenAPI, SDK, CLI and MCP contracts are unchanged, and no
dependency or second execution state machine was added.

The focused unit/service tests and the complete API suite cover approval refusal,
post-dispatch engine rejection and exactly one dispatch across verification retries.
See the [dispatch-boundary evidence](../evidence/t2-dispatch-boundary.md). Compatible

The second slice replaces the autofill-only HTTP failure marker with one typed
execution-envelope classifier. Autofill, plan and single/batched action routes now
project their existing top-level result into the same `SessionAuthority` completion
logic. An in-band failure before dispatch is `failed`; after dispatch it is
`outcome_unknown`; success remains `completed`. See the
[HTTP result-classification evidence](../evidence/t2-http-result-classification.md).

The third slice preserves the session component of application write identity through
the trusted adapter boundary. `ApplicationScope` now carries the authority-owned
session ID and a per-registration incarnation, so adapters can key application
idempotency and receipts by tenant, resource, session incarnation and raw operation
ID. The incarnation survives bind/unbind and changes when a textual session ID is
reused. Binding generation remains service admission provenance and is deliberately
excluded from durable receipt lookup, allowing an authorized same-registration,
same-resource rebind to reconcile prior application evidence. See the
[application identity evidence](../evidence/t2-application-identity.md).

The fourth slice makes aggregate success a conservative projection of nested results
at the shared protocol-parser boundary. A successful plan has a contiguous, error-free
list of successful steps whose count matches both `completed` and the original request.
A successful autofill report contains one contiguous, error-free `verified/true` or
intentionally `unverified/false` receipt for every requested field. The SDK supplies
request cardinality to the canonical parsers; CLI and MCP retain the same check around
injected clients. All three reject contradictory HTTP 200 reports with uncertain write
guidance, no private report echo and no retry. Pessimistic `ok: false` reports and
`verify: none` remain compatible. See the
[semantic result evidence](../evidence/t2-semantic-result-validation.md).

The fifth slice binds an explicitly verified native fill in a plan to its existing G5
readback evidence. A request-relative parser snapshots only which steps require
verification, retains no field values, and accepts only the exact value-free projection
`{ verified: true }` for those successful steps. SDK, CLI and MCP reuse that parser;
the stale-target remap path now preserves the same sanitized result as ordinary plan
execution. This establishes native browser readback, not an application commit or G6
oracle. See the
[plan verification evidence](../evidence/t2-plan-verification-evidence.md).

Compatible verifier projections, trusted verifier registration and the remaining T2
acceptance matrix are still pending, so T2 is not complete.
