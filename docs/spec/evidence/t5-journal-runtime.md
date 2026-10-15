# T5 J-d: the durable journal wired into the service (evidence)

**Date:** 2026-10-15. **Scope:** C4b runtime wiring.
**Related:**
- [T5 packet](../tasks/t5-durable-recovery.md)
- [SQLite qualification](../design/t5-journal-sqlite-qualification.md)
- [operator reconciliation](../design/t5-operator-reconciliation.md)

## What is wired

- **Configuration owner.** `packages/api/src/journal-config.ts` reads
  `AGENTBROWSER_JOURNAL_DIR`, `_ANCHOR_DIR`, `_KEY_FILE`, `_RESTORE_GENERATION` and
  `_ACCEPT_UNTIL`, plus the optional `_NAMESPACE`, `_MAX_RECORDS` and `_INITIALIZE`.
  - A partial set aborts startup, naming what is missing.
  - The key comes from a `0600` file holding one `keyId:hex` line (32–64 bytes); a group- or
    world-readable file is refused on POSIX.
  - Errors never echo key material.
- **Startup.** `buildServer` opens the qualified SQLite adapter and the configured namespace
  before the service exists.
  - Any refusal aborts startup, with no ephemeral fallback, and leaves no storage child running.
  - The journal is closed after `service.shutdown()`, and also if construction fails.
  - With a journal attached, `shutdown()` first drains in-flight **journaled** runs:
    `SessionAuthority.drain`, bounded at 30 s, refuses new journaled runs. A graceful stop
    therefore leaves no in-doubt record. Non-journaled runs are neither tracked nor refused, so
    deployments without a journal shut down exactly as before.
  - A passed accept horizon starts the server without the journal, with a warning, instead of
    refusing startup.
- **Control layer.**
  - `ApplicationAuthority` gains `durableWrites`. Only writes requesting `durable` are journaled.
  - `durable` is refused before any effect when the write cannot be journaled: the option is off,
    no journal is attached, the journal is not open, or the operation is a read.
  - The journal descriptor carries `durable: true`. The intent's live fingerprint is then labeled
    `application-operation:v2-durable`, and the label is part of the retained keyed digest.
  - This closes the J-b obligation.
- **Service.**
  - Durable is advertised in discovery, and accepted by execute, by the public review and by the
    internal submission review, only while the journal is open and its namespace still accepts
    intents. Otherwise `CONTROL_REQUIRED`.
  - **Durable operator-reviewed writes are approvable end to end.** The review selector accepts
    an optional `executionRequirement: 'durable'` and refuses any other value, and approval
    resolution rebuilds the review with it. The test generates, approves and executes once on a
    real store.
  - Gating the internal path on availability closes the J-b residual of an unapprovable pending
    durable review when no journal is open.
  - `durableJournalAvailable` is deprecated and has no effect.

## Namespace and capacity

- **The namespace is stable across restarts,** as the delivered retention design requires
  (tombstones grow with configured namespaces, not traffic). Its descriptor is derived only from
  configuration:
  - `AGENTBROWSER_JOURNAL_NAMESPACE` (default `agentbrowser`) and the key id;
  - the restore generation;
  - `AGENTBROWSER_JOURNAL_ACCEPT_UNTIL`, with retention 30 days beyond it;
  - the bounds.
- **Every start reopens the same namespace.** Records survive, which J3 needs.
- **A changed immutable value under the same name is refused by the store** (`configuration`),
  so startup aborts with a message that says to rotate by configuring a new name. A passed horizon
  aborts startup before the store starts.

| Bound | Value | Source |
| --- | ---: | --- |
| `maxRecordBytes` | 16,384 | as qualified |
| `maxInFlight` | 8 | |
| `timeoutMs` | 5,000 | as qualified |
| `maxRecords` | 10,000 by default | `AGENTBROWSER_JOURNAL_MAX_RECORDS`, up to 1,000,000 |
| `maxNamespaces` | 64 | **store-wide constant**; counts operator rotations, not starts |

A full namespace or store refuses durable work, or startup; it never evicts.

## Tests (all against the real SQLite store where named)

- `packages/control/src/application-durable-journal.test.ts` (17, three of them on `drain`: it
  refuses with its own reason, never waits for non-journaled runs, and is bounded):
  - the journal intent the facade receives is labeled `application-operation:v2-durable` for a
    durable selection and `v1` without it (captured at the facade, so the label is pinned);
  - a malformed `durable` is refused before I/O;
  - a durable write is journaled intent → dispatch → terminal around exactly one effect;
  - ephemeral writes do no journal I/O;
  - durable is refused without effect in four unavailable states and on a read.
