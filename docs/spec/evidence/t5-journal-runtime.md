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

## J3b: the lookup route (2026-10-15)

`GET /v1/journal/operations/{operationId}` and `GET /v1/journal`, both read-only, both accepting
the ADR-025 operator key (`actor: 'human-operator'`) **or** a tenant API key, scoped to the
credential's tenant. Delegated agent grants are refused by the /v1 hook (the routes name no
session). Keyless deployments get 401: no credential names a tenant. Rate limited per tenant
(30/min) on BOTH routes, like the policy surface. OpenAPI is regenerated; the SDK gains `journalStatus()` and
`journalOperations(id)`; the CLI gains `agentbrowser journal status` and
`agentbrowser journal operations <id>`.

- **Projection.** Each record carries only `namespace`, the `classification` vocabulary, the
  `actionable` flag, application identity and the departed session's opaque
  `sessionIncarnation`/`epoch`. Fingerprints, digests, actors, inputs and evidence content never
  cross the wire; `classifyJournalRecord` (protocol) maps the legal record states and refuses
  illegal ones.
- **Absence honesty.** `absent: true` means scoped absence in the searched (configured)
  namespace — recorded in the route description, the SDK doc and the CLI output as never proof of
  non-execution.
- **Status (D5).** `GET /v1/journal` reports configuration, namespace, health, both horizons and
  `recoveryQualified` = configured-and-open on the qualified matrix
  (`journalRuntimeQualified`: Node 24 on Linux or macOS), stated as advisory with no exactly-once
  promise.
- **Refusals.** No journal configured → 404 `JOURNAL_NOT_CONFIGURED`; a journal refusal or error
  → 503 `JOURNAL_UNAVAILABLE` with "treat the history as unread, not absent"; invalid operation
  ID → 400; over the rate limit → 429.
- **Tests.** `journal-lookup-http.test.ts` seeds each legal record state through the journal
  facade on a store the REST server then reopens (the departed-process situation): all six
  classifications including failed-after-dispatch at epoch 0 (the initial control epoch — the
  schema's epoch minimum is 0 to match), plus the actionable flag, another tenant's operation as scoped absence, the
  operator key reading the same surface, delegated-grant/keyless/bearer/invalid-ID refusals, 404
  without a journal, and the status fields against `journalRuntimeQualified()` itself. Protocol
  tests cover `classifyJournalRecord` (six legal states, four illegal) and strict schema
  validation, including that a `fingerprint` key is rejected. SDK tests cover both methods and
  operation-ID encoding.
- **Review round 1 fixes:** the status route is rate limited like the operations route (429
  pinned); `journalRuntimeQualified`'s matrix is unit-pinned (linux/darwin on Node 24 qualified;
  Node 22.13 and Windows not); a configured-but-not-open journal (passed accept horizon) answers
  503 `JOURNAL_UNAVAILABLE` "history is unread, not absent" instead of 404 — distinguishing it
  from a deployment with no journal, and giving J3d its signal.

## A2: durable restart claims (2026-10-15)

`packages/api/src/application-durable-restart.test.ts` runs two service instances — fresh
authorities and storage children, the identity mechanics of fresh OS processes; J-e's
child-process runs cover the OS-process case with SIGKILL — one after the other, on the same real
store (the second reopens the namespace J-d style). The first stops GRACEFULLY (drained shutdown,
then journal close), complementing the J-e SIGKILL table one section up. The oracles are the
store's committed rows (read-only) and per-instance effect counters.

- **Survival.** A completed durable write (rev 3) is still the store's only row after the restart,
  and the new process reads it through its own journal handle (`findByOperation`).
