# T5 J-design: historical lookup (J3), recovery gates (J4) and browser-operation durability

**Status:** Proposed (2026-10-15). This is a design for the owner's sign-off; nothing here is
implemented. It refines the J3/J4 sections of the
[operation-journal design](t5-operation-journal.md) now that a durable journal is wired into the
service (J-d, #498; its evidence record is `docs/spec/evidence/t5-journal-runtime.md`).
**Closes when implemented:** R08 (restart survival of status and receipts) and the durable portion
of R10. **Decision points** are marked **D1–D6**, each with a recommendation.

## What J-d already gives us

- **The namespace is stable across restarts.** Every start reopens the same namespace from
  configuration, so the new process owns the fence over the old process's records. That is what
  makes an explicit continuation possible at all.
- **Each record holds its classification.** Intent (rev 1), dispatch marker (rev 2,
  `dispatched`), known pre-dispatch failure (rev 2, failed), terminal (rev 3).
- **Records hold only identities.** Each carries the tenant, session incarnation, epoch,
  operation ID, application adapter/resource/binding generation and a keyed fingerprint. Never
  inputs, tokens or form values.
- **No read path exists across a restart.** `lookup(key)` needs the full key, including the
  previous process's `serviceGeneration` and `sessionIncarnation`, and no caller holds those
  after a restart.

## J3: authorized historical lookup

### Who may look

**D1: operator credentials only.** Recommended.
- After a restart every agent grant, bearer epoch and cursor is invalid, by design. Historical
  lookup needs *current* authentication *and* explicit authorization for the record's tenant.
- **Recommendation:** the ADR-025 operator key, scoped to its one tenant. Agents get no
  historical surface. An agent that needs to know what happened asks its operator, who reviews.
- **Alternative:** tenant API keys. That widens a recovery surface to every automation holding a
  key; rejected for the first slice.

### What is returned

`GET /v1/journal/operations/{operationId}` (operator, tenant-scoped) returns the bounded list of
records in the configured namespace whose tenant and operation ID match. One operation ID can
appear in several sessions or epochs; at most 16 are returned, newest first. Each item carries:

| Field | Source |
| --- | --- |
| `classification` | `undispatched` / `outcome_unknown` / `failed_before_dispatch` / `completed` / `failed` / `outcome_unknown_terminal`, from the crash table |
| `application` | adapter, resource and binding generation |
| `session` | opaque `sessionIncarnation` and `epoch` (never a live session id) |
| `recordedAt` | intent and terminal times |
| `evidenceRefIds` | only those the terminal recorded, resolved through the existing evidence projections and their own authorization |

Never returned: the keyed fingerprint, the live fingerprint, inputs, approval tokens or any
replay capability. Absence is reported as `scoped_absent`, never as proof of non-execution.

**Port change (contract work, not storage work).** The raw adapter gains one bounded, read-only
query, `findByOperation(tenantId, operationId, limit)`.
- It is fenced and namespace-scoped, like every data call.
- It goes into the conformance suite and both fixtures (memory, SQLite), on the existing
  `journal_record` table with an index over the tenant and operation ID.
- `lookup(key)` is unchanged.

### Explicit continuation

**D2: continuation exists only for `undispatched` records, and only by operator action.**
Recommended.

An undispatched intent (rev 1) is a *candidate* for a new, separately reviewed operation, and
never something to resume:

1. The operator asks to continue it.
2. The service commits a terminal `failed` on the **original** record: a known pre-dispatch
   failure. This is a legal rev 1 → rev 2 (`dispatched: false`) transition. The store's
   expected-revision check makes it atomic: if anything dispatched it meanwhile, the commit
   conflicts and the continuation is refused. Terminal records carry only a status and evidence
   refs, so the supersession link lives on the new operation, not on the old record.
3. Only then may the operator submit a **new** operation under a **new** operation ID, carrying a
   `supersedes` link (namespace, original key) in its review. It is revalidated from scratch:
   current binding, account, payload, expected version and consent.

This proves the original was never dispatched and never reuses its identity. A new ID here is not
"concealing ambiguity", because step 2 removed the ambiguity first.

**D3: `outcome_unknown` resolves only through the adapter's receipt, and never by replay.**
Recommended.

For a dispatched record without a terminal, the operator may ask the service to **reconcile** it:
- the service calls the bound application adapter's existing `receipt(scope, operationId)` under
  current authorization;
- if the receipt proves `committed` or `rejected`, the service commits the matching terminal with
  the receipt as evidence;
- otherwise the record stays `outcome_unknown`.

There is no other path to a terminal, and no path to re-execution.

## J4: process-loss and publication gates

### Process loss through the service

Process-loss rows, run as J-e through the real service with the store wired:

| Crash point | Expected after restart |
| --- | --- |
| before intent | `scoped_absent` |
| after intent | `undispatched` |
| after marker, before effect | `outcome_unknown` |
| after effect, before terminal | `outcome_unknown`; the independent effect counter is exactly 1 |
| after terminal, before response | `completed` |

Each row also asserts:
- no replay;
- the old grant is refused;
- the old cursor is refused;
- the new process reopens the namespace.

### Events and cursors are not recovered

**D4: events and cursors are not recovered.** Recommended.

The event ledger stays per-process. After a restart, a cursor from the old process is refused
through the existing stale-cursor path; it is never silently reset to zero. The journal does not
back events, and no second event bus is built.

### Writes that are not business writes

The operation-journal design asks each of these to be classified before any capability
advertises it:

| Write | Classification | Durable? |
| --- | --- | --- |
| Session provisioning, seeded cookies | service-owned setup; a restart ends the session | no |
| Lifecycle teardown, spontaneous popup cleanup | service-owned cleanup | no |
| Artifact publication | artifact-store durability, separate from business commitment | no (artifact retention is its own setting) |
| `takeDownload` consumption | ephemeral, per session | no |
| Application writes requesting `durable` | qualified durable work (J-d) | **yes** |

### Advertising recovery

**D5: advertise recovery only for the qualified matrix.** Recommended.

The `recovery` capability is advertised only for application writes, on the SQLite store, on the
Node runtimes qualified by the journal gates (Linux CI, plus the macOS leg). Windows is gated
until a Windows journal leg exists. There is no exactly-once promise.

## Browser-operation durability

**D6: browser operations keep classification only: they are journaled but never recovered.**
Recommended.

Durable `act`, `plan` and `autofill` would get the same intent → marker → terminal records, and
so close R08's "synchronous autofill receipts do not survive restart". They are **never**
continued or reconciled into re-execution: the browser state they acted on does not survive a
restart.

Two requirements before shipping:

- **Post-storage-wait revalidation.** A browser action waits for the intent's fsync before
  dispatching. During that wait the page can change. After the wait and before dispatch, the
  existing owners must re-check:
  - target staleness (revision and ref identity);
  - egress and target policy;
  - approval-token currency.

  Each owner exposes a synchronous "still current" check, like the application path's
  `assertDispatch`. If any check fails, the intent becomes `failed_before_dispatch`.
- **The receipt is the record.** After a restart, the operator's lookup (J3) shows what happened.
  There is no `receipt()` equivalent for a page, so a browser `outcome_unknown` stays unknown.

**Alternative:** do not journal browser operations at all, and close R08 for application writes
only. That is simpler, but it leaves autofill receipts ephemeral. Recommendation: D6 as written,
sequenced **after** J3 ships, because it reuses J3's read path.

## Sequencing (each one PR, test-first, independently reviewed)

1. **J-e:** process-loss rows through the service, plus key rotation/loss through retention.
2. **J3a:** `findByOperation` port, conformance, SQLite index.
3. **J3b:** the operator lookup route (D1), with REST, SDK and CLI parity.
4. **J3c:** continuation of undispatched records (D2), then reconciliation through receipts (D3).
5. **J4:** the classification table above in docs, then the stale-cursor-after-restart test (D4)
   and the recovery capability for the qualified matrix (D5). Closes R08 for application writes,
   and the durable part of R10.
6. **B-dur:** browser-operation durability (D6): revalidation hooks in the target, policy and
   approval owners first, then journaled `act`, `plan` and `autofill`.

## Out of scope

Restoring browser sessions, callbacks, grants or consent from serialized state; automatic replay
of any step; exactly-once external effects; a historical surface for agents; journal-backed
events.