- `packages/api/src/journal-config.test.ts` (28, three with a **real store**):
  - configuration parsing and refusals;
  - the same namespace reopened across starts, and a changed horizon refused;
  - a passed horizon refused;
  - refusal of an uninitialized store without `_INITIALIZE`.
- `packages/api/src/application-durable-journal.test.ts` (10, **real store**). The oracle is a
  read-only count of the store's `journal_record` rows:
  - durable is advertised, journaled once, and replayed without a second effect or record;
  - records survive a restart, which reopens the same namespace;
  - ephemeral leaves zero rows;
  - durable and ephemeral writes under one operation ID conflict;
  - after the journal closes, durable is no longer advertised and is refused with no effect;
  - the same happens once the accept horizon passes;
  - a graceful shutdown during a slow durable write ends with a terminal record (revision 3), and
    draining refuses new work;
  - `buildServer` starts without the journal, warning, past the horizon;
  - `buildServer` refuses a partial configuration, and closes the journal with the server so the
    next start acquires the store.
- `packages/api/src/application-submit-consent.test.ts`:
  - durable generate → approve → execute once on a real store, with one journal row; the
    selector change is pinned (the test fails without it);
  - the internal submission review refuses durable without an open journal.
- Full suites: control 808; api 1,531 passed (2 skipped); cli 321. On a heavily loaded host
  (load average ~25 from unrelated work) one real-Chromium test at a time can miss its polling
  bound. Each passes in isolation. `application-draft-parity`'s 1 s default poll is now bounded
  at 15 s.

**Recorded residuals:**
- "Refused before any effect" and "effect may have happened" share `CONTROL_REQUIRED` and differ
  only in the message. Distinguishing them is a protocol change, deferred to J4.
- The control-layer `journalOpen` check and the service execute gate are defence in depth: the
  intent reservation already refuses first, so no mutation of either changes an outcome.

## Not in this slice

- Reading records back across a restart: historical lookup is J3, and recovery semantics and
  public durability are J4. Both are proposed and await the J-design document.
- Automatic namespace rotation (today: the operator configures a new name and horizon).

## J-e: process loss through the service (2026-10-15)

`packages/api/src/journal-process-loss.test.ts` runs the compiled service in a child process,
with the real SQLite journal and an application whose effect appends to an fsynced counter file.
The child holds at each boundary of one durable write, **reads the store itself while still
alive**, reports the rows, and is then **SIGKILLed**. The parent asserts the reported rows, the
rows read again after the kill (read-only), and the counter.

