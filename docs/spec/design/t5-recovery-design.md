# T5 J-design: historical lookup (J3), recovery gates (J4) and browser-operation durability

**Status:** Accepted by the owner (2026-10-15), with D1 amended: tenant API keys may also *read*
history, while every write action stays operator-only. D2–D7 are accepted as recommended. The
implementation follows the sequence below.

It refines the J3/J4 sections of the [operation-journal design](t5-operation-journal.md). It
builds on the durable journal wired into the service by J-d (#498; evidence record
`docs/spec/evidence/t5-journal-runtime.md`).

**When implemented:** closes the application-write part of R08 and the durable portion of R10,
and narrows R08's autofill part (see D6).

**Decision points:** **D1–D7**, each with a recommendation.

## What exists, stated precisely

- **Records.** A journal record holds `schemaVersion`, `namespaceId`, its identity, `revision`,
  `intent`, `dispatched` and `terminal` (status and evidence refs).
  - The identity is: key (`serviceGeneration`, tenant, `sessionIncarnation`, epoch, operation ID),
    actor, application identity and the keyed fingerprint.
  - **There are no timestamps**, and no inputs, tokens or form values.
- **Rev 1 really means "never ran".** The dispatch marker is acknowledged before the effect is
  invoked, so a record still at rev 1 was never dispatched.
- **Lookup needs the full key.** `lookup(key)` requires the dead process's random
  `serviceGeneration` and `sessionIncarnation`, which no caller holds after a restart.
- **Keys are per process.** `SessionAuthority` builds keys only with its own process's
  `serviceGeneration`. No path today writes to another process's records.
- **The namespace is stable across restarts (J-d).** The new process acquires it through the
  store's exclusive OS lock, which also clears the dead process's fence. That lock and fence
  clearing make a single owner hold. It assumes a local filesystem, with no second server on the
  same directory; J-d refuses a second server at startup.
- **No retirement while in doubt.** A namespace retires only when every record has a terminal and
  retention has passed. An `outcome_unknown` record without a terminal therefore keeps its
  namespace, and one of the store's 64 slots, forever.
- **Receipts need a live session.** An application adapter's `receipt(scope, operationId)` needs
  a live session scope (`sessionId`, `sessionIncarnation`) and is reachable only through a bound
  session. Receipts are untyped (`unknown`), and fixtures key them differently: one by
  session incarnation, one by operation ID only.
- **Evidence refs are opaque.** The live path commits `evidenceRefIds: []`, and no durable
  evidence store resolves refs after a restart.
- **Cursors are per session.** An event cursor is a per-session `since` integer. After a restart
  an old cursor fails because its **session no longer exists**, not because of a cursor check.

## J3: historical lookup

### Who may look

**D1 (accepted, amended): reads for the operator and tenant API keys; writes for the operator only.**
- **Lookup (read-only):** the ADR-025 operator key, **or** a tenant API key, is accepted, scoped to
  the credential's tenant. This makes the surface reachable in multi-tenant keyed deployments,
  which have no operator key. Keyless deployments still get none, because no credential names a
  tenant there.
- **Writes** (D2 close and continue, D3 reconcile and settle) accept **only** the ADR-025 operator
  key, which authenticates as the principal `actor: 'human-operator'`. They change recorded
  outcomes, and settlement is irreversible.
  - **Implementation hazard:** a tenant API key authenticates as `actor: 'operator'`. A write
    check must therefore test for `human-operator` explicitly, never `operator`, and a test must
    pin that an API key is refused.
- **Delegated agent grants** (session-bound tokens) get no historical surface. Their sessions are
  gone after a restart, by design.

### What is returned

`GET /v1/journal/operations/{operationId}` (operator or tenant API key, tenant-scoped) returns a bounded set (at
most 16) of matching records across the **searched namespaces** (see D7). Each item:

| Field | Source |
| --- | --- |
| `namespace` | the namespace holding the record |
| `classification` | `undispatched` (rev 1) / `in_doubt` (rev 2, dispatched, no terminal) / `failed_before_dispatch` (rev 2, failed) / `completed`, `failed`, `settled_unknown` (rev 3) |
| `actionable` | true for `undispatched` and `in_doubt`, the only states D2/D3/settlement can still change |
| `application` | adapter, resource, binding generation |
| `session` | opaque `sessionIncarnation` and epoch (random, never a bearer) |

- **No times and no order.** Records hold no timestamps, so none are returned and the order is
  unspecified. Adding times would be a record-format change, which is out of scope.
- **Never returned:** fingerprints, inputs, evidence content or any replay capability.
- **Absence:**
  - within an open namespace: `scoped_absent`, never proof of non-execution;
  - in a namespace past `retainUntil`: `retention_expired` (its records may be deleted);
  - for a namespace not configured for search: `not_searched`.

### Port and storage