- **No replay.** The second process starts with zero effects and executes nothing on its own.
- **The weaker, advertised outcome.** Re-submitting the SAME operation ID under the new process
  commits a second record and runs the effect again: operation identity includes the process's
  service generation, so there is no cross-process deduplication. The test pins that the two
  records carry two distinct service generations — two operations, not a replay. Idempotency
  across restarts is the application adapter's own responsibility; the journal never claims it.

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
  enforces); `truncated` is surfaced in both responses AND the recovery window advances: the
  recovery query asks for actionable records only (`actionableOnly` on the J3a port — terminal
  records leave the SQL window), so 17 undispatched records close in two acts of 16+1 with none
  stranded, and an exhausted operation then reads as absent (404), never re-acted. Recovery
  writes keep their own per-tenant rate bucket with their own message (an API key's reads cannot
  starve the operator's writes), the store's refusal reason is surfaced on 503s, and the HTTP
  seeding harness cleans its environment, store handle and temp directory on failure paths
  (finally-verified).
- **Tests.** `journal-recovery.test.ts`: the service-level cases plus the HTTP case (operator
  closes, API key 403, an exhausted operation re-reads as 404), seeding through the journal
  facade on a store the keyed server reopens; round 2 adds mixed-state composition, the
  128-character-ID marker, settle-after-horizon, and the two-act 17-record close.
  **Not in this part:** continue with `supersedes` and the adapter `reconcile` (J3c part 2).

## J4: recovery gates for application writes (2026-10-15)

- **Non-business write classification (the design's table, now the delivered rule):**

| Write | Classification | Durable? |
| --- | --- | --- |
| Session provisioning, seeded cookies | service-owned setup; a restart ends the session | no |
| Lifecycle teardown, spontaneous popup cleanup | service-owned cleanup | no |
| Artifact publication | artifact-store durability, separate from business commitment | no |
| `takeDownload` consumption | ephemeral, per session | no |
| Application writes requesting `durable` | qualified durable work (J-d) | **yes** |

- **Events and cursors are not recovered (D4).** `journal-recovery-gates.test.ts` seeds ONE
  durable journaled write in instance A (so "no replay" is falsifiable — the journal holds
  something a wrong implementation could replay), restarts on the same real store, asserts the
  row survived (positive baseline), then asks for the departed session's events with a
  pre-restart cursor: the session no longer exists, so the request fails as session-not-found —
  never a silent reset to zero — and the row set is unchanged by the attempt (read directly from
  `journal_record`, independent of the service), with the surviving record still readable through
  the new process's journal handle. The event ledger stays per process and per session; there is
  no second event bus. Scope: the cursor-carrying REST replay path (the service-level
  `getSessionEvents` the route shares); the WS stream's 4404 close is the same D4 rule on a
  different code path and is not separately gated.
- **`recoveryQualified` (D5)** shipped with J3b's `GET /v1/journal`: configured-and-open on the
  qualified matrix (Node 24 on Linux or macOS), advisory only, no exactly-once promise. The
  macOS journal leg qualifies the runtime nightly and on journal-path pull requests; Windows
  remains unqualified.
- **R08/R10 status:** R08's application-write portion is delivered (records survive, are
  classifiable, closeable and settleable; the browser/autofill portion is explicitly B-dur and
  NOT claimed). R10's durable-application-receipt portion is delivered by J-d/J3a/J3b/J3c-part-1.

## J3c part 2: continue and reconcile (2026-10-15)

- **Continue (D2, step 3).** After close, a NEW operation under a NEW operation ID may carry the
  optional request field `supersedes: {namespace, operationId}` — on both the execute request and
  the review request (it is not limited to reviews). It is provenance metadata only: validated
  (namespace 1-128 characters, operation ID in the control pattern, no other keys) and carried
  into the reviewed action, so operator consent covers the link, but it is **never part of the
  operation identity** — the fingerprint is unchanged (pinned against the pre-durable golden), so
  the same operation without the link replays. The new operation is revalidated from scratch
  like any other: current binding, payload, expected version and consent. CLI:
  `application execute --supersedes <id> --supersedes-namespace <ns>` (both or neither).
- **What the link is NOT (review round 1).** It is not journaled, not in the receipt, response or
  trace. For a reviewed write it lives in the approval gate's (in-memory) consented action, so
  consent binds the exact link — a different link, namespace or none is refused with
  `CONTROL_REQUIRED` and nothing executes; that refusal is final for the operation ID (the link
  is not identity, so a retry replays the failure). For a **non-reviewed** write the link is
  validated and then leaves no durable trace. The server does not verify that the named
  operation exists or was closed: the link is the caller's provenance claim, which is why
  operator consent (reviewed path) is where it carries weight. Persisting it is future work
  (it needs a journal record field, i.e. a new format version).
- The link is normalized like the request itself: a plain object, exactly two own enumerable
  string data properties, no coercion, then detached into a frozen copy (nine hostile shapes
  refused before any effect; caller mutation after execute cannot reach the recorded request).
- **Reconcile (D3).** `ApplicationAdapter.reconcile(identity)` is an opt-in method; the service's
  `journalReconcileOperation` (POST `/v1/journal/operations/{operationId}/reconcile`,
  operator-only, lifecycle, own rate bucket) asks the bound adapter about each in-doubt record.
  The identity is the record's tenant, application identity, session incarnation and operation
  ID — no fingerprint or digest crosses (asserted). `committed` / `rejected` commit `completed` /
  `failed` with no evidence refs; `unknown`, or an adapter that throws, changes nothing and counts
  as unresolved (the record can still be settled). An adapter without `reconcile` refuses with
  409 `CONTROL_REQUIRED` — every adapter is resolved before any write, so the refusal never leaves
  a partial result (pinned with two records under two adapters). Undispatched siblings are left
  for close; the effect is never replayed.
- **Hardening (review round 1).** Each adapter's `reconcile` is captured once at service
  construction (a non-function `reconcile` refuses construction; replacing it later changes
  nothing). Each call is bounded (10 s by default); a call that does not settle counts as
  unresolved. The answer is read strictly — a plain object whose only own key is a data property
  `status` — so extra keys, an inherited or getter `status`, or a wrong case resolve nothing.
- **Tests.** Service level on a real store: committed, rejected, unknown, throwing adapter,
  no-reconcile refusal, API-key refusal before the adapter is asked, mixed-state composition.
  HTTP: operator 200, API key 403, resolved operation re-reads as 404, no-reconcile 409.
  `supersedes`: review-selection carry and seven malformed shapes refused; fingerprint unchanged;
  REST commit, replay without the link, four malformed shapes refused before execution; CLI
  forwarding and the both-or-neither rule.

## J3d: history namespaces (2026-10-15)

- **Configuration.** `AGENTBROWSER_JOURNAL_HISTORY_FILE` names an owner-only JSON file
  (`{"schemaVersion":1,"namespaces":[...]}`, at most 16 entries, at most 64 KiB). Each strict
  entry records EVERY descriptor input — name, `acceptUntil`, restore generation, `maxRecords`,
  and the release constants (`retainMs`, `finalizationMs`, `bounds`) as recorded, never read from
  the running release — plus the ORIGINAL key file (same rules as the current key file). The
  entry rebuilds the exact original descriptor: a test round-trips the current namespace's
  template and asserts `historyJournalNamespace(entry)` equals `serviceJournalNamespace(config)`.
  Nine malformed shapes are refused (relative path, group-readable, not JSON, unknown key, the
  current namespace, a duplicate, more than 16, a relative key file, incomplete bounds).
- **One adapter.** The store admits one server, so `openServiceJournalSet` opens the store once
  and, on that adapter, the current namespace (while its horizon has not passed) and every
  history namespace. A history namespace the store refuses is REPORTED (status
  `history[].state: "refused"` with the store's reason, plus a startup warning), never fatal to
  the current namespace. History alone (the current horizon also passed) still opens.
- **Search and recover.** One helper (`searchJournalNamespaces`) serves lookup and recovery: it
  searches every namespace, keeps each record with the journal that returned it (so close,
  settle — and reconcile — commit in the namespace that OWNS the record), holds the 16-record
  bound across namespaces, and names every namespace it could not read. A refused history entry
  is also unread. Absence is claimed only when EVERY namespace answered: lookup otherwise returns
  `absent: false` with `unreadNamespaces`, and recovery returns 503 rather than 404.
- **Never new intents.** A history namespace is past its horizon; the store refuses admission
  (pinned).
- **Deadline.** The server warns at startup for an open history namespace within 7 days of
  `retainUntil`. **Residual:** counting open records per history namespace needs a scan port
  (new port method across memory, SQLite and the child) and is not offered; the warning is by
  deadline proximity only.
- **Tests.** Config: template round-trip, nine refusals. Real store: rotation (A seeded in doubt,
  horizon passes, B current with A as history — A's record found, A refuses new intents, B does
  not see it), a wrong key reported per namespace with B unaffected, history-only startup.
  Stub journals: merge with owners and `actionableOnly` forwarded, refused/throwing/unhealthy
  namespaces named (the unhealthy one never asked), the cross-namespace page bound. HTTP:
  status lists A; lookup finds A's record tagged `ns-a`; the operator settles it and the
  terminal lands in `ns-a`; a refused entry makes lookup partial (`unreadNamespaces: ["ns-a"]`)
  and recovery 503; a history file without the journal configuration aborts startup.
- **Review round 1 fixes (J3d).**
  - *Past-horizon current namespace (HIGH).* It was neither searched nor counted unread, so a
    lookup could claim absence for an existing record. It now opens **recover-only** and is
    searched like history (status lists it), or is reported unread when the store refuses it;
    pinned over HTTP with and without a history file (lookup finds it, settle commits in it).
  - *History entries open only past their horizon.* The store CREATES a missing namespace whose
    horizon is ahead, so an early (or typo'd) entry is reported and never opened — pinned by
    asserting the store's namespace rows are unchanged.
  - *Recover-only wrapper.* History and past-horizon journals refuse `reserveIntent` and
    `markDispatch` without touching the store; recovery's own calls pass through (pinned with a
    stub).
  - *CLI/SDK.* `journal status` lists history namespaces with state and reason; `journal
    operations` names each record's namespace and any unread namespaces; the SDK types carry
    `history` and `unreadNamespaces` (CLI tests added).
  - *Close in history pinned*; the warning logic is a tested function; a runtime-unhealthy
    history handle reports `unavailable`; recovery responses name unread namespaces; a commit
    the journal does not apply now reports its kind and reason instead of claiming the record
    changed; the history file's size is checked in bytes before it is read.

## B-dur-1: the revalidation primitives (2026-10-15)

The building blocks the accepted [B-dur design](../design/t5-browser-durability.md) needs, each
tested against a change injected during the storage wait. Nothing is journaled yet: B-dur-2 wires
them into the dispatch boundary after the marker. Today's paths are unchanged (full api suite
green with no expectation changed).

- **Reserved identity (B5).** `RESERVED_BROWSER_ADAPTER_ID = 'browser'`: an application adapter
  registering it is refused with `INVALID_REQUEST` (ids that merely contain the word are fine).
- **Approval split (B6).** `checkApproval` is now `prepareApproval` + `commit`, called back to
  back, so a plain act decides and consumes exactly as before. `prepareApproval` makes the
  DECISION and throws now when the action is denied or needs an approval the request lacks (so an
  approval round trip never reaches a marker); it returns `revalidate()` (non-consuming currency:
  the lease still covers the host with an action left; the plain token or the reviewed approval
  still valid for this exact action) and `commit()` (the consumption; a stale token or approval
  is refused with a fresh `APPROVAL_REQUIRED`, a spent lease with `POLICY_DENIED`).
  `ApprovalGate.validateReviewedApproval` is the new non-consuming twin of
  `consumeReviewedApproval` (identical checks, including the snapshot refusal of a mismatched
  session).
  - Pinned: no token, an invalid or already-spent plain token, and a reviewed token still pending
    the operator's decision are each refused by `prepareApproval` itself (an approval round trip
    never reaches a marker; dropping the prepare-time validation fails these); a plain token, a
    reviewed approval and a lease each spent by a concurrent act during the wait fail both
    `revalidate` and `commit` with nothing dispatched; `revalidate` never spends. A spent lease at
    commit is `POLICY_DENIED` (fail-closed; a plain act never reaches that branch).
