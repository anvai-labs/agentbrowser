# T5: shared dispatch and optional operation journal

Status: J0 and J1-A HTTP/replay publication implemented; B1/B2 contract merged #285.
Baseline: develop `5ebf820` (PR #285). J1-C integration and J2–J4 remain proposed. This design does not advertise durable recovery.
Task: [T5](../tasks/t5-durable-recovery.md). Shared contracts remain in
[execution](../execution.md) and [state/memory](../state-memory.md).

## Ownership and dependency direction

| Concern | Existing owner | Extension |
| --- | --- | --- |
| Ticket, epoch, duplicate fingerprint and bounded operation status | `core/SessionControl` | Retain one state machine; never evict accepted identities |
| Principal, registration incarnation, scope, dispatch and drain | `control/SessionAuthority` | One dispatch callback boundary; later compose journal acknowledgments here |
| Application identity, permission, preparation and consent | `control/ApplicationAuthority` | Invoke the shared dispatch boundary after current application guards |
| Browser effects | Guarded `EnginePage`; API page creation | Invoke that same boundary; no journal in an engine or widget strategy |
| Canonical input and evidence | Existing canonical-input and evidence owners | Persist keyed fingerprints and scoped locators, not duplicate result bodies |
| REST, SDK, CLI, MCP | Existing transport projections | Expose one qualified contract; no transport-specific recovery implementation |

The future journal port belongs to control composition and depends only on typed
metadata. An optional storage adapter implements the port; core must not import a
database or storage runtime. No second authority machine, scheduler or executor.
`core/json-ledger` has FIFO eviction and is unsuitable for duplicate protection.

## J0: dispatch lifetime prerequisite

Current dispatch marks occur in exactly three business-operation paths:

1. `SessionAuthority.guardPage`: `act`, `navigate`, `close`. Core ActionExecutor,
   plan/autofill and RefTranslatingPage already reach this guarded page.
2. API `SessionService.createPage`: `engineSession.newPage` in controlled sessions.
3. `ApplicationAuthority.execute`: prepared write callback. Reads keep read semantics.

Add `SessionAuthority.dispatchInScope(sessionId, callback)`. It performs the
existing synchronous owner/scope/ticket check and dispatch mark, registers pending
work before invoking the callback, and invokes it immediately without an await gap.
It returns the callback's eventual result. Refusal invokes the callback zero times.
The same private task-tracking helper serves reads and writes; only writes increment
a pending-dispatch count. Do not copy promise bookkeeping into the three consumers.

If the enclosing operation exits while a dispatch is unresolved, retain its ticket
until all tracked work settles and classify the terminal record `outcome_unknown`,
even if that abandoned dispatch later succeeds. The caller did not establish a
completed operation. This rule must not taint an awaited failure that a trusted
operation handled before returning, such as an observed autofill correction.
Already-settled dropped promises cannot be distinguished from handled failures by
this counter; trusted operation callbacks still own their result classification.
Late read failures retain their existing behavior and do not retroactively fail
completed execution. Response completion closes the scope: draining is not authority
for another write. Removal/re-registration finishes only the captured old ticket.

J0 adds no wait for storage and no configurable preparation hook. Application
permission and consent ordering stays synchronous at the final dispatch boundary.
The low-level `assert(..., true)` remains for compatibility; all inventoried production
business writes migrate to the callback boundary before a journal can be enabled.

### J0 tests

- Delayed guarded write remains busy after its parent returns; another operation
  refuses, takeover drains, and the final status is unknown after success or failure.
- Awaited writes and caught/handled errors retain their existing status semantics.
- Synchronous throw and rejected promises settle tracking without unhandled rejection.
- Multiple/nested dispatches and observations share one drain; writes cannot escape
  through a closed scope, changed owner, wrong session or expired grant.
- Old work settling cannot release a replacement session's active ticket.
- Guarded page writes, page creation and application operations reach this owner;
  existing read, application consent, HTTP and takeover tests remain green.

## J1: journal transition and acknowledgment contract

Design and review the port before selecting a database. Logical operations are
reserve intent, mark dispatch, commit terminal status, and scoped historical lookup.
All transitions use compare-and-set on the expected record revision under one store
owner; duplicate acknowledgments may be retried, business effects may not.
The adapter must report a durable acknowledgment or failure/uncertainty, never a
successful memory-only fallback. Bound concurrent requests, bytes, records and waits.

Identity is an opaque store namespace plus trusted tenant, original service generation,
session incarnation, control epoch and operation ID. Compare actor and keyed canonical
fingerprint on duplicates. Include schema/key versions. An old generation record is
historical evidence, not a new grant; a new textual session ID does not revive it.
The namespace and retained identity must be established before first durable admission.

The lifecycle in durable mode is:

1. Admit through SessionAuthority and reserve the live ticket; persist intent before
   allowing a business callback. Revalidate captured authority after the await.
2. At the shared dispatch boundary persist a dispatch marker. Revalidate the captured
   entry/ticket/open scope and application-specific binding/consent pins afterward.
   Mark and invoke the effect without another await. Do not consume approval twice.
3. Drain admitted work and persist terminal status before acknowledging a durable
   terminal result. A persistence failure cannot be translated into successful durable
   completion, even when the external effect already committed.

The shared HTTP publisher now sends controlled results after execution finalization and
retains publication guards through transport completion (PR #284). Future terminal journal
ACKs must precede that publication; adding an async write to `finally` or a background drain
is insufficient. REST and CLI cannot independently invent a durable guarantee.

The implementation sequence is now split into demand-loaded packets:
[J1-A finalization/publication](t5-finalization-publication.md), then
[J1-B port and J1-C integration](t5-journal-contract.md). The first durable qualification
targets application writes only. Browser target/policy/approval checks need a separate
post-storage-wait qualification through their existing owners. HTTP/replay publication is merged through [A3c/A4b](t5-browser-review-publication.md).
The B1/B2 journal contract merged as PR #285 (`5ebf820`); runtime integration, a concrete
store and recovery remain unimplemented. See [A1 evidence](../evidence/t5-finalization.md),
[A2a evidence](../evidence/t5-session-publication.md) and
[A2b application access](../evidence/t5-application-publication.md).

| Last durable fact at process loss | Recovery classification | Effect replay |
| --- | --- | --- |
| No acknowledged intent | Not known to be accepted; receipt may be absent | Never infer permission to retry from absence |
| Intent, no dispatch marker | Recorded undispatched work | No automatic replay; later explicit revalidation only |
| Dispatch marker, no terminal record | Outcome unknown, including marker-before-effect crash | Never replay |
| External commit, terminal acknowledgment lost | Outcome unknown until independent receipt resolves it | Never replay |
| Terminal record | Historical terminal status with evidence availability separate | Never replay |

A write timeout or lost acknowledgment may mean the store committed. Quarantine that
identity until scoped lookup reconciles it; never allocate a fresh ID to conceal
ambiguity. A store failure disables new durable dispatch, while scoped diagnostic
lookup can remain available. Revocation during persistence still prevents dispatch;
a durable marker can conservatively remain unknown even when no effect ran.

## J2: optional local store and retention

Begin with one exclusively owned local SQLite adapter only after auditing the supported
Node/Bun build and distribution matrix. Select one implementation, with lazy loading;
browser-free ephemeral startup must not require it. No mandatory broker/database.
Document transaction and filesystem acknowledgment semantics, ownership fencing,
permissions, corruption/migration behavior and backup/restore generation changes.

Do not implement a TTL-only eviction cache. Accepted operation IDs and fingerprint
keys must share an explicit acceptance horizon with their tombstones. An expired
namespace rejects writes; deleting its records never makes those IDs acceptable again.
At quota exhaustion refuse new work rather than forgetting duplicate protection.
Retain old verification keys through that horizon; key loss, rotation, deletion and
restored backups must fail closed. Do not store credentials, form values, approval
tokens, resumes or entire reports in journal metadata. Encryption and keyed hashes
complement filesystem isolation; they do not grant authority.

## J3: authorized historical lookup and explicit continuation

Require current authentication and explicit authorization for the original tenant and
historical namespace. Old bearer tokens, epochs and cursors remain invalid. Return
bounded status and authorized evidence locators through existing projections; do not
restore browser sessions, callbacks, grants or submission consent from serialized state.
An undispatched record is only a candidate for a newly reviewed operation. Any resume
contract must link identities, revalidate mapping/account/payload/version and prove
that the original record was never dispatched. Browser restoration and arbitrary
automatic step replay are excluded. Receipt expiry is not proof of no external effect.

## J4: process-loss and publication gates

Use a common fault-injected port contract suite and real child-process/store tests.
Crash at every boundary in the table. Cover disk full, ambiguous write acknowledgments,
slow storage, cancellation, stale authority after each await, competing store owner,
corrupt/schema-mismatched records, key rotation/loss, retention exhaustion, namespace
reuse and tenant-crossed lookup. Reuse the existing event/cursor boundary for snapshots,
stale cursor refusal and slow subscriber behavior; do not build another event bus.

Session provisioning/seeded cookies, lifecycle teardown, spontaneous popup cleanup, artifact publication and consuming
`takeDownload` calls are not covered by J0's business-write inventory. Each must be
classified explicitly as service-owned cleanup or qualified durable work before a
capability advertises it. Artifact durability and business commitment are separate.

Publish recovery only for the qualified operation/store/runtime matrix. No exactly-once
external-effect promise. J0 alone changes no protocol schema, manifest capability,
wire status enum, release version or persisted format. T5 remains incomplete until
the journal, authorized recovery and process-loss gates pass.