- **The query.** The raw adapter gains a fenced, read-only
  `findByOperation(tenantId, operationId, limit)`, added to the conformance suite and both
  fixtures. It returns **full identities internally**, because D2/D3 must commit against the
  exact stored identity. The route strips the fingerprint.
- **No new DDL in this slice.** The tenant and operation ID live only inside the record JSON, so
  the SQLite implementation is a bounded scan with `json_extract`, capped by `maxRecords`. An
  index would mean new columns, which the store treats as a **new `formatVersion`** (new stores
  only, no migration). That is deferred until a namespace's size makes the scan matter.

### D7: historical namespaces after rotation (new)

Recommended: opt-in history.

- **When it applies.** The current namespace becomes a history namespace once its
  `ACCEPT_UNTIL` passes: J-d then starts without it. Its records stay reachable only once the
  operator lists it here.
- **Configuration.** Each namespace an operator rotates away from can be listed in
  `AGENTBROWSER_JOURNAL_HISTORY`. Each entry records **every** descriptor input that is
  configurable or release-bound:
  - name, `ACCEPT_UNTIL`, key file, restore generation and `MAX_RECORDS`;
  - the release's descriptor constants (bounds, retention, finalization), which the entry records
    rather than reads from the running release.

  The service rebuilds the exact original descriptor from the entry and opens the namespace with
  the original key, because the key check requires it. **Old key files are retained through
  retention**, under the same rules as `AGENTBROWSER_JOURNAL_KEY_FILE` (owner-only `0600`, a file
  never a variable).
- **Access.** History namespaces are searched by lookup and writable only by D2/D3. They never
  accept a new intent: they are past their horizon.
- **Retirement.** The store retires a namespace only when all of these hold:
  - a new namespace is being created at the 64-slot ceiling;
  - the namespace is released (no live fence);
  - it is past `retainUntil`;
  - every record has a terminal.

  The entry can then be removed.
- **Deadline.** After `retainUntil`, every data write to the namespace is refused (`expired`).
  So D2, D3 and settlement must happen **within the 30 days after `ACCEPT_UNTIL`**. An `in_doubt`
  or `undispatched` record still open at `retainUntil` can never be closed, and its namespace
  never retires: it keeps one slot permanently. That is a **recorded residual**. The service
  warns about actionable records in history namespaces approaching `retainUntil`, and no forced
  tombstone is proposed.
- **Without this,** a rotation makes the old namespace's in-doubt records unreachable while they
  still occupy a store slot. That is today's J-d behaviour, recorded as a residual.

### New write path for recovery

D2 and D3 need a trusted, non-session write path. It calls the facade's `commitTerminal` with
the **full stored identity** returned by `findByOperation`, authorized only for the ADR-025
operator principal (`actor: 'human-operator'`), under the namespace fence. Nothing else gains access to another process's records.

### Closing and continuing undispatched records (D2)

**D2: only `undispatched` records, only by operator action.** Recommended. Two operator actions:
- **close**: step 2 below on its own, for intents the operator does not want to continue, so the
  namespace can retire;
- **continue**: steps 2 and 3.

1. The operator asks to close or continue a rev 1 record.
2. The recovery path commits a terminal `failed` on it: a known pre-dispatch failure, which is a
   legal rev 1 → rev 2 transition with `dispatched: false`.
   - **Why this is safe:** no live code can produce the dead process's key, and the exclusive
     store lock with fence clearing guarantees a single writer. The expected-revision check is a
     second guard.
   - **Marking it:** terminals carry only a status and evidence refs. The terminal therefore
     carries a supersession marker in the evidence-ref list, subject to the evidence-reference
     format, so that a superseded or closed intent is distinguishable from an ordinary
     pre-dispatch failure. It is a **marker only**: there is no durable evidence store, so it
     resolves to nothing (see D3).
3. Only then may the operator submit a **new** operation, under a **new** operation ID, with an
   optional request field `supersedes: {namespace, operationId}`.
   - The field is a protocol addition, so non-reviewed writes can carry the link too; it is not
     limited to reviews.
   - The new operation is revalidated from scratch: current binding, account, payload, expected
     version and consent.

### Unknown outcomes (D3)

**D3: an unknown outcome is resolved only by an adapter's typed reconciliation, never by
replay.** Recommended.

The existing `receipt()` cannot serve here: it needs a live session, it is untyped, and it is
keyed inconsistently. D3 therefore adds an **opt-in** adapter method:

```ts
reconcile(identity: {
  tenant: string;
  adapter: string;
  resource: string;
  bindingGeneration: string;
  sessionIncarnation: string;
  operationId: string;
}): Promise<{ status: 'committed' | 'rejected' | 'unknown' }>
```

- **Binding to the original operation.** The adapter answers for **that** operation only. It
  must have recorded the identity, including the session incarnation, at commit time, so a later
  operation that reused the operation ID can never satisfy it. An adapter that cannot do this
  does not implement `reconcile`, and its unknown outcomes stay unknown.