- **Target recheck (B6).** `ActionExecutor.revalidateTarget` re-runs `execute`'s own target checks
  after the wait with the CURRENT page revision: the revision staleness check first, then
  re-resolve the ref (engine failures mapped exactly as `execute` maps them — a crash stays
  `ENGINE_CRASHED`, no raw engine text), still visible (except `upload`) and enabled, same
  fingerprint as observed. Pinned: a revision that moved during the wait (`STALE_TARGET`, nothing
  resolved), changed element, hidden, disabled, crash parity with `execute`, the upload exemption,
  and an untargeted action (revision only).
- **Autofill recheck (B6).** `runAutofill` offers a recheck once through an optional `onRecheck`
  port. It is READ-ONLY: it never writes the run's state (scope validity, pins), so a recheck
  passing inside a dispatch can never re-authorize the raw snapshot the dispatch revoked (pinned:
  a passing recheck inside a failed dispatch leaves the snapshot uncaptured; the old
  state-writing form fails that test). With a scope it compares a fresh, complete observation
  with the preflight's pins (URL, node and block identities, readiness — resolving against a
  COPY of the block pins, so it never pins a block) and refuses before any pins exist. Without a
  scope it checks only the fields the run has already committed to (their node identity still
  present, visible and enabled); fields the run has not reached stay its own business, so a form
  that reveals fields after earlier writes is not refused. Pinned: passes on the pinned page
  without dispatching; `STALE_TARGET` for a replaced control or a recheck before preflight (the
  outcome asserted outside the run); `FORM_SCOPE_MISMATCH` when the page left the stage; unscoped,
  passing at the first dispatch while a later field is not yet revealed, and `STALE_TARGET` when
  the committed field's node is replaced during the wait.

