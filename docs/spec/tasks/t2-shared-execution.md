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

The sixth slice adds one strict reference-only outcome projection with separate
availability, execution, verification, cleanup and tested-seam axes. A pass is derived
only from completed execution, sufficient registered verification and settled cleanup.
An immutable trusted registry evaluates pure bounded predicates once and never acquires
evidence, retries writes or runs cleanup. See the
[outcome/verifier evidence](../evidence/t2-outcome-verifier-foundation.md).

The seventh slice composes the existing plan executor with exact trusted evidence-source
preflight, bounded read-only polling, verifier evaluation and all-settled cleanup. One
request/report contract is exposed through REST, SDK and the first-class CLI; MCP is
unchanged and optional. The response keeps execution, verification and cleanup axes
separate, and CLI exit status derives a pass from all axes. See the
[outcome-run evidence](../evidence/t2-outcome-run-vertical.md).

No production evidence source is qualified yet, and the remaining takeover, late
completion, application receipt and installed-surface acceptance matrix is pending.
T2 is therefore not complete and T3 is not yet unlocked.

Terminal authority qualification extends the seventh slice: after asynchronous cleanup,
the shared runner rechecks authority and cancellation before releasing its projection.
Revocation withholds plan data and evidence references, preserves cleanup status and
reports dispatched execution conservatively as unknown. Service and delegated REST
fixtures cover page closure and human takeover during cleanup without redispatch.

Verifier input preflight further qualifies the same slice: the shared registry snapshots
and parses expected input before dispatch and captures an evidence-only evaluator.
Invalid input is blocked without executing; legacy definitions lacking preparation are
unsupported for outcome runs. Direct registry evaluation remains compatible. The runner
rechecks authority and cancellation after preparation, settles cleanup on refusal, and
delegated HTTP replay records the refusal as failed with no dispatch. Production
evidence-source qualification is still pending.

The application receipt foundation now offers one read helper inside an existing
admission, reused by standalone receipt lookup. It derives scope from existing session
authority, preserves the separate business receipt ID and rechecks owner, binding,
adapter authorization and cancellation after asynchronous I/O. It adds no nested ticket,
write dispatch, ledger or retry loop. See the
[application receipt evidence](../evidence/t2-application-identity.md#admitted-receipt-read-follow-up).

Outcome requests now carry an optional bounded business receipt correlation ID, separate
from the outer service operation ID. Opted-in sources require it; other sources reject
it before dispatch. One prepared reader captures the ID for every bounded poll. The
protocol owns the shared operation-ID schema; REST, SDK, CLI and offline discovery reuse
it. Operator-authorized REST fixtures verify scoped application receipt reads, missing/cross-session
negative controls, replay suppression and changed-correlation conflicts. These fixtures
qualify correlation only, not causal UI-to-application commits or a production source.
Delegated browser-mode application receipt verification requires an explicit permission
policy checked before dispatch; generic correlation opt-in does not grant that authority.

## Next slice: receipt permission and causal qualification

1. Define explicit permission to expose an application-derived predicate to a delegated
   browser mode. Reuse trusted source registration and existing admission preflight;
   keep raw application discovery/execution permissions separate. Deny unconfigured
   receipt sources before dispatch, including when a caller supplies a valid business ID.
2. Qualify one application-owned fixture whose UI write and receipt share an explicit
   correlation contract. A pre-existing receipt, wrong session/resource, failed UI write
   or blocked commit must not establish that this run caused a commit. Do not relabel
   the current pre-seeded correlation fixture as production or G6 evidence.
3. Exercise revoked permission, takeover and late receipt completion through the real
   outcome route, retaining one admitted operation, one executor and bounded reads.
   Demonstrate CLI-to-service acceptance using the same protocol, without MCP.
4. Record the source's exact qualified layers and limits. Reuse the existing evidence
   registry, application authority and result parser; add no receipt store, generalized
   workflow engine or new package to obtain this qualification.