- **What gets committed.** `committed` or `rejected` commits the matching terminal (`completed`
  or `failed`). `unknown` changes nothing.
- **No evidence refs.** None are recorded, because no durable evidence store exists to resolve
  them. Durable evidence is a separate design.
- **Operator settlement.** The operator may instead **settle** an `in_doubt` record as terminal
  `outcome_unknown` (rev 3). The store accepts that only for a dispatched rev 2 record, and it
  claims nothing about the effect. It lets the namespace retire.
  - **It is irreversible:** terminals are immutable, so a settled record can never be
    reconciled. Try `reconcile` first.
  - **Likewise,** a record the live path itself ended as terminal `outcome_unknown` is
    `settled_unknown` and cannot be reconciled either.

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
- an old event cursor fails with **session not found**;
- the new process reopens the namespace.

### Events and cursors (D4)

**D4: events and cursors are not recovered.** Recommended.

The event ledger stays per process and per session. After a restart, a cursor's session is gone,
so its requests fail as session-not-found. The journal does not back events, and no second event
bus is built.

### Writes that are not business writes

| Write | Classification | Durable? |
| --- | --- | --- |
| Session provisioning, seeded cookies | service-owned setup; a restart ends the session | no |
| Lifecycle teardown, spontaneous popup cleanup | service-owned cleanup | no |
| Artifact publication | artifact-store durability, separate from business commitment | no |
| `takeDownload` consumption | ephemeral, per session | no |
| Application writes requesting `durable` | qualified durable work (J-d) | **yes** |

### Advertising recovery (D5)

**D5 (accepted): report recovery through a read-only status endpoint, for the qualified matrix.**

- Delegated agent grants get no historical surface (D1), so there is no agent capability flag.
- `GET /v1/journal` (operator or tenant API key, read-only) reports:
  - whether the journal is configured, the namespace, its health and accept horizon;
  - the searched history namespaces;
  - `recoveryQualified`, true only on the qualified matrix.
- **Qualified matrix:** application writes; the SQLite store; Node 24 (the only runtime the
  journal gates run on) on Linux, plus the macOS leg (nightly, and on journal pull requests).
- **Not qualified:**
  - Node 22.13+ is only the minimum at which the journal can start, since `node:sqlite` is
    unflagged there. It stays unqualified until a Node 22 journal leg exists.
  - Windows has no journal leg.
- There is no exactly-once promise.

## Browser-operation durability (D6)

**D6: browser operations are journaled for classification only, never recovered.** Recommended.

This **narrows** R08 rather than closing it. Records cannot hold receipt contents (no form
values), so after a restart an operator can see *that* an `autofill` or `act` was intended,
dispatched or finished, and *how* it was classified, but not its receipt.

Durable `act`, `plan` and `autofill` would get the same intent, marker and terminal records, and
**never** continuation or reconciliation: the page they acted on does not survive.

**Prerequisite: revalidation after the storage wait.** A browser action waits for the intent's
fsync before dispatching, and the page can change during that wait. After the wait and before
dispatch, these must be re-checked synchronously, as `assertDispatch` does on the application
path:
- target staleness (revision and ref identity);
- egress and target policy;
- approval-token currency.

Each owner must first expose that check. Any failure becomes `failed_before_dispatch`.

**Alternative:** do not journal browser operations; R08's autofill part stays open. Recommended
order: D6 **after** J3, reusing J3's read path.

## Sequencing (each one PR, test-first, independently reviewed)

1. **J-e:** process-loss rows through the service, plus key rotation and key loss through
   retention.
2. **J3a:** the `findByOperation` port (bounded scan), conformance, both fixtures. **Delivered
   2026-10-15** ([evidence](../evidence/t5-journal-runtime.md#j3a-findbyoperation-2026-10-15)).
3. **J3b:** the read-only lookup route for the operator or a tenant API key (D1), with REST, SDK and
   CLI parity, plus `GET /v1/journal` (D5). **Delivered 2026-10-15**
   ([evidence](../evidence/t5-journal-runtime.md#j3b-the-lookup-route-2026-10-15)).
4. **J3c:** the recovery write path; close and continue (D2) with `supersedes`; operator
   settlement; the opt-in adapter `reconcile` (D3).
5. **J3d:** history namespaces (D7) with full-descriptor entries and the retention-deadline
   warning.
6. **J4:** the classification table in the docs, the cursor-after-restart test (D4), and
   `recoveryQualified` (D5). Closes R08 for application writes and the durable part of R10.
7. **B-dur:** revalidation hooks first, then journaled browser operations (D6).

## Out of scope

- Restoring browser sessions, callbacks, grants or consent from serialized state.
- Automatic replay of any step.
- Exactly-once external effects.
- A historical surface for delegated agent grants (session-bound tokens).
- Write access to history for tenant API keys.
- Journal-backed events.
- Record timestamps or indexes (a future `formatVersion`).
- A durable evidence store.