## B-dur-2a: the browser journal in the control layer (2026-10-15)

`SessionAuthority` now runs a durable browser operation as the accepted design says, tested on the
real journal facade (`browser-journal.test.ts`). Nothing in the service uses it yet (B-dur-2b).

- **Selection (B5).** A journal selection may carry `browser: true`; it requires `durable: true`
  and the reserved `browser` application identity, and labels the intent's fingerprint
  `browser-operation:v1-durable`. Anything else is refused before any journal I/O (three shapes
  pinned). The reserved id and the domain live in `browser-journal.ts`, shared by the
  application authority (which refuses the id) and the session authority.
- **One record, many dispatches (B2).** `captureBrowserDispatchInScope(guard)` registers the
  owner's async recheck once per operation. Every page dispatch then awaits ONE shared promise —
  the marker, then the guard — so the guard runs exactly once, after the marker's storage wait,
  before the first effect; later dispatches write nothing new. Pinned: three dispatches give one
  record (rev 3, `completed`), with the order `guard (record already at rev 2) → effect 1 → 2 → 3`.
  A dispatch before the guard is captured is refused before the marker (the record stays at
  rev 2, undispatched); a second capture, and a capture outside a browser scope, are refused. No
  dispatch may run inside the guard: "inside" is the guard's own async context (its own
  `AsyncLocalStorage`), so a dispatch from the guard is refused and seals the operation instead
  of deadlocking on the guard it runs in, while the operation's OTHER dispatches issued during
  the guard's await simply wait for it and run (review finding 1; each pinned). The guard is
  awaited without its own deadline: it is the owner's recheck, bounded by the operation's own
  reads (disclosed; B-dur-2b's guards are a re-resolve, an approval read and a re-observe).
- **Reserved identity (B5, review finding 2).** A selection naming the reserved `browser`
  adapter without `browser: true` (durable or not) is refused, so no application write can be
  recorded under the browser identity even through `run()` directly; an application dispatch
  qualification cannot be captured in a browser scope.
- **Terminal mapping (B2).** A guard failure crosses no effect and seals the operation: the
  terminal is `failed` with `dispatched: true` (the marker was crossed), and the caller gets the
  guard's own typed error. A known failure the work returns (`failed()` → `rejected`) is `failed`
  with its report returned — never `JOURNAL_UNAVAILABLE`. An operation that never dispatches keeps
  its normal result and is `failed_before_dispatch` (an application write that never dispatches
  stays an error, unchanged). Pinned for each.

## B-dur-2b: durable act, plan and autofill through the service (2026-10-15)

`act`, `plan` and `autofill` accept `executionRequirement` over REST, and `durable` journals the
call as ONE browser operation. Tested on a real SQLite store through the service
(`browser-durable.test.ts`, a marker hook that changes the page during the storage wait) and over
HTTP (`browser-durable-http.test.ts`, the lookup route reading the record back).

- **The field (B1).** The HTTP wrapper peels `executionRequirement` off the body before the
  route validates it: `ephemeral` is dropped (an explicit and an omitted request share one
  identity and replay each other, pinned), `durable` is folded into the fingerprint, any other
  value is a 400. Durable on an uncontrolled session, or with no open journal, is
  `CONTROL_REQUIRED` before anything runs (pinned for all three routes). OpenAPI documents the
  field on the three bodies; the protocol body schemas the service and MCP validate are unchanged
  (B-dur-2c brings SDK, CLI and MCP parity).
- **The record (B5).** Adapter `browser`, resource `act` / `plan` / `autofill`, binding
  generation the page id; the lookup route shows it (pinned end to end).
- **act and plan (B6).** The FIRST dispatch's `beforeAction` decides the approval (a round trip
  still throws there: `failed_before_dispatch`, no marker, pinned), then captures the guard:
  `revalidateTarget` (revision, resolve, visibility, fingerprint), the approval's currency
  without consuming it, and only then its consumption. Pinned on the real store: the order is
  marker → consume → effect; a target re-rendered during the marker wait gives `STALE_TARGET`
  with no effect and a `failed`, dispatched record; a token spent during the wait gives
  `APPROVAL_REQUIRED` with no effect. Later plan steps and act-batch steps ride the same marker
  (three steps, one marker, one record, pinned). Every act kind and the act batch work durably.