| Killed | Stored record (an operator's later reading) | Effects |
| --- | --- | ---: |
| before the intent | none (`scoped_absent`) | 0 |
| after the intent, before the dispatch marker (held in `prepare`) | rev 1, not dispatched (undispatched) | 0 |
| after the dispatch marker, before the effect | rev 2, dispatched, no terminal (in doubt) | 0 |
| after the effect, before the terminal | rev 2, dispatched, no terminal (in doubt) | **1** |
| after the terminal, before the response | rev 3, `completed` | 1 |
| not killed | rev 3, `completed` | 1 |

- **Ordering is proven, not inferred.** The rows are read in-process at the hold point. The
  ordering mutation "invoke the effect before the marker commits" fails both marker rows on every
  run: 4 of 4. Reading only after the kill, the orphaned storage child sometimes flushed the
  marker in time.
- **Reopen.** After every kill, a new process (no initialize) reacquires the same namespace: the
  new storage child takes the store's exclusive lock and clears the dead owner's fence on its
  first commit. It builds the **full service with its adapters**, and the rows and effect count
  stay unchanged. That is a regression guard against any future recovery that would run at
  startup. Nothing executes today.
- **Keys.** Replacing the key material under the same key id (key loss), or keeping the material
  under a new key id for the same namespace (rotation in place), refuses startup with precisely
  `definitely_not_opened: configuration`, the key-check descriptor mismatch. No key material
  appears, and the rows are untouched. Rotation is done by configuring a new namespace.
- **Stability:** 8/8, three runs in a row.
- **Classification:** the second column is how J3 would classify each state. J3's
  classification surface is not built yet; the test asserts the raw record state.

Still not covered here (J4): a cursor from before a restart failing as session-not-found, and the
operator classification surface (J3).

## J3a: `findByOperation` (2026-10-15)

The journal port gains a bounded, read-only, fenced query:
`findByOperation({ tenantId, operationId, limit ≤ 16 })` returns
`{ kind: 'found', records, truncated }`, or `definitely_not_read` / `uncertain`. It is the read
path that J3's lookup route (J3b) and recovery writes (J3c) build on.

- **Storage.** The SQLite adapter runs a bounded scan with `json_extract` over the stored
  identity, tenant- and operation-scoped, in insertion order, reading `limit + 1` rows only to
  report truncation. There is no DDL change, because an index would be a new `formatVersion`.
  The namespace's `maxRecords` bounds the scan.
- **Facade.** It validates the query (tenant 1–256 characters, operation-ID pattern, limit 1–16)
  and refuses an invalid one before any I/O. It rejects an adapter answer that carries another
  tenant's or operation's record, or more records than the limit, as `invalid_response`.
- **Full identities.** Records keep their full identity, including the keyed fingerprint, for
  J3c's writes. The future route strips the fingerprint.
- **Envelope budget (review round 1).** A full page of 16 records at `maxRecordBytes` each
  legitimately exceeds lookup's 64 KiB single-record envelope budget (and the 1,024-node snapshot
  limit, and `canonicalJson`'s own 64 KiB output cap). The find path therefore scales all three:
  `maxRecordBytes × (limit + 1)` bytes, `64 × (limit + 1)` nodes, and a matching `canonicalJson`
  budget. A truthful 16 × ~4.4 KiB answer now validates instead of poisoning the journal; a test
  pins it (32 × 128-char evidence refs per record, the port contract's own maximum).
- **Tests.**
  - Conformance runs on the memory fixture and the in-process SQLite fixture: found across
    session incarnations and epochs, in order, excluding other tenants and operation IDs;
    truncation; no cross-namespace disclosure; fence refusal; six invalid queries refused.
  - The child-process SQLite fixture has its own find test: insertion order across three
    incarnations, truncation at limit 2, and an empty answer for another tenant, through the real
    IPC protocol.
  - **Scan cost (measured, review round 1):** through the real store function, a full-scan miss
    costs ~2.3 µs/record: 20,000 records ≈ 44 ms, 100,000 ≈ 226 ms, extrapolated 1,000,000 (the
    configuration ceiling) ≈ 2.3 s — synchronously in the single-threaded storage child, stalling
    journal reads and writes for that duration. The 10,000 default (~23 ms) is fine; at very
    large `maxRecords` the deferred `json_extract` index (a new formatVersion) starts to matter.
    Recorded for J3b's rate limit and D7.
  - The facade test uses a lying adapter.
  - The real compiled adapter and child are exercised through a durable write in the api tests.
  - Each guard was mutated away and fails a test.
  - Suites: control 834, api 1,562 (CI reports the same on the PR head); journal qualification 32/32.

## J3c part 1: close and settle (2026-10-15)

The operator-only recovery writes, on a real store, through the service and over HTTP:

- **Close (D2, first half).** The never-dispatched (rev-1) records of an operation ID commit a
  failed pre-dispatch terminal carrying the supersession marker (evidence-ref id format, always
  within its 128-character bound: the operation ID when it fits, else its SHA-256 prefix —
  deterministic per operation). **Actionability is per record:** dispatched or terminal siblings
  are left to settle/reconcile, so a mixed-state operation composes (close then settle) instead
  of deadlocking; zero eligible records is the conflict.
- **Settle (D3, operator fallback).** The in-doubt (rev-2, dispatched) records commit terminal
  `outcome_unknown` with no evidence refs, claiming nothing about the effect. IRREVERSIBLE —
  acting again on an exhausted operation refuses.
- **Operator-only, as amended (D1).** Both writes check the principal is the ADR-025
  `human-operator`; a tenant API key principal (`actor: 'operator'`) is refused with 403 — the
  design's named implementation hazard, pinned at both the service and HTTP layers. Delegated
  grants never reach the routes.
- **Tenant-honest.** The operator's tenant scopes the query; another tenant's operation is
  NOT_FOUND, never writable.
- **Routes.** POST `/v1/journal/operations/{operationId}/close|settle` (`operatorRoute`,
  lifecycle publication, rate-limited 30/min per tenant); OpenAPI regenerated (the documented
  operationId pattern matches the route's exactly); route-contract classification pinned. Service
  errors map to 400/401/403/404/409/429/503.
- **Review round 1 fixes (all pinned by new tests):** per-record actionability (mixed-state
  composition: one rev-1 + one rev-2 record closes then settles, both exhausting, no deadlock);
  the marker hashes for operation IDs longer than the evidence-ref bound (a 128-character ID
  closes, marker deterministic); the recovery gate is the OPEN journal, not the accept horizon
  (settle works after ACCEPT_UNTIL passes — the design's deadline is retainUntil, which the store
  enforces); `truncated` is surfaced in both responses (17 matching records report
  `{closed: 16, truncated: true}`); the HTTP seeding harness cleans its environment, store handle
  and temp directory on failure paths.
- **Tests.** `journal-recovery.test.ts`: five service-level cases plus the HTTP case (operator
  closes, API key 403, re-close 409), seeding through the journal facade on a store the keyed
  server reopens. **Not in this part:** continue with `supersedes` and the adapter `reconcile`
  (J3c part 2).