- **autofill (B6).** Its guard is its own read-only stage recheck (B-dur-1's `onRecheck`), run
  once after the marker before the first field's effect. A committed field re-rendered during
  the wait gives no effect, a `failed` dispatched record, and the autofill report is returned —
  the refusal becomes a field receipt, so the work returns; the control layer keeps a returned
  report after a guard refusal (`guardRefused`, pinned at both layers) while any other seal still
  refuses. Residual, disclosed: the first field's approval or lease action is decided and spent
  before its dispatch, as for every field, so a refused marker has spent that one approval with
  no effect (fail-closed).
- **Terminal mapping (B2).** A known failure — an error response with a typed code, or a report
  with `ok: false` — is `failed` with the response returned. An unknown one — `ACTION_TIMEOUT`,
  `ENGINE_CRASHED`, `INTERNAL`, `CONTROL_REVOKED`, a plan or batch report whose failed step lost
  its result (an untyped or outcome-unknown error; the service remembers this beside the report
  object, the wire report is unchanged), or an autofill receipt `uncertain` — is
  `outcome_unknown` (classified `settled_unknown`), and **the report is still returned**: it is
  the caller's only account of what was attempted, and the record is the authority on the
  outcome. An in-doubt application write is still a refusal (unchanged). Pinned over HTTP: a plan
  whose second step lost its result is `settled_unknown` with its report; a plan whose only step
  was refused before dispatch is `failed_before_dispatch` with its report.
- **Capacity (B4)** is in the operations guide: shared with application writes, one record per
  durable call including approval round trips, no operator switch.
- **Residual (from the B-dur-2a review), disclosed.** A callback registered outside the guard
  that runs *synchronously* inside the guard's call chain (an event listener the guard's reads
  happen to fire) inherits the guard's context, so a dispatch it makes is refused and seals the
  operation. That fails closed (never an unsafe effect). The guards here are a re-resolve, an
  approval read and a re-observe; none of them fires a dispatching listener today.
